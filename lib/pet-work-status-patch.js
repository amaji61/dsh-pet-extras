/**
 * dsh-pet 工作状态补丁器（按版本触发，不是每次都跑）
 *
 * ===== 为什么需要这个文件 =====
 *
 * dsh-pet 投递消息时用的 source 是 `{ kind: "user", id: "dsh-pet-<ts>" }`——
 * 跟主人手敲的消息在结构上完全一样。宿主认不出这是桌宠投的，照样发
 * turn/start、tool/call，dsh-pet 自己的 reduceWorkStatus 就报成「在干活」，
 * 头顶气泡冒出「思考中 / 工具调用」。可主人只是在跟桌宠聊天。
 *
 * 修法本身很小（在 dsh-pet 里认一下 id 前缀、把桌宠那一轮的事件吞掉），
 * 但 dsh-pet 是 npm 上的第三方包、没有 git，改了会被下一次更新整体覆盖。
 * 而 dsh-pet-extras 是本地目录，不随 npm 更新——所以把修复放这儿，
 * 由它在 dsh-pet 版本变化后重新打上去。
 *
 * ===== 为什么按版本触发，不是每次启动都跑 =====
 *
 * 每次都跑意味着每次启动都要读 dsh-pet 的 250KB 源码、算哈希、比字符串。
 * 虽然不疼，但没必要：补丁的失效原因只有「dsh-pet 换了版本」这一种。
 * 所以落一个 `{ version, at }` 到 extras 配置里，版本一致就直接返回。
 *
 * ===== 安全约束（踩过的坑都在这里） =====
 *
 * 1. 绝不写死绝对路径：dsh-pet 从 extras 自己的位置推（同一个 node_modules），
 *    推不到就安静跳过。
 * 2. 先备份再写：备份文件名固定（不带时间戳），重复打补丁不会堆一堆 .bak。
 * 3. 幂等：正文里已经有补丁标记就跳过，不会二次插入。
 * 4. 锚点失配就放弃：源码结构变了（dsh-pet 大改）就只记日志、不瞎改。
 *    宁可补丁不生效，也不能把别人的包改坏。
 * 5. 只用 node:fs / node:path，不引入依赖，不执行 dsh-pet 的任何代码。
 */
import { existsSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** 补丁正文的指纹：写进源码注释里，用来做幂等判断。改了补丁逻辑就换它。 */
const PATCH_TAG = "dsh-pet-extras/work-status-guard@1";

/** 补丁适用范围：dsh-pet 主版本号一致才打（0.x 之间源码结构可能大变）。 */
const PATCHED_SERIES = "0.";

/** 备份文件名：固定，不堆时间戳。 */
const BAK_SUFFIX = ".bak-workstatus-guard";

/**
 * dsh-pet 的安装目录：从本文件位置往上找 node_modules 里的 dsh-pet。
 *
 * 包结构是 node_modules/dsh-pet-extras/lib/patch-*.js，所以：
 *   dirname(import.meta.url)      → .../node_modules/dsh-pet-extras/lib
 *   dirname(dirname(...))         → .../node_modules/dsh-pet-extras
 *   dirname(×3)                   → .../node_modules
 * 拿到 node_modules 再拼 dsh-pet。找不到返回 null（没装 / 装在别处都不该硬来）。
 */
const resolvePetDir = () => {
	try {
		const here = dirname(fileURLToPath(import.meta.url));
		const nm = dirname(dirname(here));
		const cand = join(nm, "dsh-pet");
		return existsSync(join(cand, "package.json")) ? cand : null;
	} catch {
		return null;
	}
};

/** 读 dsh-pet 版本号（只读 package.json 文本，不 require、不执行）。 */
const readPetVersion = (petDir) => {
	try {
		const pkg = JSON.parse(readFileSync(join(petDir, "package.json"), "utf8"));
		return typeof pkg.version === "string" ? pkg.version : null;
	} catch {
		return null;
	}
};

// ===== 补丁的三段正文 =====

/** ① 识别函数：插在 PET_MSG_FENCE 定义之后。 */
const BLOCK_RECOGNIZER = `
/**
 * 【${PATCH_TAG}】这条 user/message 是不是桌宠自己投的（而非主人手敲）。
 *
 * 桌宠投递用 { kind: "user", id: "dsh-pet-<ts>" }，跟人手敲在结构上完全一样，
 * 宿主自己认不出来。唯一稳定的指纹是 id 前缀；再看一眼零宽围栏兜老版本。
 */
const isPetDeliveredMessage = (event) => {
	if (event?.type !== "user/message") return false;
	const source = event?.data?.source;
	const id = String(source?.id ?? "");
	if (id.startsWith("dsh-pet-")) return true;
	const blocks = event?.data?.content;
	if (!Array.isArray(blocks)) return false;
	const first = blocks[0];
	return typeof first?.text === "string" && first.text.startsWith(PET_MSG_FENCE);
};
`;

/** ② turn/start 分支：把原来的整块换掉（保留排队语义）。 */
const OLD_TURN_START = `\t\t\tif (type === "turn/start") {
\t\t\t\tturnFlags.set(sessionId, {
\t\t\t\t\tgoalRound: false,
\t\t\t\t\tclosing: null,
\t\t\t\t\tusedTool: false
\t\t\t\t});
\t\t\t\tworkStatus.setTask(sessionId, null);
\t\t\t\tpublishWorkStatus();
\t\t\t}`;

const NEW_TURN_START = `\t\t\tif (type === "turn/start") {
\t\t\t\t/** 【${PATCH_TAG}】保留排队中的桌宠标记：投递和 turn/start 谁先到不保证。 */
\t\t\t\tconst prev = turnFlags.get(sessionId);
\t\t\t\tconst queued = prev?.queuedPetSeqs ?? [];
\t\t\t\tconst nextPetSeq = queued.length > 0 ? Math.min(...queued) : void 0;
\t\t\t\tconst keepPet = prev?.petTurn === true || nextPetSeq !== void 0;
\t\t\t\tturnFlags.set(sessionId, keepPet ? {
\t\t\t\t\tgoalRound: false,
\t\t\t\t\tclosing: null,
\t\t\t\t\tusedTool: false,
\t\t\t\t\tpetTurn: true,
\t\t\t\t\tpetSeq: prev?.petTurn === true ? prev.petSeq : nextPetSeq,
\t\t\t\t\tawaitingTurn: true
\t\t\t\t} : {
\t\t\t\t\tgoalRound: false,
\t\t\t\t\tclosing: null,
\t\t\t\t\tusedTool: false,
\t\t\t\t\tpetTurn: false,
\t\t\t\t\tawaitingTurn: true
\t\t\t\t});
\t\t\t\tif (keepPet) {
\t\t\t\t\tworkStatus.clear(sessionId);
\t\t\t\t\tpublishWorkStatus();
\t\t\t\t\treturn;
\t\t\t\t}
\t\t\t\tworkStatus.setTask(sessionId, null);
\t\t\t\tpublishWorkStatus();
\t\t\t}`;

/** ③ 事件收口：在 user/message 分支之前插桌宠识别，在 reduceWorkStatus 之前插吞事件。 */
const ANCHOR_USER_MSG = `\t\t\tif (type === "user/message") {
\t\t\t\tconst source = event?.data?.source;
\t\t\t\tif (source?.kind === "goal") {`;

const NEW_USER_MSG = `\t\t\t/** 【${PATCH_TAG}】桌宠投递：标记这一轮不该冒工作状态。 */
\t\t\tif (isPetDeliveredMessage(event)) {
\t\t\t\tconst petSeq = Number(event.seq ?? 0);
\t\t\t\tconst flags = turnFlags.get(sessionId) ?? {
\t\t\t\t\tgoalRound: false,
\t\t\t\t\tclosing: null,
\t\t\t\t\tusedTool: false
\t\t\t\t};
\t\t\t\t/** 主人那轮还没跑完：这句是排队的，等它自己那轮真开始再标记。 */
\t\t\t\tif (flags.awaitingTurn === true) {
\t\t\t\t\tflags.queuedPetSeqs = [...(flags.queuedPetSeqs ?? []), petSeq];
\t\t\t\t\tturnFlags.set(sessionId, flags);
\t\t\t\t\treturn;
\t\t\t\t}
\t\t\t\tflags.petTurn = true;
\t\t\t\tflags.petSeq = petSeq;
\t\t\t\tturnFlags.set(sessionId, flags);
\t\t\t\tworkStatus.clear(sessionId);
\t\t\t\tpublishWorkStatus();
\t\t\t\treturn;
\t\t\t}
\t\t\tif (type === "user/message") {
\t\t\t\tconst source = event?.data?.source;
\t\t\t\t/** 【${PATCH_TAG}】主人亲手发的：清掉桌宠标记，否则他自己的任务会被吞。 */
\t\t\t\tconst flags0 = turnFlags.get(sessionId);
\t\t\t\tif (flags0?.petTurn === true) {
\t\t\t\t\tturnFlags.set(sessionId, {
\t\t\t\t\t\tgoalRound: flags0.goalRound,
\t\t\t\t\t\tclosing: flags0.closing,
\t\t\t\t\t\tusedTool: false,
\t\t\t\t\t\tpetTurn: false,
\t\t\t\t\t\tawaitingTurn: false,
\t\t\t\t\t\tqueuedPetSeqs: []
\t\t\t\t\t});
\t\t\t\t}
\t\t\t\tif (source?.kind === "goal") {`;

const ANCHOR_REDUCE = `\t\t\tconst next = reduceWorkStatus(event, turnFlags.get(sessionId));`;

const NEW_REDUCE = `\t\t\t/** 【${PATCH_TAG}】桌宠那一轮的事件：直接吞，不进工作状态。 */
\t\t\tconst liveFlags = turnFlags.get(sessionId);
\t\t\tif (liveFlags?.petTurn === true && Number(event.seq ?? 0) >= Number(liveFlags.petSeq ?? 0)) {
\t\t\t\tif (type === "turn/end") {
\t\t\t\t\tturnFlags.delete(sessionId);
\t\t\t\t\tcancelTerminalCleanup(sessionId);
\t\t\t\t\tworkStatus.clear(sessionId);
\t\t\t\t\tpublishWorkStatus();
\t\t\t\t}
\t\t\t\treturn;
\t\t\t}
\t\t\tconst next = reduceWorkStatus(event, turnFlags.get(sessionId));`;

/** ① 的插入锚点：零宽围栏常量定义之后。 */
const ANCHOR_FENCE = `const PET_MSG_FENCE = "\\u200b\\u200b\\u200b";`;

/** 锚点统一判空：CRLF 文件里 tab 数量可能一致，但行尾不同，先归一再比。 */
const normalizeEol = (s) => s.replace(/\r\n/g, "\n");

/**
 * turn/start 分支用「结构性锚点」定位，而不是整块字符串比对。
 *
 * 为什么：dsh-pet 各版本这块里的 turnFlags 初始化字段不一样（0.3.8 早期是
 * goalRound/closing，后来多了一个 usedTool）。写死整块的话，一旦它改一个字段
 * 我们就只能放弃补丁。改成「找这一行 → 花括号配对找出整块 → 整体替换」，
 * 只要这个 if 还在就能打上。
 */
const TURN_START_HEAD = `if (type === "turn/start") {`;

/** 从 head 那个 `{` 起做花括号配对，返回整块的结束下标（含 `}`）之后一位。 */
const blockEnd = (text, fromIdx) => {
	let i = text.indexOf("{", fromIdx);
	if (i < 0) return -1;
	let depth = 0;
	for (let j = i; j < text.length; j++) {
		const ch = text[j];
		if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) return j + 1;
		}
	}
	return -1;
};

/**
 * 把补丁打到 dsh-pet 的 lib/index.js 上。
 *
 * 返回 { ok, reason, version }：
 *   ok:true  → 打了（或已经是最新的）
 *   ok:false → 没打，reason 说明为什么（不抛异常，调用方只记日志）
 */
export const patchPetWorkStatus = (opts = {}) => {
	const petDir = opts.petDir ?? resolvePetDir();
	if (!petDir) return { ok: false, reason: "pet-not-found" };

	const version = readPetVersion(petDir);
	if (!version) return { ok: false, reason: "no-version" };
	if (!version.startsWith(PATCHED_SERIES)) {
		return { ok: false, reason: "series-mismatch", version };
	}

	const file = join(petDir, "lib", "index.js");
	if (!existsSync(file)) return { ok: false, reason: "no-entry", version };

	let src;
	try {
		src = readFileSync(file, "utf8");
	} catch {
		return { ok: false, reason: "read-failed", version };
	}

	// 幂等：源码里已有指纹就不动。这同时意味着「用户手动打过补丁」也会被认出来。
	if (src.includes(PATCH_TAG)) return { ok: true, reason: "already", version };

	const text = normalizeEol(src);

	// ===== 定位三段（两处纯替换 + 一处结构性替换）=====
	const fenceAt = text.indexOf(normalizeEol(ANCHOR_FENCE));
	if (fenceAt < 0) return { ok: false, reason: "anchor-miss:fence", version };

	const userMsg = normalizeEol(ANCHOR_USER_MSG);
	const userMsgAt = text.indexOf(userMsg);
	if (userMsgAt < 0) return { ok: false, reason: "anchor-miss:user-msg", version };
	if (text.split(userMsg).length - 1 !== 1) return { ok: false, reason: "anchor-dup:user-msg", version };

	const reduce = normalizeEol(ANCHOR_REDUCE);
	const reduceAt = text.indexOf(reduce);
	if (reduceAt < 0) return { ok: false, reason: "anchor-miss:reduce", version };
	if (text.split(reduce).length - 1 !== 1) return { ok: false, reason: "anchor-dup:reduce", version };

	const turnHead = text.indexOf(TURN_START_HEAD);
	if (turnHead < 0) return { ok: false, reason: "anchor-miss:turn-start", version };
	if (text.split(TURN_START_HEAD).length - 1 !== 1) {
		return { ok: false, reason: "anchor-dup:turn-start", version };
	}
	const turnEnd = blockEnd(text, turnHead);
	if (turnEnd < 0) return { ok: false, reason: "anchor-unbalanced:turn-start", version };

	// ===== 从后往前替换，避免前面的替换把后面的下标挤歪 =====
	let out = text;
	const applyAt = (start, end, repl) => {
		out = out.slice(0, start) + repl + out.slice(end);
	};
	// 三处里最靠后的是 turn-start，但 user-msg 与 reduce 谁先后要看源码；
	// 统一按「先算好各自替换点，再从大到小套用」的方式做。
	const edits = [
		{ at: fenceAt, end: fenceAt + normalizeEol(ANCHOR_FENCE).length, repl: normalizeEol(ANCHOR_FENCE) + BLOCK_RECOGNIZER },
		{ at: userMsgAt, end: userMsgAt + userMsg.length, repl: normalizeEol(NEW_USER_MSG) },
		{ at: reduceAt, end: reduceAt + reduce.length, repl: normalizeEol(NEW_REDUCE) },
		{ at: turnHead, end: turnEnd, repl: normalizeEol(NEW_TURN_START).trim() }
	].sort((a, b) => b.at - a.at);
	for (const e of edits) applyAt(e.at, e.end, e.repl);

	// 替换后必须恰好有 5 处指纹（识别函数 + turn/start + 投递 + 主人手敲 + 收口）
	const marks = out.split(PATCH_TAG).length - 1;
	if (marks !== 5) return { ok: false, reason: `mark-count:${marks}`, version };

	// 备份：只在第一次打时备份。已有备份就留着最早那份（那才是真正原始的）。
	const bak = file + BAK_SUFFIX;
	try {
		if (!existsSync(bak)) copyFileSync(file, bak);
	} catch {
		return { ok: false, reason: "backup-failed", version };
	}

	try {
		writeFileSync(file, out, "utf8");
	} catch {
		return { ok: false, reason: "write-failed", version };
	}

	return { ok: true, reason: "patched", version };
};

/**
 * 按版本触发的入口：已经为这个版本打过就立刻返回，不碰 dsh-pet 的任何文件。
 *
 * @param {object} state    上次记录 { version, at }（来自 extras 配置）
 * @param {(next:object)=>void} save  把新状态写回配置
 * @param {(msg:string)=>void} log    打日志
 */
export const ensurePetWorkStatusPatch = (state, save, log) => {
	const petDir = resolvePetDir();
	if (!petDir) return { ok: false, reason: "pet-not-found", skipped: true };
	const version = readPetVersion(petDir);
	if (!version) return { ok: false, reason: "no-version", skipped: true };

	// 版本没变：上次已经处理过（成功或明确失配），这次什么都不做。
	if (state?.version === version) {
		return { ok: true, reason: "same-version", version, skipped: true };
	}

	const result = patchPetWorkStatus({ petDir });
	if (result.ok) {
		save?.({ version, at: new Date().toISOString() });
		log?.(`dsh-pet ${version} 工作状态补丁：${result.reason === "already" ? "已存在，记下版本" : "已打上"}`);
	} else {
		// 失败也记版本：否则每次启动都会重试同一件注定失败的事，把日志刷满。
		save?.({ version, at: new Date().toISOString(), failed: result.reason });
		log?.(`dsh-pet ${version} 工作状态补丁没打上（${result.reason}）——桌宠对话时会冒出工作状态气泡`);
	}
	return result;
};
