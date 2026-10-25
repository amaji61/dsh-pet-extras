/**
 * 附件缓存自清：DSH 把投进去的图按 hash 存在 `$DSH_HOME/cache/attachments/request-images/`，
 * 只增不删——桌宠每次看屏幕都往里塞一张整屏图（300~500KB），一天能涨上百 MB。
 *
 * 2026-10-25 实测：633 个文件 / 232MB 里，**只有 28 个还被会话引用**，605 个是孤儿。
 *
 * 所以这里做一件窄事：**只删「没有任何会话引用的孤儿」**。
 *   · 会话存档里出现过这个 hash → 保留（删了那条会话的图就没了）
 *   · 没出现过 → 删（现在也取不到，纯占地方）
 *
 * 三条保守规则，宁可少删不误删：
 *   1. 只碰 request-images 目录下形如 `<64位hex>` 的文件，别的文件（含 .tmp）一概不动；
 *   2. 只删 mtime 早于 1 小时的（正在写、刚写完的、杀毒还没扫完的都躲开）；
 *   3. 读不懂的会话存档就当「可能引用过」用不了——所以任何一步异常都整体放弃这一轮。
 */
import { readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import zlib from "node:zlib";

const HASH_RE = /^[0-9a-f]{64}$/;
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
/** 刚写的图不碰：给正在跑的投递、杀毒扫描留出余量 */
const MIN_AGE_MS = 60 * 60 * 1000;

/** 把某目录（递归）里所有 .jsonl.zstd 里出现过的 hash 收进 set */
const collectHashes = (dir, out) => {
	let ents;
	try {
		ents = readdirSync(dir, { withFileTypes: true });
	} catch {
		return true;
	}
	for (const e of ents) {
		const p = join(dir, e.name);
		if (e.isDirectory()) {
			if (!collectHashes(p, out)) return false;
			continue;
		}
		if (!e.name.endsWith(".jsonl.zstd")) continue;
		let buf;
		try {
			buf = readFileSync(p);
		} catch {
			return false; // 读不到就保守放弃，别把可能被引用的图当孤儿删了
		}
		// 多帧 zstd 拼接，逐帧解（单帧解压只拿得到第一帧）
		let pos = 0;
		while (pos < buf.length) {
			const idx = buf.indexOf(ZSTD_MAGIC, pos);
			if (idx < 0) break;
			const next = buf.indexOf(ZSTD_MAGIC, idx + 4);
			const end = next < 0 ? buf.length : next;
			try {
				const text = zlib.zstdDecompressSync(buf.subarray(idx, end)).toString("utf8");
				const hits = text.match(/[0-9a-f]{64}/g);
				if (hits) for (const h of hits) out.add(h);
			} catch {
				// 单帧解不开不算错，继续下一帧
			}
			pos = end;
		}
	}
	return true;
};

/**
 * 跑一次清理。
 * @returns {{ok:boolean, reason?:string, deleted?:number, freed?:number, kept?:number}}
 */
export const sweepAttachmentCache = ({ dshHome, logger, now = Date.now() } = {}) => {
	if (!dshHome) return { ok: false, reason: "no-dsh-home" };
	const cacheDir = join(dshHome, "cache", "attachments", "request-images");
	const sessionsDir = join(dshHome, "sessions");

	let shards;
	try {
		shards = readdirSync(cacheDir, { withFileTypes: true });
	} catch {
		return { ok: false, reason: "no-cache-dir" };
	}

	// 先收集「被引用」的 hash。收集失败就整轮放弃——这时删东西风险太大。
	const referenced = new Set();
	if (!collectHashes(sessionsDir, referenced)) {
		return { ok: false, reason: "scan-sessions-failed" };
	}

	let deleted = 0;
	let freed = 0;
	let kept = 0;
	for (const shard of shards) {
		if (!shard.isDirectory()) continue;
		const shardDir = join(cacheDir, shard.name);
		let files;
		try {
			files = readdirSync(shardDir);
		} catch {
			continue;
		}
		for (const name of files) {
			if (!HASH_RE.test(name)) continue; // .tmp、别的东西一律不碰
			const full = join(shardDir, name);
			let st;
			try {
				st = statSync(full);
			} catch {
				continue;
			}
			if (!st.isFile()) continue;
			if (now - st.mtimeMs < MIN_AGE_MS) continue; // 太新，可能还在用
			if (referenced.has(name)) {
				kept++;
				continue;
			}
			try {
				rmSync(full, { force: true });
				deleted++;
				freed += st.size;
			} catch {
				// 被占用就下次再说
			}
		}
	}
	if (deleted > 0) {
		logger?.debug?.(
			`附件缓存自清：删了 ${deleted} 个孤儿（${(freed / 1048576).toFixed(1)} MB），保留 ${kept} 个仍被引用的`
		);
	}
	return { ok: true, deleted, freed, kept };
};
