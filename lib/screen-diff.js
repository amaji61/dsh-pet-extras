/**
 * screen-diff —— 本地判断「这一屏跟上次看过的那一屏，是不是同一个画面」。
 *
 * 为什么要有它：
 * 原来靠模型回一个字「没」来判断画面没变，再由插件闭嘴。但模型不会老实只回一个字，
 * 它会接成「没变。四点二十分了。」「没变化。快五点了。」——照样念出来，
 * 主人听到的就是一堆「没变」，还白花一次会话 token。
 *
 * 所以改成：投递**之前**先在本地比像素。判成同一屏就整轮跳过——
 * 不占间隔、不花 token、不出声，连图都不往会话里塞。
 *
 * 判据必须抗住这些「假变化」：
 *   - 鼠标指针动来动去、光标闪烁
 *   - 右下角时钟每秒在跳
 *   - 视频进度条一小格一小格往前爬
 *   - 弹幕滚动
 * 这些只占很小一块面积，用「变化格占比」而不是「有没有像素不同」就能滤掉。
 *
 * 反过来，切窗口、翻页、开新标签页会让大面积同时变，占比一下就上去了。
 *
 * 零依赖：复用 png-shrink.js 的 readPixels（同一套 IHDR / 反过滤逻辑）。
 */

import { readPixels } from "./png-shrink.js";

/** 把画面压成 cols×rows 的格子，每格记下平均 RGB —— 这就是一屏的「签名」。 */
export const GRID_COLS = 32;
export const GRID_ROWS = 20;

/**
 * 一格算「变了」的最小色差：|dR|+|dG|+|dB|。
 * 一格平均色差超过这个数，才认为那一小块画面真的换了内容（而不是被压缩抖动带偏）。
 */
export const CELL_DELTA = 36;

/**
 * 变化格占比超过这个数就判「换画面了」。
 * 32×20 = 640 格，5% ≈ 32 格。时钟（约 2 格）+ 光标 + 进度条加起来远到不了。
 * 数值靠 60 张真实截图校准，改之前先重跑一遍校准脚本。
 */
export const CHANGED_RATIO = 0.05;

const channelCount = (colorType) => (colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 4 ? 2 : 1);

/**
 * 算一屏的签名。
 * 返回 { ok: true, cols, rows, cells } 或 { ok: false, message }。
 * cells 是长度 cols*rows*3 的 Uint8Array（RGB），直接塞内存，不落盘。
 */
export const signatureOf = (buf) => {
	const px = readPixels(buf);
	if (!px) return { ok: false, message: "这个 PNG 解不开（位深/隔行/颜色类型不支持）" };

	const { width, height, channels, data } = px;
	const cols = Math.min(GRID_COLS, width);
	const rows = Math.min(GRID_ROWS, height);
	const cells = new Uint8Array(cols * rows * 3);

	// 每格取「格子内所有像素的平均色」。用整数累加再除，避免浮点大数组。
	for (let gy = 0; gy < rows; gy++) {
		const y0 = Math.floor((gy * height) / rows);
		const y1 = Math.max(y0 + 1, Math.floor(((gy + 1) * height) / rows));
		for (let gx = 0; gx < cols; gx++) {
			const x0 = Math.floor((gx * width) / cols);
			const x1 = Math.max(x0 + 1, Math.floor(((gx + 1) * width) / cols));
			let sr = 0;
			let sg = 0;
			let sb = 0;
			let n = 0;
			for (let y = y0; y < y1; y++) {
				let i = (y * width + x0) * channels;
				for (let x = x0; x < x1; x++) {
					if (channels >= 3) {
						sr += data[i];
						sg += data[i + 1];
						sb += data[i + 2];
					} else {
						// 灰度图：三通道都填同一个值，比出来照样有意义
						sr += data[i];
						sg += data[i];
						sb += data[i];
					}
					i += channels;
					n++;
				}
			}
			const o = (gy * cols + gx) * 3;
			cells[o] = Math.round(sr / n);
			cells[o + 1] = Math.round(sg / n);
			cells[o + 2] = Math.round(sb / n);
		}
	}
	return { ok: true, cols, rows, cells };
};

/**
 * 比两个签名，返回 { changed, ratio, cells }。
 * 尺寸不一样（换了分辨率/窗口大小）直接判「变了」，宁可多说一句。
 */
export const compareSignatures = (a, b) => {
	if (!a?.ok || !b?.ok) return { changed: true, ratio: 1, cells: 0, reason: "no-signature" };
	if (a.cols !== b.cols || a.rows !== b.rows) return { changed: true, ratio: 1, cells: 0, reason: "grid-mismatch" };

	const total = a.cols * a.rows;
	let dirty = 0;
	for (let i = 0; i < total; i++) {
		const o = i * 3;
		const d =
			Math.abs(a.cells[o] - b.cells[o]) +
			Math.abs(a.cells[o + 1] - b.cells[o + 1]) +
			Math.abs(a.cells[o + 2] - b.cells[o + 2]);
		if (d > CELL_DELTA) dirty++;
	}
	const ratio = dirty / total;
	return { changed: ratio >= CHANGED_RATIO, ratio, cells: dirty };
};
