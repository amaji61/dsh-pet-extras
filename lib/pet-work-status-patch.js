/**
 * dsh-pet 工作状态补丁器（按版本触发，不是每次都跑）
 *
 * ===== 为什么需要这个文件 =====
 *
 * 桌宠投递消息时用的 source 是 `{ kind: "user", id: "dsh-pet-<ts>" }`——
 * 跟主人手敲的消息在结构上完全一样。宿主认不出这是桌宠投的，照样发
 * turn/start、tool/call，dsh-pet 自己的 reduceWorkStatus 就报成「在干活」，
 * 头顶气泡冒出「思考中 / 工具调用」。可主人只是在跟桌宠聊天。
 *
 * 修法本身很小（在 dsh-pet 里认一下 id 前缀、把桌宠那一轮的事件吞掉），
 * 但 dsh-pet 是 npm 上的第三方包、没有 git，改了会被下一次更新整体覆盖。
 * 而 dsh-pet-extras 是本地目录，不随 npm 更新——所以把修复放这儿，
 * 由它在 dsh-pet 版本变化后重新打上去。
 *
 * ===== v2：只为「官方原版 dsh-pet」写锚点 =====
 *
 * v1 的锚点是 `const PET_MSG_FENCE = "..."`。那是**我加进 dsh-pet 的**常量，
 * 官方 0.3.8 里根本没有这个标识符——所以别人装上必然 `anchor-miss:fence`，
 * 补丁静默失效、工作状态气泡继续乱跳。v2 全部改用官方原版就存在的锚点：
 *
 *   · `const dispose = ctx.on("session/event", (session, event) => {`（全文件唯一）
 *   · `const source = event?.data?.source;`（user/message 分支内唯一）
 *   · `if (type === "turn/start") {` + 花括号配对（唯一）
 *   · `const next = reduceWorkStatus(event, turnFlags.get(sessionId));`（唯一）
 *
 * 这些都是「官方实现自己必须有」的结构，不依赖我往 dsh-pet 里塞的任何东西。
 *
 * ===== 识别口径 =====
 *
 *   dsh-pet 本体投递：kind="user"        id="dsh-pet-<ts>"
 *   本插件投图：       kind="dsh-pet-sight-image"  id="dsh-pet-extras"
 *   宿主注入：         kind="runtime-context" / "time-context" / "dsh-mnemon"
 *   主人手敲：         kind="user" 无 id，或压根没有 source
 *
 * 宿主注入不能清掉「下一轮是桌宠的」这个标记（它们会插在桌宠消息后面），
 * 只有主人真的手敲才算「换人了」。
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
const PATCH_TAG = "dsh-pet-extras/work-status-guard@2";

/** 补丁适用范围：dsh-pet 主版本号一致才打（0.x 之间源码结构可能大变）。 */
const PATCHED_SERIES = "0.";

/** 备份文件名：固定，不堆时间戳。 */
const BAK_SUFFIX = ".bak-workstatus-guard";

/** 补丁方案的「代号」。加了一段新补丁就换它——老状态里存的是旧代号，会强制重跑一次。 */
const PATCH_SCHEMA = "ws+bridge";

/**
 * dsh-pet 的安装目录：从本文件位置往上找 node_modules 里的 dsh-pet。
 *
 * 包结构是 node_modules/dsh-pet-extras/lib/patch-*.js，所以：
 *   dirname(import.meta.url)      → .../node_modules/dsh-pet-extras/lib
 *   dirname(dirname(...))         → .../node_modules
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

// ===== 锚点（全部来自官方原版 dsh-pet）=====

/** ① 声明两个集合：插在 session/event 监听器那一行之前，同一个 effect 作用域。 */
const ANCHOR_LISTENER = `const dispose = ctx.on("session/event", (session, event) => {`;

/** ② user/message 分支里取 source 的那一行。 */
const ANCHOR_USER_SRC = `const source = event?.data?.source;`;

/** ③ turn/start 分支头（用花括号配对定位整块，不依赖块内字段）。 */
const ANCHOR_TURN_START = `if (type === "turn/start") {`;

/** ④ 收口：reduceWorkStatus 那一行之前。 */
const ANCHOR_REDUCE = `const next = reduceWorkStatus(event, turnFlags.get(sessionId));`;

// ===== 补丁正文（缩进用 tab，跟 dsh-pet 源码一致）=====

/** ① 两个状态集合。petPending 记「下一轮是桌宠的」，petTurn 记「这一轮是桌宠的」。 */
const BLOCK_STATE = [
	`\t\t// ${PATCH_TAG} 桌宠轮次的标记（按 sessionId；petTurn 用 Map 存布尔）`,
	`\t\tconst petPending = new Set();`,
	`\t\tconst petTurn = new Map();`,
	``
].join("\n");

/** ② 认人：这是桌宠投的？还是主人手敲的？ */
const BLOCK_TRACK = [
	``,
	`\t\t\t\t// ${PATCH_TAG} 认投递方`,
	`\t\t\t\tconst petSrcKind = typeof source?.kind === "string" ? source.kind : "";`,
	`\t\t\t\tconst petSrcId = typeof source?.id === "string" ? source.id : "";`,
	`\t\t\t\tif (petSrcKind.startsWith("dsh-pet") || petSrcId.startsWith("dsh-pet")) {`,
	`\t\t\t\t\tpetPending.add(sessionId);`,
	`\t\t\t\t} else if (petSrcKind !== "runtime-context" && petSrcKind !== "time-context" && petSrcKind !== "dsh-mnemon") {`,
	`\t\t\t\t\tpetPending.delete(sessionId);`,
	`\t\t\t\t}`
].join("\n");

/** ③ 这一轮是谁开的：消费掉 pending 标记，落到 petTurn。 */
const BLOCK_TURN_START = [
	`\t\t\t\t// ${PATCH_TAG} 这一轮是桌宠发起的吗`,
	`\t\t\t\tpetTurn.set(sessionId, petPending.delete(sessionId));`
].join("\n");

/** ④ 收口：桌宠那一轮的事件一律不点亮工作状态。 */
const BLOCK_REDUCE = [
	`\t\t\t// ${PATCH_TAG} 桌宠主动发起的那一轮：不点亮工作状态`,
	`\t\t\tif (petTurn.get(sessionId) === true) {`,
	`\t\t\t\tif (type === "turn/end") {`,
	`\t\t\t\t\tpetTurn.delete(sessionId);`,
	`\t\t\t\t\tturnFlags.delete(sessionId);`,
	`\t\t\t\t\tworkStatus.clear(sessionId);`,
	`\t\t\t\t\tpublishWorkStatus();`,
	`\t\t\t\t}`,
	`\t\t\t\treturn;`,
	`\t\t\t}`,
	``
].join("\n");

// ===== 第二段补丁：接智能体钩子（bridge-hook@1）=====
//
// 用户 2026-10-26 的要求：「本体保持干净，接智能体归插件管」——但插件改不到
// dsh-pet 的 chatWithPet，所以聊天那条路必须在本体留一个调用点。
// 这段补丁只做两件事：加一个 bridgeChatViaExtras 函数，再在 generateChat 之前插 8 行。
// 钩子返回 null（插件没装 / 开关关着）时行为跟官方原版完全一致。

const BRIDGE_TAG = "dsh-pet-extras/bridge-hook@1";

/** ⑤ 钩子函数插在 chatWithPet 定义之前（这一段不依赖 work-status 的锚点）。 */
const ANCHOR_CHATWITH = `const chatWithPet = async (petId, text`;

/** ⑥ 调用点插在 generateChat 那一行之前。 */
const ANCHOR_GENERATE = `const generated = await generateChat(ctx, system, list, text, pool, configuredModel(found.conf, "chatModel")`;

const BLOCK_BRIDGE_FN = [
	`\t// ${BRIDGE_TAG}`,
	`\t// 把一句话交给 dsh-pet-extras 插件，让它投给接的那条会话（投递/排队/串行锁都在插件里）。`,
	`\t// 返回 null = 插件不管（没装 / 没开 / 连不上）→ 调用方照常走 generateChat；`,
	`\t// 返回 { ok:true } = 会话答了；{ ok:false } = 接线了但失败，如实报错。`,
	`\tconst bridgeChatViaExtras = async (ctx, text, images = []) => {`,
	`\t\tconst port = typeof ctx.webServer?.port === "number" ? ctx.webServer.port : 0;`,
	`\t\tif (!port || port <= 0) return null;`,
	`		// 官方 0.3.8 的 chatWithPet 没有 images 参数，补完后它可能是 undefined`,
	`\t\tconst images2 = Array.isArray(images) ? images.filter(Boolean) : [];`,
	`\t\tlet res;`,
	`\t\ttry {`,
	`\t\t\tres = await fetch(\`http://127.0.0.1:\${port}/dsh-pet-extras/agent\`, {`,
	`\t\t\t\tmethod: "POST",`,
	`\t\t\t\theaders: { "content-type": "application/json" },`,
	`\t\t\t\tbody: JSON.stringify({ text, ...(images2.length > 0 ? { images: images2 } : {}) }),`,
	`\t\t\t\tsignal: AbortSignal.timeout(120000)`,
	`\t\t\t});`,
	`\t\t} catch {`,
	`\t\t\treturn null;`,
	`\t\t}`,
	`\t\tif (!res.ok) return null;`,
	`\t\tlet body;`,
	`\t\ttry {`,
	`\t\t\tbody = await res.json();`,
	`\t\t} catch {`,
	`\t\t\treturn null;`,
	`\t\t}`,
	`\t\tif (body?.ok === false && body?.reason === "bridge-off") return null;`,
	`\t\tif (body?.ok === true) return {`,
	`\t\t\tok: true,`,
	`\t\t\ttext: String(body.text ?? ""),`,
	`\t\t\t...(Array.isArray(body.images) && body.images.length > 0 ? { images: body.images } : {}),`,
	`\t\t\tvia: "dsh-pet-extras"`,
	`\t\t};`,
	`\t\treturn {`,
	`\t\t\tok: false,`,
	`\t\t\treason: body?.reason ?? "bridge-failed",`,
	`\t\t\tmessage: String(body?.message ?? "接智能体投递失败")`,
	`\t\t};`,
	`\t};`,
	``
].join("\n");

const BLOCK_BRIDGE_CALL = [
	`\t\t// ${BRIDGE_TAG}`,
	`\t\t// 不传 images：官方 0.3.8 的 chatWithPet 签名是 (petId, text)，`,
	`\t\t// 那个作用域里没有 images 这个变量，直接写会 ReferenceError。`,
	`\t\tconst bridged = await bridgeChatViaExtras(ctx, text, []);`,
	`\t\tif (bridged !== null) {`,
	`\t\t\tif (bridged.ok) {`,
	`\t\t\t\tstate.writePet(petId, "say", bridged.image ? {`,
	`\t\t\t\t\ttext: bridged.text,`,
	`\t\t\t\t\timage: bridged.image,`,
	`\t\t\t\t\tduration: bubbleDurationMs(bridged.text)`,
	`\t\t\t\t} : {`,
	`\t\t\t\t\ttext: bridged.text,`,
	`\t\t\t\t\tduration: bubbleDurationMs(bridged.text)`,
	`\t\t\t\t});`,
	`\t\t\t}`,
	`\t\t\treturn bridged;`,
	`\t\t}`,
	``
].join("\n");

/** 锚点统一判空：CRLF 文件里 tab 数量可能一致，但行尾不同，先归一再比。 */
const normalizeEol = (s) => s.replace(/\r\n/g, "\n");

/** 从 head 那个 `{` 起做花括号配对，返回整块的结束下标（含 `}`）之后一位。 */
const blockEnd = (text, fromIdx) => {
	const i = text.indexOf("{", fromIdx);
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

/** 锚点必须唯一：返回下标，0 次 → miss，多次 → dup。 */
const findUnique = (text, anchor, label) => {
	const at = text.indexOf(anchor);
	if (at < 0) return { at: -1, reason: `anchor-miss:${label}` };
	if (text.split(anchor).length - 1 !== 1) return { at: -1, reason: `anchor-dup:${label}` };
	return { at, reason: null };
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

	// 幂等：两段补丁各自判断，缺哪段补哪段。
	// work-status 段：v2 指纹或 v1 旧指纹都算已打（v1 不重复插，避免插重）。
	const wsDone = src.includes(PATCH_TAG) || src.includes("dsh-pet-extras/work-status-guard@1");
	const bridgeDone = src.includes(BRIDGE_TAG);
	if (wsDone && bridgeDone) return { ok: true, reason: "already", version };
	if (!wsDone && !bridgeDone) return applyPetPatches(src, file, version, { workStatus: true, bridge: true });
	if (wsDone) return applyPetPatches(src, file, version, { workStatus: false, bridge: true });
	return applyPetPatches(src, file, version, { workStatus: true, bridge: false });
};

/**
 * 真正干活的：按 need 决定插哪几段，写盘前做自检。
 * need = { workStatus: bool, bridge: bool }
 * 调用方保证「至少有一段要打」（都打完就走 already 分支），所以这里必写盘。
 */
const applyPetPatches = (rawSrc, file, version, need) => {
	const text = normalizeEol(rawSrc);
	const edits = [];

	if (need.workStatus) {

		// ===== 定位四处锚点 =====
		const listener = findUnique(text, ANCHOR_LISTENER, "listener");
		if (listener.at < 0) return { ok: false, reason: listener.reason, version };

		const userSrc = findUnique(text, ANCHOR_USER_SRC, "user-src");
		if (userSrc.at < 0) return { ok: false, reason: userSrc.reason, version };

		const turnStart = findUnique(text, ANCHOR_TURN_START, "turn-start");
		if (turnStart.at < 0) return { ok: false, reason: turnStart.reason, version };
		const turnBrace = text.indexOf("{", turnStart.at);
		if (turnBrace < 0) return { ok: false, reason: "anchor-unbalanced:turn-start", version };
		const turnEnd = blockEnd(text, turnStart.at);
		if (turnEnd < 0) return { ok: false, reason: "anchor-unbalanced:turn-start", version };

		const reduce = findUnique(text, ANCHOR_REDUCE, "reduce");
		if (reduce.at < 0) return { ok: false, reason: reduce.reason, version };

		// ===== 组装编辑点（插入用 空串→正文）=====
		// 顺序无关：统一按位置从大到小套用，避免前面的插入把后面的下标挤歪。
		const listenerLineStart = text.lastIndexOf("\n", listener.at) + 1;
		const userSrcLineEnd = text.indexOf("\n", userSrc.at);
		if (userSrcLineEnd < 0) return { ok: false, reason: "anchor-unbalanced:user-src", version };
		const reduceLineStart = text.lastIndexOf("\n", reduce.at) + 1;

		const workEdits = [
			// ① 在 `const dispose = ctx.on(...)` 那一行之前插声明
			{ at: listenerLineStart, end: listenerLineStart, repl: BLOCK_STATE + "\n" },
			// ② 在 `const source = ...;` 那一行之后插认人逻辑
			{ at: userSrcLineEnd + 1, end: userSrcLineEnd + 1, repl: BLOCK_TRACK + "\n" },
			// ③ 在 turn/start 的 `{` 之后插标记（turnBrace+1 是花括号后一位）
			{ at: turnBrace + 1, end: turnBrace + 1, repl: "\n" + BLOCK_TURN_START },
			// ④ 在 reduceWorkStatus 那一行之前插收口
			{ at: reduceLineStart, end: reduceLineStart, repl: BLOCK_REDUCE }
		].sort((a, b) => b.at - a.at);
		edits.push(...workEdits);
	}

	if (need.bridge) {
		// ===== bridge 段：两个锚点，都不依赖 work-status 段 =====
		const chatWith = findUnique(text, ANCHOR_CHATWITH, "chat-with-pet");
		if (chatWith.at < 0) return { ok: false, reason: chatWith.reason, version };
		const gen = findUnique(text, ANCHOR_GENERATE, "generate-chat");
		if (gen.at < 0) return { ok: false, reason: gen.reason, version };
		const chatLineStart = text.lastIndexOf("\n", chatWith.at) + 1;
		const genLineStart = text.lastIndexOf("\n", gen.at) + 1;
		edits.push(
			{ at: chatLineStart, end: chatLineStart, repl: BLOCK_BRIDGE_FN },
			{ at: genLineStart, end: genLineStart, repl: BLOCK_BRIDGE_CALL }
		);
	}

	let out = text;
	for (const e of edits.sort((a, b) => b.at - a.at)) {
		out = out.slice(0, e.at) + e.repl + out.slice(e.end);
	}

	// 指纹自检：每段插完必须对得上（work-status 4 处、bridge 2 处）
	if (need.workStatus && out.split(PATCH_TAG).length - 1 !== 4) {
		return { ok: false, reason: `mark-count:ws=${out.split(PATCH_TAG).length - 1}`, version };
	}
	if (need.bridge && out.split(BRIDGE_TAG).length - 1 !== 2) {
		return { ok: false, reason: `mark-count:bridge=${out.split(BRIDGE_TAG).length - 1}`, version };
	}

	// 结构自检：关键代码都在
	const must = [];
	if (need.workStatus) must.push(
		"const petPending = new Set();",
		"const petTurn = new Map();",
		"petPending.add(sessionId);",
		"petTurn.set(sessionId, petPending.delete(sessionId));",
		"if (petTurn.get(sessionId) === true) {"
	);
	if (need.bridge) must.push(
		"const bridgeChatViaExtras = async (ctx, text, images = []) => {",
		"const bridged = await bridgeChatViaExtras(ctx, text, []);",
		"if (bridged !== null) {",
		"return bridged;"
	);
	for (const m of must) {
		if (!out.includes(m)) return { ok: false, reason: `self-check:${m.slice(0, 24)}`, version };
	}

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

	return { ok: true, reason: "patched", version, applied: need };
};

/**
 * 按版本触发的入口：版本没变就直接返回，变了才打。
 *
 * state/save 用的是 extras 自己的状态文件（$DSH_HOME/dsh-pet/extras-state.json），
 * 跟 dsh-pet 无关，也不会被它更新覆盖。
 */
export const ensurePetWorkStatusPatch = (state, save, log) => {
	const petDir = resolvePetDir();
	if (!petDir) {
		log?.("debug", "没找到 dsh-pet（没装就算了，工作状态守卫跳过）");
		return { ok: false, reason: "pet-not-found" };
	}

	const version = readPetVersion(petDir);
	if (!version) return { ok: false, reason: "no-version" };

	// 版本没变 → 连源码都不读
	if (state && state.version === version && state.schema === PATCH_SCHEMA && state.failed !== true) {
		return { ok: true, reason: "same-version", skipped: true, version };
	}

	const res = patchPetWorkStatus({ petDir });

	if (res.ok) {
		if (!res.skipped) {
			if (res.reason === "patched") {
				const pieces = [];
				if (res.applied?.workStatus) pieces.push("工作状态守卫");
				if (res.applied?.bridge) pieces.push("接智能体钩子");
				log?.("info", `dsh-pet ${version}：${pieces.join(" + ")}补丁已打上`);
			} else if (res.reason === "already") {
				log?.("debug", `dsh-pet ${version}：补丁已存在，跳过`);
			} else if (res.reason === "already-v1") {
				log?.("debug", `dsh-pet ${version}：检测到 v1 补丁，跳过`);
			}
		}
		try {
			save?.({ version, schema: PATCH_SCHEMA, at: new Date().toISOString(), failed: false });
		} catch {
			/* 存状态失败不影响补丁本身 */
		}
		return { ...res, version };
	}

	// 失败也记下来，免得每次启动都重读 250KB 源码、刷同一行日志
	log?.("warn", `dsh-pet ${version}：补丁没打上（${res.reason}）——工作状态气泡可能会跟着桌宠对话乱跳、聊天也走不了会话，不影响其它功能`);
	try {
		save?.({ version, schema: PATCH_SCHEMA, at: new Date().toISOString(), failed: true, reason: res.reason });
	} catch {
		/* 同上 */
	}
	return { ...res, version };
};
