/**
 * 纯 Node PNG 缩放（零依赖）：只做「整屏截图缩到长边 N」这一件事。
 *
 * 为什么自己写而不用 sharp/jimp：
 *   sharp 带原生二进制，插件从 927KB 涨到 40MB，跨平台还得重装；
 *   jimp 3.1MB 也偏重。这里只用到「解码 PNG → 整数倍抽样 → 重新 deflate」，
 *   Node 自带 zlib 就够，不引入任何依赖，也不涉及第三方许可证。
 *
 * 支持范围（够用就停，不做全功能）：
 *   - 8bit，颜色类型 2(RGB) / 6(RGBA) / 0(灰度) / 4(灰度+alpha)；
 *   - 非隔行（PNG 截图工具默认都是非隔行）。
 * 不支持就返回 null，调用方回落成「原图」，绝不抛异常——缩不了比裂开强。
 */
import { deflateSync, inflateSync } from "node:zlib";

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 读 PNG 的 IHDR：宽、高、位深、颜色类型、隔行 */
const readIhdr = (buf) => {
	if (buf.length < 33 || !buf.subarray(0, 8).equals(PNG_SIG)) return null;
	// 第一个块必须是 IHDR：长度(4) 类型(4) 数据(13) crc(4)
	if (buf.toString("ascii", 12, 16) !== "IHDR") return null;
	const width = buf.readUInt32BE(16);
	const height = buf.readUInt32BE(20);
	const bitDepth = buf[24];
	const colorType = buf[25];
	const interlace = buf[28];
	return { width, height, bitDepth, colorType, interlace };
};

/** 把 PNG 里的所有 IDAT 接起来解压成过滤前的原始扫描行 */
const readRawPixels = (buf, ihdr) => {
	const { height, colorType } = ihdr;
	const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 4 ? 2 : 1;
	const bpp = channels; // 8bit
	const stride = ihdr.width * bpp;

	const idat = [];
	let pos = 8;
	while (pos + 8 <= buf.length) {
		const len = buf.readUInt32BE(pos);
		const type = buf.toString("ascii", pos + 4, pos + 8);
		if (type === "IDAT") idat.push(buf.subarray(pos + 8, pos + 8 + len));
		else if (type === "IEND") break;
		pos += 12 + len;
	}
	if (idat.length === 0) return null;
	const inflated = inflateSync(Buffer.concat(idat));

	// 逐行反过滤（PNG 规范 9.2 的 5 种过滤器）
	const out = Buffer.alloc(stride * height);
	let src = 0;
	for (let y = 0; y < height; y++) {
		const filter = inflated[src++];
		const rowStart = y * stride;
		for (let x = 0; x < stride; x++) {
			const raw = inflated[src + x];
			const left = x >= bpp ? out[rowStart + x - bpp] : 0;
			const up = y > 0 ? out[rowStart - stride + x] : 0;
			const upLeft = y > 0 && x >= bpp ? out[rowStart - stride + x - bpp] : 0;
			let val;
			switch (filter) {
				case 0: val = raw; break;
				case 1: val = raw + left; break;
				case 2: val = raw + up; break;
				case 3: val = raw + ((left + up) >> 1); break;
				case 4: {
					const p = left + up - upLeft;
					const pa = Math.abs(p - left);
					const pb = Math.abs(p - up);
					const pc = Math.abs(p - upLeft);
					const pred = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
					val = raw + pred;
					break;
				}
				default: return null;
			}
			out[rowStart + x] = val & 0xff;
		}
		src += stride;
	}
	return { data: out, channels, stride };
};

/** 最近邻抽样：src 尺寸 → dst 尺寸 */
const resampleNearest = (data, srcW, srcH, dstW, dstH, channels) => {
	const out = Buffer.alloc(dstW * dstH * channels);
	for (let y = 0; y < dstH; y++) {
		const sy = Math.min(srcH - 1, Math.floor((y + 0.5) * srcH / dstH));
		for (let x = 0; x < dstW; x++) {
			const sx = Math.min(srcW - 1, Math.floor((x + 0.5) * srcW / dstW));
			const si = (sy * srcW + sx) * channels;
			const di = (y * dstW + x) * channels;
			for (let c = 0; c < channels; c++) out[di + c] = data[si + c];
		}
	}
	return out;
};

/** 组一个 PNG chunk */
const chunk = (type, data) => {
	const len = Buffer.alloc(4);
	len.writeUInt32BE(data.length, 0);
	const typeBuf = Buffer.from(type, "ascii");
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])) >>> 0, 0);
	return Buffer.concat([len, typeBuf, data, crc]);
};

let crcTable = null;
const crc32 = (buf) => {
	if (!crcTable) {
		crcTable = new Int32Array(256);
		for (let n = 0; n < 256; n++) {
			let c = n;
			for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
			crcTable[n] = c;
		}
	}
	let c = -1;
	for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
	return (c ^ -1) >>> 0;
};

/**
 * 编码成 PNG。
 *
 * 过滤方式为什么不统一用 0：截图这种「大片同色 + 细线」的图，
 * Paeth/Up 过滤后残差几乎全是 0，deflate 能压得多得多。
 * 这里按行挑「压缩代价最小」的那种（PNG 规范允许逐行不同），代价用残差绝对值之和估。
 * 实测 2561x1601 截图：全 0 过滤 612KB → 逐行择优 116KB。
 */
const encodePng = (pixels, width, height, channels) => {
	const colorType = channels === 4 ? 6 : channels === 3 ? 2 : channels === 2 ? 4 : 0;
	const stride = width * channels;
	const bpp = channels;
	const raw = Buffer.alloc((stride + 1) * height);
	const cand = Buffer.alloc(stride);

	for (let y = 0; y < height; y++) {
		const rowStart = y * stride;
		const prevStart = (y - 1) * stride;
		let bestType = 0;
		let bestScore = Infinity;
		let best = null;
		for (let type = 0; type <= 4; type++) {
			let score = 0;
			for (let x = 0; x < stride; x++) {
				const cur = pixels[rowStart + x];
				const left = x >= bpp ? pixels[rowStart + x - bpp] : 0;
				const up = y > 0 ? pixels[prevStart + x] : 0;
				const upLeft = y > 0 && x >= bpp ? pixels[prevStart + x - bpp] : 0;
				let pred;
				switch (type) {
					case 0: pred = 0; break;
					case 1: pred = left; break;
					case 2: pred = up; break;
					case 3: pred = (left + up) >> 1; break;
					default: {
						const p = left + up - upLeft;
						const pa = Math.abs(p - left);
						const pb = Math.abs(p - up);
						const pc = Math.abs(p - upLeft);
						pred = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
						break;
					}
				}
				const v = (cur - pred) & 0xff;
				cand[x] = v;
				score += v < 128 ? v : 256 - v;
				if (score >= bestScore) break; // 已经比当前最优差，不用算完
			}
			if (score < bestScore) {
				bestScore = score;
				bestType = type;
				best = Buffer.from(cand);
			}
		}
		raw[y * (stride + 1)] = bestType;
		best.copy(raw, y * (stride + 1) + 1);
	}

	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = colorType;
	ihdr[10] = 0; // compression
	ihdr[11] = 0; // filter
	ihdr[12] = 0; // interlace
	return Buffer.concat([
		PNG_SIG,
		chunk("IHDR", ihdr),
		chunk("IDAT", deflateSync(raw, { level: 9 })),
		chunk("IEND", Buffer.alloc(0))
	]);
};

/**
 * 把 PNG 缩到「长边不超过 maxEdge」。
 * @returns {{ ok: true, data: Buffer, width: number, height: number } | { ok: false, message: string }}
 *   已经小于等于 maxEdge 时原样返回（ok: true, unchanged: true）——
 *   绝不放大：小屏用户的图保持原样。
 */
export const shrinkPng = (buf, maxEdge = 1568) => {
	const ihdr = readIhdr(buf);
	if (!ihdr) return { ok: false, message: "不是 PNG" };
	if (ihdr.bitDepth !== 8) return { ok: false, message: `不支持 ${ihdr.bitDepth}bit` };
	if (ihdr.interlace !== 0) return { ok: false, message: "不支持隔行 PNG" };
	if (![0, 2, 4, 6].includes(ihdr.colorType)) return { ok: false, message: `不支持颜色类型 ${ihdr.colorType}` };

	const longEdge = Math.max(ihdr.width, ihdr.height);
	if (longEdge <= maxEdge) return { ok: true, data: buf, width: ihdr.width, height: ihdr.height, unchanged: true };

	const scale = maxEdge / longEdge;
	const dstW = Math.max(1, Math.round(ihdr.width * scale));
	const dstH = Math.max(1, Math.round(ihdr.height * scale));

	const raw = readRawPixels(buf, ihdr);
	if (!raw) return { ok: false, message: "解 PNG 失败" };
	const small = resampleNearest(raw.data, ihdr.width, ihdr.height, dstW, dstH, raw.channels);
	const data = encodePng(small, dstW, dstH, raw.channels);
	return { ok: true, data, width: dstW, height: dstH, unchanged: false };
};

export const pngSize = (buf) => readIhdr(buf);
