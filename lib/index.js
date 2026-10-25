/**
 * dsh-pet-extras —— 桌宠扩展（宿主半侧）
 *
 * 把两样「外挂能力」从 dsh-pet 本体里拆出来，做成能独立上架的插件：
 *   1) 定时截屏 + 定时看图：桌面 Helper 用 desktopCapturer 抓主屏只落盘，
 *      再把最新一张交给模型看一眼，结论写进桌宠记忆。
 *   2) 接智能体：把桌宠说的话投递给主会话，用主会话的回答当桌宠的回答。
 *
 * 设计约束（改代码前先读）：
 *   - **绝不写死绝对路径**。所有路径都走 dshHomeDir()（环境变量 DSH_HOME 优先），
 *     或相对本包自身目录解析，这样别人装到别的盘也能用。
 *   - **不 import dsh-pet 的内部模块**。只用 DSH 公开服务（webServer / attachments /
 *     agentDefaultModel / agents / llm），也只用 dsh-pet 的公开 HTTP 接口和落盘格式，
 *     它不在的时候就安静降级。
 *   - 与 dsh-pet 的耦合点只有三个：气泡（POST 它原版的 /broadcast 与 /anim）、记忆
 *     （读写同一个 memory.json）、落盘目录（同一个 dsh-pet/ 子目录）。
 */

import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { shrinkPng } from "./png-shrink.js";
import { ensurePetWorkStatusPatch } from "./pet-work-status-patch.js";
import { sweepAttachmentCache } from "./attachment-sweep.js";

export const name = "dsh-pet-extras";

/**
 * 声明必须等这些服务就位；缺任何一个插件都不会 apply。
 *
 * `agents` 一定要写进来：Cordis 的 ctx 是代理，没在 inject 里声明的服务
 * 一读就抛 `cannot get property "agents" without inject`——这个坑踩过两次
 * （上一次是 attachments）。
 */
export const inject = ["webServer", "attachments", "agentDefaultModel", "agents", "llm"];

/** 路由前缀：与 dsh-pet 的 /dsh-pet-7340 分开，互不干扰。 */
const ROUTE_PREFIX = "/dsh-pet-extras";

/**
 * 截图保留张数：从配置读，夹到 1~2000。
 * （以前是写死的 SHOT_KEEP 常量，用户改不了——想多留几天或省点磁盘都做不到。）
 */
const shotKeep = () => Math.max(1, Math.min(2000, Number(readConfig().screenshotKeep) || 60));

/** 投递后等主会话空闲 / 等这一轮回复的上限（毫秒）。 */
const QUEUE_WAIT_MS = 900000;
const TURN_TIMEOUT_MS = 900000;
const POLL_MS = 400;
/**
 * 持锁等主会话空出来的上限。
 *
 * 和 QUEUE_WAIT_MS 分开是有原因的：投递之后等回复可以慢慢等（那是模型在干活），
 * 但**排队阶段**不能让后面的人跟着一起等——主会话一忙，后面每个请求都得等前面那个，
 * 90 秒还没排到就直接告诉调用方「忙，稍后再来」，比无声卡住好得多。
 */
const IDLE_WAIT_MS = 90000;

/** 桌宠自己曾建过的 agent 前缀（老版本遗留，挑主会话时排除）。 */
const PET_AGENT_PREFIX = "dsh-pet-chat-";

/**
 * 桌宠刚投递、还没等到回复的**静态**标志。
 *
 * 为什么不能只看 `status === "idle"`：投递用 followup 落进 inbox，宿主什么时候把它
 * 变成一轮、status 什么时候翻成 running，中间有个空档。看图（25 秒一轮）撞上这个
 * 空档就会以为「还没开始干活」，结果是等到上一轮结束就带着上一轮的文字交差——
 * 用户看到的就是「投了一张图，回来一句跟画面无关的话」。
 *
 * 所以投递前先立旗，收到回复（或明确失败/超时）才放旗。
 */
let petTurnPending = false;

/**
 * 投递给主会话的每条消息前面挂的零宽围栏（U+200B 重复三次）。
 *
 * 作用只有一个：让「桌宠说的话」在会话日志里能被自己认出来——
 * 扫回复时只取紧跟在这条带围栏的消息之后那一段，主人在界面里自己聊出来的
 * assistant 回复不会被误当成桌宠的回答。
 * 用零宽字符而不是可见标记，是因为它在界面上看不见，不会弄脏对话。
 */
const PET_MSG_FENCE = "\u200b\u200b\u200b";

/** 跨请求的串行锁：同一会话上，桌宠的请求一单一单来。 */
const turnLocks = new Map();

/**
 * DSH 数据目录。
 *
 * 与 DSH 自己的约定一致：环境变量 DSH_HOME 优先，否则 ~/.dsh。
 * 不用 ctx 里的内部助手——那些不是公开契约，换版本就断。
 */
const dshHomeDir = () => process.env.DSH_HOME || join(homedir(), ".dsh");

/** 桌宠的用户数据目录（与 dsh-pet 落盘位置一致，所以能共用 memory.json）。 */
const petHomeDir = () => join(dshHomeDir(), "dsh-pet");

/** 截屏落盘目录：首次用到才建，纯浏览器用户不会留下空目录。 */
const screenshotsDir = () => {
	const dir = join(petHomeDir(), "screenshots");
	try {
		mkdirSync(dir, { recursive: true });
	} catch {}
	return dir;
};

/** dsh-pet 的对话记忆文件。 */
const memoryPath = () => join(petHomeDir(), "memory.json");

/** 插件自己的日志文件（超过 2MB 就重置）。 */
const logPath = () => join(petHomeDir(), "extras.log");

const logTo = (level, msg) => {
	const line = `${new Date().toISOString()} [${level}] ${msg}\n`;
	try {
		const file = logPath();
		mkdirSync(dirname(file), { recursive: true });
		if (existsSync(file) && fstatSync(openSync(file, "r")).size > 2 * 1024 * 1024) writeFileSync(file, "");
		appendFileSync(file, line);
	} catch {}
	const sink = level === "error" ? console.error : level === "warn" ? console.warn : console.debug;
	sink(`[dsh-pet-extras] ${msg}`);
};

const logger = {
	debug: (m) => logTo("debug", String(m)),
	info: (m) => logTo("info", String(m)),
	warn: (m) => logTo("warn", String(m)),
	error: (m) => logTo("error", String(m))
};

/**
 * ===== 本插件的配置 =====
 *
 * 配置放自己这一份（$DSH_HOME/dsh-pet/extras-config.json），不往 dsh-pet 的配置树里塞——
 * 那边有严格的字段白名单（GLOBAL_DEFAULT_KEYS + assets/config.jsonc），
 * 认不出的键会被 saveUserConfig 静默丢掉。放自己的文件反而干净、也不怕它升级覆盖。
 * 每次都读盘：设置页改完存一次就生效，不需要重启。
 */
const configPath = () => join(petHomeDir(), "extras-config.json");

const DEFAULT_CONFIG = {
	/**
	 * 「看屏幕」总开关（只有桌面模式有用）。
	 *
	 * 2026-10-24 合并：以前分成「定时截屏」+「定时看图」两个开关，用户分不清该开哪个
	 * （只开截屏 = 存了没人看，只开看图 = 没图可看）。现在一个开关管到底：
	 * 开 = 定时截屏 + 每张都交给主会话，关 = 全停。
	 * 代价是失去「只截屏存档、不投给会话」这个用法——用户明确选了这一条。
	 */
	screenshotEnabled: false,
	/** 截屏间隔秒数（最小 5） */
	screenshotIntervalSec: 20,
	/** 把桌宠的话投递给主会话 */
	agentBridgeEnabled: false,
	/** 固定接哪条会话的**标题**（旧字段，保留兼容）；空 = 用 targetSessionId */
	agentBridgeTarget: "",
	/**
	 * 固定接哪条会话的**精确 id**。这是唯一权威目标。
	 *
	 * 为什么空的时候不「自动挑一条」：2026-10-25 别人实测时，自动挑挑了消息最多的
	 * 那条不相干会话（一个游戏开发会话），截图每小时往里面投 60 张。宁可什么都不投、
	 * 等主人自己选，也不能猜。空 = 不投（截屏进程也会停，不烧 token）。
	 */
	targetSessionId: "",
	/**
	 * 把桌宠限制在屏幕内（true = 拖不出屏、漫游不出界）。
	 *
	 * dsh-pet 自己也有同名配置（confineToScreen），但它的设置页只是个复选框，
	 * 用户分不清「没生效」和「没开」。这里给插件一份独立开关 + 显式下发，
	 * 谁最后写谁算——所以下发前先读它的当前值，只有不一致才写，避免来回打架。
	 */
	confineToScreen: true,
	/**
	 * 截图文件保留张数（1~2000）。
	 *
	 * 以前写死 60（SHOT_KEEP 常量），用户想留长一点或省点磁盘都没法调。
	 * 截图会一直堆，不收就涨满硬盘，收太多又查不到昨天的，所以做成旋钮。
	 */
	screenshotKeep: 60,
	/**
	 * 允许看图播报自学习（默认关）。
	 *
	 * 学什么：只复盘**视野档案**里自己和主人说过的话，总结「哪句像说明书、哪句像人话」，
	 * 写回 `look-rules.txt`。不联网、不读外部语料——这一点写进代码而不是写进文档，是怕哪天被改掉。
	 *
	 * 为什么默认关：每跑一次要额外的模型调用（花钱），而且学歪了不容易马上发现。
	 */
	lookLearnEnabled: false,
	/** 学出来的规则最多多少字（超过就拒绝写入，防止反复「学习」把提示词撑爆、性格跑偏） */
	lookRulesMaxChars: 1200,
	/**
	 * 两次投图之间最短间隔秒数（防止画面一直在动就一张接一张地投，把上下文撑爆）。
	 *
	 * 一张整屏缩到长边 1568 后约 500KB ≈ 1024 token，60 秒一张盯一天最坏 1400 多张。
	 *
	 * 「要不要看屏幕」这个总闸就是 `screenshotEnabled`（合并后只剩这一个）：
	 * 开了就是看 + 投（要播报却不带图，主会话只会凭空编），所以这里没有「投图开关」，
	 * 也没有给看图单独配人设的入口——人设就是那条会话的人设。
	 */
	sightShareMinGap: 60
};

const readConfig = () => {
	try {
		const raw = JSON.parse(readFileSync(configPath(), "utf8"));
		return { ...DEFAULT_CONFIG, ...(raw && typeof raw === "object" ? raw : {}) };
	} catch {
		return { ...DEFAULT_CONFIG };
	}
};

/**
 * 把已经废弃的键从配置文件里擦掉（老版本写过，新版本已经不读）。
 *
 * 为什么要擦：留着的话，读配置的人会以为「这儿还有个开关能关」，
 * 文档、设置页、用户的理解三边对不上。擦的时候只动这几个已知键，别的一概不碰。
 */
const LEGACY_CONFIG_KEYS = ["sightShareEnabled", "sightingInject", "sightingKeep", "lookPersonaOwner", "screenshotWatchEnabled"];

const scrubConfig = (conf) => {
	let dirty = false;
	const next = { ...conf };
	for (const k of LEGACY_CONFIG_KEYS) {
		if (k in next) {
			delete next[k];
			dirty = true;
		}
	}
	if (!dirty) return next;
	try {
		writeFileSync(configPath(), JSON.stringify(next, null, 2), "utf8");
	} catch (e) {
		logger.warn("清理旧配置失败：" + (e instanceof Error ? e.message : String(e)));
	}
	return next;
};

const writeConfig = (patch) => {
	const next = { ...readConfig() };
	for (const [k, v] of Object.entries(patch ?? {})) {
		if (k in DEFAULT_CONFIG && v !== void 0) next[k] = v;
	}
	try {
		mkdirSync(petHomeDir(), { recursive: true });
		writeFileSync(configPath(), JSON.stringify(next, null, 2), "utf8");
	} catch (e) {
		logger.warn("写配置失败：" + (e instanceof Error ? e.message : String(e)));
	}
	return next;
};

/**
 * 配置来源：**唯一真相是本插件自己的 extras-config.json**，一个键都不从 dsh-pet 里读。
 *
 * 为什么改（2026-10-25，移植性事故，血泪）：
 * 早先这些开关读的是 dsh-pet 配置里的 `screenshotEnabled` / `agentBridgeEnabled` /
 * `agentBridgeTarget`。那三个键是开发时手动加进 dsh-pet 的 assets/config.jsonc 的，
 * **官方 0.3.8 内置配置里根本不存在**。而 dsh-pet 的 mergeEntry 只遍历内置配置的键
 * （`for (const key of Object.keys(base))`），用户文件里多写的键会被静默丢掉。
 * 结果：干净安装上这几个值永远是 false，插件一直「关着」，一张图都不截。
 * 我是因为自己动手改过 dsh-pet 才没发现——样本被污染，这个教训写在这里防复发。
 *
 * 现在：插件自己的配置说了算，dsh-pet 里有没有这些键完全无关；
 * 设置页也只读写 /dsh-pet-extras/config，不再和 dsh-pet 的设置页互相覆盖。
 */
const petConfSnapshot = () => readConfig();

/** 兼容旧调用点：过去要 HTTP 拉 dsh-pet 配置，现在同步读自己的配置文件。 */
const refreshPetConf = async (_ctx) => readConfig();

/**
 * 当前生效的截屏设置。
 *
 * `fresh` 参数交给「刚刚自己 await 过 refreshPetConf」的调用方：
 * 走过 refreshPetConf 之后，缓存一定是最新的，不必再让 TTL 拦一道。
 * （曾经这里无条件读缓存，refresh 后 3 秒内的第二次读仍拿旧值，
 *   导致 helper 带着 enabled=0 起来、勾了定时截屏却不出图。）
 *
 * 2026-10-24：截屏间隔不再是独立旋钮，**跟着 `sightShareMinGap` 走**。
 * 合并成一个「看屏幕」开关后，节奏只有一个：每隔 N 秒截一张、交一张。
 * 以前是「截屏间隔 SEC」+「投图最短间隔 60」两个数互相卡——设 30 截、卡 60 投，
 * 用户看到 30 却按 60 走，纯属误导。最小的 5 秒下限仍然保留。
 */
const screenshotSettings = () => {
	const local = readConfig();
	const raw = Number(local.sightShareMinGap);
	const gap = Number.isFinite(raw) && raw > 0 ? Math.max(1, Math.floor(raw)) : 60;
	return {
		enabled: local.screenshotEnabled === true,
		intervalSec: Math.max(5, gap)
	};
};

/**
 * ===== 和 dsh-pet 的弱耦合点 =====
 *
 * 两样能力都要「落到某只桌宠身上」：气泡、记忆。这里不 import 它的模块，
 * 而是按它公开的 HTTP 接口与落盘格式来用；它没装 / 没接口时安静降级。
 */
let petBaseUrl = null;

/** dsh-pet 的 HTTP 入口（同进程内自己调自己）。拿不到就返回 null。 */
const resolvePetBase = (ctx) => {
	if (petBaseUrl) return petBaseUrl;
	// 候选端口：webServer 的真实端口 + 我们自己监听的端口（webServer.address() 在某些
	// 宿主形态下返回的是内部对象而不是 node 的 AddressInfo，踩过一次——那时 readPetConfig
	// 直接拿到 null，接口表现成「pet-unavailable」，实际上桌上的桌宠好好的）。
	const ports = [];
	try {
		const address = typeof ctx.webServer?.address === "function" ? ctx.webServer.address() : void 0;
		if (address && typeof address === "object" && address.port) ports.push(Number(address.port));
	} catch {}
	try {
		const server = ctx.webServer?.server ?? ctx.webServer;
		const addr = typeof server?.address === "function" ? server.address() : null;
		if (addr && typeof addr === "object" && addr.port) ports.push(Number(addr.port));
	} catch {}
	for (const port of ports) {
		if (!Number.isFinite(port) || port <= 0) continue;
		petBaseUrl = `http://127.0.0.1:${port}`;
		return petBaseUrl;
	}
	return null;
};

/**
 * 让桌宠说一句。
 *
 * 走 dsh-pet **原版就有**的 `POST /dsh-pet-7340/broadcast`——不是自造接口，所以任何
 * 用户装官方原版 dsh-pet 再装本插件都能用（早期版本调用过 `/say`，那是本插件作者
 * 自己给 dsh-pet 打的补丁，别人机器上不存在，会导致插件的播报全部失效）。
 *
 * body 字段（见 dsh-pet 的 normalizeBroadcast* 与 decideBroadcast）：
 *   text      必填，播报文本
 *   image     可选，表情包名（只能是它池子里的）
 *   duration  气泡停留毫秒数；不传它默认 10 秒。我们按字数算好再传，长句给够时间
 *   anim      false = 不播默认的碎碎念动作
 *
 * 动作联动单独发一次 `POST /dsh-pet-7340/anim {name}`：broadcast 只能开关默认动作，
 * 指定不了动作名，所以联动必然是"一次 broadcast + 一次 anim"两个事件。
 *
 * dsh-pet 不在就静默返回 false，绝不打断主流程。
 */
const sayPet = async (ctx, text, image, extra) => {
	const base = resolvePetBase(ctx);
	if (!base) return false;
	const body = { text };
	if (image) body.image = image;
	if (typeof extra?.duration === "number" && Number.isFinite(extra.duration) && extra.duration > 0) body.duration = Math.round(extra.duration);
	if (typeof extra?.anim === "boolean") body.anim = extra.anim;
	// dsh-pet 的 broadcast / anim 都要求**查询参数** `pet` 和 `surface`：
	//   缺 pet     → {"ok":false,"reason":"pet-required"}
	//   缺 surface → {"ok":false,"reason":"bad-request","message":"surface 必填…"}
	// 而且这两种失败 HTTP 状态都是 200，只有 body 里 ok:false —— 所以**不能拿 res.ok 判成功**，
	// 必须读 body。早期版本只看 res.ok，导致每一条播报都被静默吞掉（日志里有、桌宠不显示）。
	const query = `?pet=${encodeURIComponent(extra?.pet ?? "main")}&surface=${encodeURIComponent(extra?.surface ?? "any")}`;
	logger.debug(`sayPet POST ${base}/dsh-pet-7340/broadcast${query} body=${JSON.stringify(body).slice(0, 80)}`);
	const postJson = async (path, payload) => {
		const res = await fetch(`${base}${path}${query}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(payload)
		});
		let data;
		try {
			data = await res.json();
		} catch {
			return false;
		}
		return data?.ok === true;
	};
	let said = false;
	try {
		said = await postJson("/dsh-pet-7340/broadcast", body);
		if (!said) logger.warn(`播报被 dsh-pet 拒绝（${JSON.stringify(body.text).slice(0, 40)}）`);
	} catch {
		return false;
	}
	// 动作放在播报之后发：broadcast 先把气泡写出来，anim 再叠上去，
	// 顺序反了两个事件在同一拍到达，客户端可能先播动作再显示气泡，观感别扭。
	if (said && extra?.action) {
		try {
			await postJson("/dsh-pet-7340/anim", { name: extra.action });
		} catch {}
	}
	return said;
};

/**
 * ===== 屏幕限制（confineToScreen）=====
 *
 * dsh-pet 有同名配置项，但它的设置页只有一个裸复选框，而且值存在它自己的
 * main-config.jsonc 里（字段白名单，我们的插件写不进去）。所以这里走它的
 * 公开配置接口：先 GET /dsh-pet-7340/config 读当前值，只有跟我们要的不一致才
 * PUT 一次，避免两边互相覆盖、来回打架。
 *
 * PUT 的 body 必须是**完整宠物配置**（缺 pets 数组会被 400 invalid pet config），
 * 而 GET 返回的 main 是拍平视图不能回灌，所以这里只在 pets 存在时下发。
 */
const CONFINE_FIELDS = ["pets", "notificationsEnabled", "confineToScreen"];

/** 从 dsh-pet 的 GET /config 里取它当前真正生效的字段，拼成能 PUT 回去的形状。 */
const readPetConfig = async (ctx) => {
	const base = resolvePetBase(ctx);
	if (!base) return null;
	try {
		const res = await fetch(`${base}/dsh-pet-7340/config`, { headers: { "cache-control": "no-cache" } });
		if (!res.ok) return null;
		const body = await res.json();
		const main = body && typeof body === "object" ? body.main ?? body : null;
		if (!main || !Array.isArray(main.pets)) return null;
		const out = {};
		for (const key of CONFINE_FIELDS) if (key in main) out[key] = main[key];
		return out;
	} catch {
		return null;
	}
};

/**
 * 把本插件的 confineToScreen 推给 dsh-pet。返回 { ok, changed, reason? }。
 *
 * 幂等：值一样就什么都不做。dsh-pet 不在、读不到完整配置、PUT 失败都只是
 * 返回 ok:false，绝不影响插件其它功能。
 */
const pushConfineToScreen = async (ctx, want) => {
	const current = await readPetConfig(ctx);
	if (!current) return { ok: false, reason: "pet-unavailable" };
	if (current.confineToScreen === want) return { ok: true, changed: false };
	if (!Array.isArray(current.pets) || current.pets.length === 0) return { ok: false, reason: "pets-missing" };
	const base = resolvePetBase(ctx);
	if (!base) return { ok: false, reason: "pet-unavailable" };
	try {
		const res = await fetch(`${base}/dsh-pet-7340/config`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ ...current, confineToScreen: want })
		});
		if (!res.ok) return { ok: false, reason: `http-${res.status}` };
		return { ok: true, changed: true };
	} catch (e) {
		return { ok: false, reason: e instanceof Error ? e.message : String(e) };
	}
};

/**
 * 读桌宠记忆（格式：{ <entry>: { <petId>: { messages: [...] } } }）。
 * 只读不写——屏幕记录不再混进对话记忆（见 watchTick 的说明）。
 */
const readMemory = () => {
	try {
		const mem = JSON.parse(readFileSync(memoryPath(), "utf8"));
		return mem && typeof mem === "object" ? mem : {};
	} catch {
		return {};
	}
};

/**
 * ===== 桌面 Helper 的抓图通道 =====
 *
 * 为什么要这么绕：Electron 主进程被宿主 spawn 之后**收不到通过 stdin 写进去的行**
 * （实测写进去几十秒零回应），所以不能用管道下发命令。改成 helper 自己起一个只监听
 * 127.0.0.1 的小 HTTP 服务，启动时往 stdout 打一行
 *   [extras-shot] http://127.0.0.1:PORT
 * 宿主从日志行正则抓端口，之后 POST /shot 就能抓一张。
 *
 * Helper 脚本在本包 runtime/electron-helper/main.js，Electron 可执行文件则由
 * dsh-pet 负责下载（$DSH_HOME/electron/）。找不到就不启动，降级为「截屏不可用」，
 * 绝不因为缺东西就让整个插件加载失败。
 */
const shotChannel = {
	endpoint: void 0,
	child: void 0,
	/** 当前 helper 吃的是哪份参数——变了就得重启它（它只在 spawn 时读环境变量） */
	enabled: void 0,
	intervalSec: void 0,
	keep: void 0
};

/**
 * 本包自带的 helper 入口。
 *
 * 后缀必须是 `.cjs`：本包 package.json 声明了 `"type": "module"`，
 * 同目录下的 `.js` 会被当成 ES module，而这个 helper 用的是 CommonJS（require），
 * Electron 一加载就报 "This file is being treated as an ES module"。
 */
const ownHelperEntry = () => join(dirname(fileURLToPath(import.meta.url)), "..", "runtime", "electron-helper", "main.cjs");

/** Electron 可执行文件的位置（与 dsh-pet 的 landing 目录一致）。 */
/**
 * 找 Electron 可执行文件。
 *
 * 桌面截图只能靠 Electron 的 desktopCapturer，插件自己不带 Electron（40MB+ 的原生二进制），
 * 而是借用 dsh-pet 下载的那一份。但**它的存放位置没有对外承诺**，不同版本可能改目录，
 * 所以这里按可能性从高到低挨个试，而不是写死一条路径：
 *   1. `DSH_PET_ELECTRON_PATH` —— dsh-pet 官方认的覆盖开关，用户手动指定时最优先
 *   2. `$DSH_HOME/electron/electron[.exe]` —— dsh-pet 默认的下载位置
 *   3. `$DSH_HOME/electron/<版本>/electron[.exe]` —— 带版本子目录的布局
 *   4. 本包 node_modules 里的 electron —— 用户自己 `npm i electron` 的情况
 * 全都没有就返回 null，调用方降级成「截屏不可用」，不影响其它功能。
 */
const electronCandidates = () => {
	const exe = process.platform === "win32" ? "electron.exe" : "electron";
	const out = [];
	const fromEnv = process.env.DSH_PET_ELECTRON_PATH;
	if (fromEnv) out.push(fromEnv);
	const root = join(dshHomeDir(), "electron");
	out.push(join(root, exe));
	try {
		for (const sub of readdirSync(root)) out.push(join(root, sub, exe));
	} catch {
		// 目录不存在：正常情况（没装 dsh-pet 或还没下载），忽略
	}
	try {
		out.push(join(dirname(fileURLToPath(import.meta.url)), "..", "node_modules", "electron", "dist", exe));
	} catch {
		// 忽略
	}
	return out;
};
const electronExecutable = () => electronCandidates().find((p) => {
	try {
		return existsSync(p);
	} catch {
		return false;
	}
}) ?? null;

/** 拉起桌面 Helper 子进程（幂等）。settings 由调用方传入，避免二次读缓存拿到旧值。 */
const ensureShotHelper = (settings) => {
	if (shotChannel.child) return true;
	const electronPath = electronExecutable();
	if (!electronPath) {
		logger.warn(`没找到 Electron 桌面运行时（试过：${electronCandidates().join(" / ")}）。` +
			`截屏不可用 —— 装一个 dsh-pet 它会自动下载，或用 DSH_PET_ELECTRON_PATH 指定。`);
		return false;
	}
	const helperEntry = ownHelperEntry();
	if (!existsSync(helperEntry)) {
		logger.warn(`找不到桌面 Helper 入口 ${helperEntry}，截屏不可用`);
		return false;
	}
	const live = settings ?? screenshotSettings();
	try {
		const env = { ...process.env };
		// 本会话的父进程环境可能带 ELECTRON_RUN_AS_NODE=1；带着它启动 Electron 会变成
		// 「纯 Node 模式」，desktopCapturer 全废。必须删掉。
		delete env.ELECTRON_RUN_AS_NODE;
		env.DSH_PET_EXTRAS_SHOT_ENABLED = live.enabled ? "1" : "0";
		env.DSH_PET_EXTRAS_SHOT_INTERVAL = String(live.intervalSec);
		env.DSH_PET_EXTRAS_SHOT_DIR = screenshotsDir();
		env.DSH_PET_EXTRAS_SHOT_KEEP = String(Math.max(1, Math.min(2000, Number(readConfig().screenshotKeep) || 60)));
		// 记下这次用的是哪份设置，stopShotHelper 判断要不要重启时对比用。
		shotChannel.enabled = live.enabled;
		shotChannel.intervalSec = live.intervalSec;
		shotChannel.keep = shotKeep();
		const child = spawn(electronPath, [helperEntry], { stdio: ["ignore", "pipe", "pipe"], env, windowsHide: true });
		shotChannel.child = child;
		const onChunk = (buf) => {
			for (const line of String(buf).split(/\r?\n/)) {
				const trimmed = line.trim();
				if (!trimmed) continue;
				const m = trimmed.match(/\[extras-shot\]\s+(http:\/\/127\.0\.0\.1:\d+)/);
				if (m) {
					shotChannel.endpoint = m[1];
					logger.debug(`抓图端口已就绪 ${m[1]}`);
					continue;
				}
				logger.debug(`[helper] ${trimmed}`);
			}
		};
		child.stdout?.on("data", onChunk);
		child.stderr?.on("data", onChunk);
		child.on("exit", () => {
			shotChannel.child = void 0;
			shotChannel.endpoint = void 0;
		});
		return true;
	} catch (e) {
		logger.warn("拉起桌面 Helper 失败：" + (e instanceof Error ? e.message : String(e)));
		return false;
	}
};

/**
 * 按当前配置校准 helper 进程。
 *
 * 为什么需要这个：helper 只在 **spawn 时**读一次环境变量，之后再也不看宿主配置。
 * 所以关掉「定时截屏」时，已经在跑的 helper 会带着旧定时器一直截图下去——
 * 用户看到的现象就是「我明明关了，它还在截」。必须主动把它杀掉或重启。
 *
 * @param {boolean} [force] 无条件重启（比如要让它重新读间隔）
 */
const stopShotHelper = (force = false) => {
	const child = shotChannel.child;
	if (!child) return false;
	shotChannel.child = void 0;
	shotChannel.endpoint = void 0;
	try {
		child.kill();
	} catch {}
	logger.debug(force ? "重启截图 helper" : "停止截图 helper");
	return true;
};

/**
 * 让 helper 与配置保持一致：关着就确保进程不在，开着但没跑就起。
 *
 * 开关变了 → 杀或起；间隔变了 → 重启一次让新 env 生效（2026-10-24 起）。
 *
 * 为什么以前不敢按间隔重启：那时 dsh-pet 和插件各有一份间隔，两份值天然可能
 * 不同（实测 25 vs 20），拿它当条件就会每轮都杀掉 helper，而新 helper 启动
 * 会立刻抓一张 →「同一画面一连说三次」、图数凭空翻倍。
 *
 * 现在只剩一个旋钮（sightShareMinGap），两边读的是同一个数，不会再抖；
 * 而用户改完间隔期望立刻生效，不该让他去切一次开关或重启应用。
 * 所以按「值真的变了」重启，并且记下上次用的值——值没变就什么都不做。
 */
const syncShotHelper = (settings) => {
	const live = settings ?? screenshotSettings();
	const running = shotChannel.child !== void 0;
	if (!live.enabled) {
		// 关着：进程不该存在。杀掉即可（不重启）。
		if (running) return stopShotHelper();
		return false;
	}
	// 开着但没跑：起一个
	if (!running) {
		ensureShotHelper(live);
		return true;
	}
	// 跑着：开关变了要换进程；间隔变了也要换，否则用户改了数还得重启应用
	if (shotChannel.enabled !== live.enabled) {
		stopShotHelper(true);
		// 让旧进程先退干净，避免端口/实例抢占。live 必须闭包带进去。
		setTimeout(() => ensureShotHelper(live), 600);
		return true;
	}
	// 间隔变了：只在值确实不同时重启一次。ensureShotHelper 里会把新值记进 shotChannel。
	if (shotChannel.intervalSec !== live.intervalSec) {
		stopShotHelper(true);
		setTimeout(() => ensureShotHelper(live), 600);
		return true;
	}
	return false;
};

/** 让 Helper 立刻抓一张。 */
const captureShot = async () => {
	if (!shotChannel.endpoint) return {
		ok: false,
		reason: "no-endpoint",
		message: "桌面 Helper 还没上报抓图端口（截屏只能在桌面模式下用）"
	};
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 15000);
	try {
		const res = await fetch(`${shotChannel.endpoint}/shot`, { method: "POST", signal: controller.signal });
		return await res.json();
	} catch (e) {
		return {
			ok: false,
			reason: "shot-failed",
			message: "抓图失败：" + (e instanceof Error ? e.message : String(e))
		};
	} finally {
		clearTimeout(timer);
	}
};

/**
 * ===== 接智能体 =====
 *
 * 口径是「完全一样但串行」：桌宠说的那句话就是投进主会话、由同一个脑子回答的，
 * 主会话忙着就排队等这一轮跑完。代价是同一时刻只能有一边在说话，
 * 换来的是同一份上下文、同一份记忆——桌宠不会变成「另一个人格」。
 */
const sessionOf = (agent) => agent?.session ?? void 0;

/**
 * 取一个会话的标题。
 *
 * DSH 的标题由服务 `sessionTitle` 折出来（`session/title` 事件）；没设过标题时
 * 会自动拿第一条消息生成一个，所以界面上看到的「你好」也是标题。
 * 先问服务，服务不在就扫日志里最后一条 `session/title` 兜底。都拿不到返回空串。
 */
const titleOfSession = (ctx, session) => {
	if (!session) return "";
	try {
		const service = ctx?.get?.("sessionTitle") ?? ctx?.sessionTitle;
		if (service && typeof service.get === "function") {
			const snap = service.get(session);
			if (snap && typeof snap.title === "string" && snap.title.trim()) return snap.title.trim();
		}
	} catch {}
	try {
		const events = session.snapshotEvents?.() ?? [];
		for (let i = events.length - 1; i >= 0; i--) {
			const ev = events[i];
			if (ev?.type === "session/title" && typeof ev.data?.title === "string" && ev.data.title.trim()) return ev.data.title.trim();
		}
	} catch {}
	return "";
};

/** 界面上能接的所有会话（排除桌宠自己建过的），带标题，seq 大的排前面。 */
const listHostSessions = (ctx, agents) => {
	const roots = typeof agents.roots === "function" ? agents.roots() : agents.list() ?? [];
	const out = [];
	for (const a of roots) {
		const s = sessionOf(a);
		if (!s) continue;
		if (String(s.id).startsWith(PET_AGENT_PREFIX)) continue;
		out.push({
			id: String(s.id),
			title: titleOfSession(ctx, s),
			status: a.status,
			seq: typeof s.seq === "number" ? s.seq : 0
		});
	}
	out.sort((x, y) => y.seq - x.seq);
	return out;
};

/**
 * 挑主会话的**底层实现**：把「怎么选出来的」一起带回来。
 *   source = "target"    → 命中了主人配置的会话（正常）
 *   source = "fallback"  → 没命中，靠 seq 最大回落（要警告）
 *   source = "auto"      → 主人没配，本来就是自动挑（正常）
 *
 * 参数顺序是 (ctx, agents)——曾经有一处调用写成 (agents, ctx)，导致 agents.roots
 * 读不到、报 `cannot get property "roots" without inject`，看图结论一直注不进主会话。
 */
/** 同一类告警只喊一次，别每 60 秒刷一遍日志。 */
const targetWarned = new Set();
const warnOnceTarget = (key, msg) => {
	if (targetWarned.has(key)) return;
	targetWarned.add(key);
	logger.warn(msg);
};

const pickHostSessionDetailed = (ctx, agents, allowFallback = false) => {
	const conf = readConfig();
	const wantedId = String(conf.targetSessionId ?? "").trim();
	const wantedTitle = String(conf.agentBridgeTarget ?? "").trim();
	const wanted = wantedId || wantedTitle;
	const roots = typeof agents.roots === "function" ? agents.roots() : agents.list() ?? [];
	const byId = (key) => (typeof agents.get === "function" ? agents.get(key) : void 0);
	if (wantedId) {
		const hit = byId(wantedId);
		if (hit) return { host: hit, source: "target", wanted };
	}
	if (wantedTitle) {
		const hit = byId(wantedTitle);
		if (hit) return { host: hit, source: "target", wanted };
		const byName = roots.find((a) => {
			const s = sessionOf(a);
			if (!s || String(s.id).startsWith(PET_AGENT_PREFIX)) return false;
			return titleOfSession(ctx, s) === wantedTitle;
		});
		if (byName) return { host: byName, source: "target", wanted };
	}
	// 没有 allowFallback 就到此为止：绝不猜。
	if (!allowFallback) {
		return { host: void 0, source: wanted ? "missing" : "unset", wanted };
	}
	let best;
	let bestSeq = -1;
	for (const a of roots) {
		const s = sessionOf(a);
		if (!s || String(s.id).startsWith(PET_AGENT_PREFIX)) continue;
		const seq = typeof s.seq === "number" ? s.seq : 0;
		if (seq > bestSeq) {
			bestSeq = seq;
			best = a;
		}
	}
	return { host: best, source: wanted ? "fallback" : "auto", wanted };
};

/** 挑主会话：**只给显示界面和手动接口用**，允许回落。定时投图走 pickHostSessionFor。 */
const pickHostSession = (ctx, agents) => {
	const { host, source, wanted } = pickHostSessionDetailed(ctx, agents, true);
	if (source === "fallback") {
		// 目标失效、静默顶替是最恶心的一种坑：主人以为图投给自己选的会话，
		// 实际全进了消息最多的那条，界面上一个字都不提示（2026-10-24 真实发生：
		// 目标写「鲸鱼」，但那条当时没在运行列表里，截图全投进了当前这条）。
		// 这里至少留一条日志，排查时能一眼看出「是回落，不是你选的那条」。
		logger.warn(`目标会话「${wanted || "未选"}」没命中，回落到「${host ? titleOfSession(ctx, sessionOf(host)) : "无"}」——不是主人选的那条`);
	}
	return host;
};

/**
 * 主人指定的目标会话现在到底存不存在（在运行中的会话列表里）。
 *
 * 为什么要单独判一次：`pickHostSession` 在目标找不到时会回落到「seq 最大的那条」，
 * 这个回落本身是对的（不然桌宠彻底不能说话），但它是**静默**的——主人填了「鲸鱼」，
 * 实际全投进「你好」，界面上毫无提示，会一直以为在用自己选的那条。
 * 所以保存前先来这里问一句：目标是真的存在，还是只是被回落顶替了。
 *
 * 返回现状，不负责挑会话：
 *   { wanted: 主人填的原文（空串=自动模式）, found: 目标是否命中, resolved: 实际会用的那条 }
 */
const resolveTarget = (ctx, agents) => {
	const conf = readConfig();
	const wantedId = String(conf.targetSessionId ?? "").trim();
	const wantedTitle = String(conf.agentBridgeTarget ?? "").trim();
	const wanted = wantedId || wantedTitle;
	const list = listHostSessions(ctx, agents);
	const all = typeof agents.roots === "function" ? agents.roots() : agents.list() ?? [];
	const inside = (a) => {
		const s = sessionOf(a);
		return !!s && !String(s.id).startsWith(PET_AGENT_PREFIX);
	};
	const brief = (a) => {
		const s = sessionOf(a);
		return s ? { id: String(s.id), title: titleOfSession(ctx, s), status: a.status, seq: s.seq } : null;
	};
	if (!wanted) return { wanted: "", found: true, resolved: brief(pickHostSession(ctx, agents)) };
	const byId = typeof agents.get === "function" ? agents.get(wanted) : void 0;
	if (byId && inside(byId)) return { wanted, found: true, resolved: brief(byId) };
	const byTitle = all.find((a) => inside(a) && titleOfSession(ctx, sessionOf(a)) === (wantedTitle || wanted));
	if (byTitle) return { wanted, found: true, resolved: brief(byTitle) };
	// 没命中：告诉调用方「目标失效」，顺带给出回落会用哪条，以及现有可选项
	return { wanted, found: false, resolved: brief(pickHostSession(ctx, agents)), available: list };
};

/**
 * 等主会话空闲：一直轮询到 status === "idle"。
 *
 * waitMs 默认用 QUEUE_WAIT_MS（15 分钟），但**持锁等待必须给短上限**：
 * 主会话忙的时候桌宠会一直占着这把锁，后面每个请求都要等在它后面，
 * 用户看到的就是「桌宠一声不吭卡几分钟」。所以默认等 IDLE_WAIT_MS（90 秒）就放弃，
 * 让调用方当场拿到 busy-timeout，而不是排进一条越来越长的队。
 */
const untilIdle = async (agent, waitMs = IDLE_WAIT_MS) => {
	const deadline = Date.now() + waitMs;
	while (Date.now() < deadline) {
		if (agent.status === "idle") return true;
		await new Promise((r) => setTimeout(r, POLL_MS));
	}
	return false;
};

const lockOf = (id) => {
	let l = turnLocks.get(id);
	if (!l) {
		l = { tail: Promise.resolve(), depth: 0 };
		turnLocks.set(id, l);
	}
	return l;
};

/**
 * 串行执行：同一会话上，后进来的请求排在前面那个后面。
 *
 * 这个锁只覆盖「投递 → 等回复」这一段，不覆盖等待主会话 idle 的时段，
 * 所以不会出现「桌宠持锁等主会话、主会话等桌宠放锁」的死锁。
 */
const withTurnLock = async (sessionId, job) => {
	const lock = lockOf(sessionId);
	const previous = lock.tail;
	const done = Promise.withResolvers();
	lock.tail = previous.then(() => done.promise, () => done.promise);
	lock.depth += 1;
	try {
		await previous.catch(() => {});
		return await job();
	} finally {
		lock.depth -= 1;
		done.resolve();
		if (lock.depth === 0 && turnLocks.get(sessionId) === lock) turnLocks.delete(sessionId);
	}
};

/** 队列里排了几单（给状态接口显示用）。 */
const queueDepthOf = (sessionId) => turnLocks.get(sessionId)?.depth ?? 0;

/**
 * 选主会话，顺带执行「目标没命中就不投」这条硬规矩（strict 模式）。
 *
 * 为什么要有 strict：自动回落（挑 seq 最大的那条）对**聊天**是对的——
 * 主人没指定就挑个能答的；但对**投图/看图**是灾难——主人以为图进了自己选的那条，
 * 实际全进了别的会话，界面上一个字都不提示（2026-10-24 真实发生：目标写「鲸鱼」，
 * 实际全投进了当前这条，主人从气泡里才看出来）。
 *
 * 所以 strict 下只认命中：目标没在运行列表里就返回 undefined，调用方照常播报、
 * 不投不注入。空串（自动模式）不受影响——那是主人明确说「随便找一条」。
 */
const pickHostSessionFor = (ctx, agents, strict) => {
	const { host, source, wanted } = pickHostSessionDetailed(ctx, agents, !strict);
	if (source === "target") return host;
	if (!strict) return host;
	if (source === "unset") {
		warnOnceTarget("unset", "还没选目标会话，这一轮不投递——设置 → 桌宠扩展 → 目标会话里选一条（不选就什么都不投，也不会乱投）");
		return void 0;
	}
	if (source === "missing" || source === "fallback") {
		warnOnceTarget(`missing:${wanted}`, `[strict] 目标会话「${wanted}」不在运行中，这一轮不投递——不会改投别的会话`);
		return void 0;
	}
	return host;
};

/**
 * 把桌宠的话投给主会话，等它答完，返回 assistant 的文字。
 *
 * 这是**基本要求**的那条路：桌宠说的话真的进了主会话，回答再用桌宠的声音说出来，
 * 上下文和记忆全共享（「两端一体」）。看图播报也走这里——见 watchTick。
 *
 * opt.images          ImageAttachmentRef 数组，拼成 image block 交给模型
 * opt.strict          目标没命中就不投（投图/看图用；聊天仍走自动回落）
 * opt.excludeImages   投递的图只用于「让会话看」，不算进「这一轮说了什么」
 *                     （否则拿回答去和截图比「画面变没变」，永远判成变了）
 * opt.source          消息来源标记，默认当成主人发的
 */
const talkToHostAgent = async (ctx, text, opt = {}) => {
	try {
		return await talkToHostAgentInner(ctx, text, opt);
	} finally {
		// 无论成功、失败、抛异常，投递结束就放旗——不能让一个静态标志永久卡住看图
		petTurnPending = false;
	}
};

const talkToHostAgentInner = async (ctx, text, opt = {}) => {
	const { images = [], strict = false, excludeImages = false, source } = opt;
	// 开关以 dsh-pet 为准：设置页关掉「接智能体」就该真的不投递。
	// 这里再查一次是兜底——调用方通常已经判断过，但 HTTP 接口不经过设置页。
	const petConf = petConfSnapshot();
	if (petConf && petConf.agentBridgeEnabled === false) return {
		ok: false,
		reason: "disabled",
		message: "接智能体没开（设置页 → 全局开关 → 接智能体）"
	};
	const agents = ctx.agents;
	if (!agents || typeof agents.get !== "function") return {
		ok: false,
		reason: "no-agent",
		message: "宿主没有智能体服务（ctx.agents 不可用）"
	};
	const host = pickHostSessionFor(ctx, agents, strict);
	const session = host ? sessionOf(host) : void 0;
	if (strict && !session) return {
		ok: false,
		reason: "target-missing",
		message: "主人指定的会话现在没在运行，这一轮不投递"
	};
	if (!session) return {
		ok: false,
		reason: "no-agent",
		message: "现在没有正在运行的界面会话，先在界面里开一个对话再来找我"
	};
	return withTurnLock(session.id, async () => {
		// 0) 立旗：从排队开始就算「桌宠正在等会话回话」，直到外层 finally 放旗。
		//    看图循环靠它判断「别插队，等上一条的回复回来再说」。
		petTurnPending = true;
		// 1) 排队：等它把手头这一轮干完
		//
		// 注意这里持锁等待是**有意的**：真正的死锁风险在「主会话自己也在等桌宠」，
		// 而桌宠投递走的是 followup（下一轮），主会话这一轮不会等它，所以持锁安全。
		// 关键是要给等待一个**短上限**：等太久就放弃，别把后面排队的请求一起堵死。
		const idle = await untilIdle(host, Math.min(QUEUE_WAIT_MS, IDLE_WAIT_MS));
		if (!idle) return {
			ok: false,
			reason: "busy-timeout",
			message: `主会话一直在忙，等了 ${Math.round(Math.min(QUEUE_WAIT_MS, IDLE_WAIT_MS) / 1000)} 秒还没空，稍后再来`,
			retryable: true
		};
		// 再确认一次还是同一条会话（期间可能被换掉）
		const host2 = pickHostSessionFor(ctx, agents, strict);
		const session2 = host2 ? sessionOf(host2) : void 0;
		if (!session2 || session2.id !== session.id) return {
			ok: false,
			reason: "session-changed",
			message: "主会话在那期间换掉了，请再说一次"
		};
		const beforeSeq = session2.seq;
		// 2) 投递
		try {
			host2.followup({
				// inbox 要求每条消息有唯一 id，缺了会撞成 "undefined is already pending"
				id: `dsh-pet-extras-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
				// 落盘校验（assertMessageEventShape）要求 user/message 的 data 带 role，
				// 漏了会让整条会话历史加载失败——这个坑踩过两次。
				role: "user",
				content: [{
					type: "text",
					text: `${PET_MSG_FENCE}${text}`
				}, ...images.map((attachment) => ({
					type: "image",
					attachment
				}))],
				source: source ?? { kind: "user", id: `dsh-pet-extras-${Date.now()}` }
			});
		} catch (e) {
			return {
				ok: false,
				reason: "deliver-failed",
				message: "投递失败：" + (e instanceof Error ? e.message : String(e))
			};
		}
		// 3) 等这一轮结束（seq 前进过、并且回到 idle）
		const deadline = Date.now() + TURN_TIMEOUT_MS;
		let sawActivity = false;
		while (Date.now() < deadline) {
			const s = sessionOf(host2);
			if (!s) return {
				ok: false,
				reason: "agent-gone",
				message: "主会话已被关闭"
			};
			if (s.seq > beforeSeq) sawActivity = true;
			if (sawActivity && host2.status === "idle") break;
			await new Promise((r) => setTimeout(r, POLL_MS));
		}
		if (!(sawActivity && host2.status === "idle")) return {
			ok: false,
			reason: "timeout",
			message: `等智能体回复超时（${Math.round(TURN_TIMEOUT_MS / 1000)} 秒）`
		};
		// 4) 只扫「紧跟在我那条带围栏的消息之后」这一轮产生的助手文字
		//
		// 扫描范围必须**锚定到我那条消息所在的位置**，不能从 beforeSeq 一路扫到最后：
		// 以前是「找到围栏就断、没找到就用 beforeSeq」，可 seq 范围里可能塞着主人自己
		// 刚发的一轮（他在投递之后马上又说了话），那一轮的助手回复是给主人的，
		// 混进来就会被桌宠念一遍。现在：拿到落库位置就向下扫一轮，拿不到就倒着找最近的。
		const live = sessionOf(host2);
		const limit = live?.seq ?? beforeSeq;
		let turnStart;
		for (let seq = limit - 1; seq >= beforeSeq; seq--) {
			const ev = live.eventAt(seq);
			if (!ev || ev.type !== "user/message") continue;
			const blocks = ev.data?.content;
			if (!Array.isArray(blocks)) continue;
			if (blocks.some((b) => b && b.type === "text" && typeof b.text === "string" && b.text.startsWith(PET_MSG_FENCE))) {
				turnStart = seq;
				break;
			}
		}
		if (turnStart === void 0) return {
			ok: false,
			reason: "turn-not-found",
			message: "没能在会话事件里定位到这一轮的起点"
		};
		let reply = "";
		const pics = [];
		for (let seq = turnStart; seq < limit; seq++) {
			const ev = live.eventAt(seq);
			if (!ev) continue;
			// 遇到**别人**新开的一轮就停：那一轮的助手回复不是说给桌宠听的，念出来就是抢话。
			//
			// 但不能见到 user/message 就停——同一轮里宿主还会自己插几条用户消息
			// （Current runtime context / Time sampled / MNEMON RUNTIME MEMORY SNAPSHOT）。
			// 以前这里无条件 break，结果扫描在第一条运行时上下文就断了，
			// 明明 assistant/message 就在后面，却被判成 empty-reply（2026-10-24 实测，
			// 日志连刷三条「这一轮没有输出文字」，而会话里其实每次都回了话）。
			//
			// 判据：只认主人亲手发的（有 source 但 source.kind 不是我们自己），
			// 宿主注入的 runtime 上下文没有 source，插图的 source.kind 是 dsh-pet-sight-image。
			if (ev.type === "user/message" && !isRuntimeInjected(ev)) break;
			if (ev.type !== "assistant/message") continue;
			const content = ev.data?.message?.content;
			if (!Array.isArray(content)) continue;
			for (const block of content) {
				if (!block) continue;
				if (block.type === "text" && typeof block.text === "string" && block.text.trim()) reply += (reply ? "\n\n" : "") + block.text.trim();
				else if (!excludeImages && block.type === "image" && block.attachment) pics.push(block.attachment);
			}
		}
		if (!reply && pics.length === 0) {
			petTurnPending = false;
			// 这一轮是**报错结束**的（宿主在 turn/end 里带走 reason.kind === "error"），
			// 不是「它不想说话」。典型例子：写附件缓存时 rename 撞上文件锁
			// （`EBUSY: resource busy or locked, rename …request-images…tmp`，2026-10-24 实测），
			// 文件其实落盘成功了，但那一轮已经作废。这种情况要如实报「为什么没回」，
			// 而不是含糊成「没有输出文字」——排查时少走一大圈。
			const failure = turnFailureText(live, turnStart, limit);
			return {
				ok: false,
				reason: failure ? "turn-failed" : "empty-reply",
				retryable: !!failure,
				message: failure ? `这一轮报错结束：${failure}` : "这一轮没有输出文字"
			};
		}
		petTurnPending = false;
		return {
			ok: true,
			text: reply || "（只回了图片）",
			...pics.length > 0 ? { images: pics } : {},
			sessionId: live.id
		};
	});
};

/**
 * 这条 user/message 是不是宿主自己插进来的（不是主人亲手打的，也不是我们投的）。
 *
 * 用来区分「同一轮里的运行时上下文」和「主人新开的一轮」。实测（2026-10-24）：
 *   - runtime context：source = { kind: "runtime-context", form: "snapshot", sections: [...] }
 *   - 时间戳：      source = { kind: "time-context", ... }
 *   - 记忆快照：    source = { kind: "dsh-mnemon", ... }
 *   - 我们投的图：  source = { kind: "dsh-pet-sight-image", id: "dsh-pet-extras" }
 *   - 主人亲手发的：`source.kind` 是 "user" 之类，或根本没有 source
 *
 * **没有 source 也当主人发**——保守：宁可少念一句，也不要抢主人的话。
 */
const HOST_INJECTED_KINDS = new Set(["runtime-context", "time-context", "dsh-mnemon", "dsh-pet-sight-image"]);
const isRuntimeInjected = (ev) => {
	const st = ev.data?.source;
	if (!st || typeof st !== "object") return false;
	return HOST_INJECTED_KINDS.has(String(st.kind ?? ""));
};

/**
 * 在 [from, to) 这段事件里找这一轮**失败的原因**（宿主把错误挂在 turn/end 的 reason 上）。
 *
 * 为什么要单独找：投递完拿不到正文有两种完全不同的情况——
 *   ① 它真的什么都没说（安静，可以接受）；
 *   ② 这一轮中途报错了（比如附件缓存 rename 撞锁 EBUSY），那一轮等于白跑。
 * 以前两种情况都报「没有输出文字」，看日志根本分不出来，只能靠翻会话存档。
 */
const turnFailureText = (session, from, to) => {
	for (let seq = to - 1; seq >= from; seq--) {
		const ev = session.eventAt(seq);
		if (!ev) continue;
		if (ev.type !== "turn/end") continue;
		const reason = ev.data?.reason;
		if (!reason || reason.kind !== "error") return "";
		const err = reason.error ?? reason.failure;
		const msg = err?.message ?? (typeof err === "string" ? err : "");
		return String(msg || "未知错误").slice(0, 300);
	}
	return "";
};

/** 当前桥接状态（给状态接口显示用）。 */
const agentBridgeInfo = (ctx) => {
	const agents = ctx.agents;
	if (!agents || typeof agents.get !== "function") return {
		available: false,
		reason: "宿主没有智能体服务"
	};
	const host = pickHostSession(ctx, agents);
	const hostSession = host ? sessionOf(host) : void 0;
	const conf = readConfig();
	const configured = String(conf.agentBridgeTarget ?? "").trim();
	// 填了目标但没命中 → 现在的 host 是回落顶替来的，界面必须说清楚，不能让人以为接的就是自己选的那条
	const target = configured ? resolveTarget(ctx, agents) : null;
	return {
		available: true,
		configured,
		targetSessionId: String(conf.targetSessionId ?? "").trim(),
		enabled: conf.agentBridgeEnabled === true,
		mode: "same-session-serial",
		targetFound: target ? target.found : true,
		host: hostSession ? {
			id: hostSession.id,
			title: titleOfSession(ctx, hostSession),
			status: host.status,
			seq: hostSession.seq,
			cwd: hostSession.meta?.cwd,
			queued: queueDepthOf(hostSession.id),
			...(host.options ? {
				provider: host.options.provider,
				model: host.options.model
			} : {})
		} : null,
		candidates: listHostSessions(ctx, agents)
	};
};

/**
 * ===== 定时看图 =====
 *
 * 截屏本身由桌面 Helper 做（只落盘）。这一层补「没人看」那一环：
 * 定时把目录里最新的 PNG 读出来 → 存成 attachment → 交给模型看一眼 →
 * 把一句话结论写进桌宠记忆，主人问「刚才屏幕上是什么」时它就能答。
 *
 * 每张图都会真的调一次模型，所以关掉这个开关就是开省钱。
 */
let watchBusy = false;
let watchLastFile = null;

/**
 * 长边多长就给模型看。
 *
 * 为什么不按固定的 1280/1920：用户的屏幕千差万别（4K、1080p、竖屏、双屏拼接），
 * 写死某个宽度会让大屏用户被砍得太狠、小屏用户白占。真正该约束的是**长边**，
 * 因为多模态模型内部按长边分块，超过 1568 的部分会被它自己重采样掉——
 * 传更大的等于白占带宽、白撑上下文。
 *
 * 1568 的来历：主流视觉模型的原生处理边长量级就在这附近（约 1600），
 * 再大不涨理解力，只涨 token。
 */
const LOOK_MAX_EDGE = 1568;

/**
 * 预热模型请求用的那张图（`request-images/` 缓存），把整轮跑挂的 EBUSY 挡在最前面。
 *
 * 为什么需要：宿主发请求前会调 `attachments.readImageRequest(ref, target)`，
 * 第一次没缓存就现算现写——
 *   writeCached(): writeFile(`<cache>.xxx.tmp`) → rename(`<cache>.xxx.tmp`, `<cache>`)
 * 而 Windows 上「目标文件正被别的句柄读」时 rename 会抛 EPERM/EBUSY，
 * 宿主不重试、直接把整轮判死（用户看到的就是「本轮运行失败 EBUSY」）。
 * 实测 200 次读写同路径撞 1%，量一大就变成每 10 分钟一次。
 *
 * 怎么绕：投递消息**之前**先自己把这个缓存算好写进去。
 * 之后宿主那次 `readCached` 直接命中，根本不会再走 rename。
 * 预热是自己串行做的，撞车时退避重试，失败也只是少一次预热，不影响正文投递。
 *
 * target 怎么来的：宿主按「路由」决定尺寸/字节上限，插件不 import 宿主内部模块，
 * 改用公开的两个入口推：
 *   ctx.llm.imageRequestTarget(provider, model, ref)  → 这条路由真正会用的 target
 *   ctx.attachments.imageHostPath(ref)                → 规范化图落盘路径，读宽高
 * 路由暂时问不到就用保守估计（够大），最后一道兜底是长边 4096 / 32MB。
 */
const PREWARM_MAX_BYTES = 33554432;
const PREWARM_MAX_EDGE = 4096;
const PREWARM_TRIES = 4;

/** `imageHostPath` 落的是规范化后的图，读它开头几个字节拿宽高就够了。 */
const readImageSize = (file) => {
	try {
		const head = Buffer.alloc(32);
		const fd = openSync(file, "r");
		try {
			readSync(fd, head, 0, 32, 0);
		} finally {
			closeSync(fd);
		}
		if (head.readUInt32BE(0) === 0x89504e47) {
			return {
				width: head.readUInt32BE(16),
				height: head.readUInt32BE(20)
			};
		}
		if (head[0] === 0xff && head[1] === 0xd8) {
			let offset = 2;
			const buf = readFileSync(file);
			while (offset + 9 < buf.length) {
				if (buf[offset] !== 0xff) {
					offset += 1;
					continue;
				}
				const marker = buf[offset + 1];
				if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
					return {
						height: buf.readUInt16BE(offset + 5),
						width: buf.readUInt16BE(offset + 7)
					};
				}
				if (marker === 0xd8 || marker === 0xd9 || marker >= 0xd0 && marker <= 0xd7) {
					offset += 2;
					continue;
				}
				offset += 2 + buf.readUInt16BE(offset + 2);
			}
		}
	} catch {
		// 读不到就当不知道，走保守估计
	}
	return void 0;
};

/** 宿主这条路由会用多大的图；问不到就给个够保守的。 */
const resolvePrewarmTarget = (ctx, ref, fallback) => {
	let size;
	try {
		const path = ctx.attachments.imageHostPath(ref);
		if (typeof path === "string" && path) size = readImageSize(path);
	} catch {
		// 后端不是文件落盘型，只能靠 ref 自带的宽高
	}
	const width = size?.width ?? Number(ref?.width) ?? 0;
	const height = size?.height ?? Number(ref?.height) ?? 0;
	if (!(width > 0) || !(height > 0)) return fallback;
	const llm = ctx.llm;
	if (llm && typeof llm.imageRequestTarget === "function") {
		try {
			const budget = ctx.agentDefaultModel?.currentSelection?.() ?? void 0;
			if (budget?.provider && budget?.model) {
				const target = llm.imageRequestTarget(budget.provider, budget.model, {
					width,
					height,
					bytes: fallback.maxBytes
				});
				if (target && Number(target.width) > 0 && Number(target.height) > 0) return {
					width: Number(target.width),
					height: Number(target.height),
					maxBytes: Number(target.maxBytes) > 0 ? Number(target.maxBytes) : fallback.maxBytes
				};
			}
		} catch {
			// 路由还没注册好之类，退回保守估计
		}
	}
	// 保守估计：比宿主真正要的大，这样预热的 variantId 一定覆盖得住那次真请求。
	// （宿主对「已经够小」的图会直接原样返回，不依赖字节上限。）
	const long = Math.max(width, height);
	if (long <= PREWARM_MAX_EDGE) return {
		width,
		height,
		maxBytes: PREWARM_MAX_BYTES
	};
	const ratio = PREWARM_MAX_EDGE / long;
	return {
		width: Math.max(1, Math.round(width * ratio)),
		height: Math.max(1, Math.round(height * ratio)),
		maxBytes: PREWARM_MAX_BYTES
	};
};

const isBusyError = (error) => {
	const code = error && typeof error === "object" ? error.code : void 0;
	const text = error instanceof Error ? error.message : String(error ?? "");
	return code === "EBUSY" || code === "EPERM" || code === "EACCES" || /EBUSY|resource busy or locked|EPERM/i.test(text);
};

const busyWait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 把这张图的请求缓存先算好，让宿主发请求时直接命中。失败一律不抛。 */
const prewarmRequestImage = async (ctx, ref) => {
	const store = ctx.attachments;
	if (!store || typeof store.readImageRequest !== "function") return {
		ok: false,
		reason: "unsupported"
	};
	let target = {
		width: 0,
		height: 0,
		maxBytes: PREWARM_MAX_BYTES
	};
	try {
		target = resolvePrewarmTarget(ctx, ref, {
			width: Number(ref?.width) || PREWARM_MAX_EDGE,
			height: Number(ref?.height) || PREWARM_MAX_EDGE,
			maxBytes: PREWARM_MAX_BYTES
		});
	} catch {
		// 推不出 target 也用默认那个继续试
	}
	for (let attempt = 1; attempt <= PREWARM_TRIES; attempt++) {
		try {
			await store.readImageRequest(ref, target);
			return {
				ok: true,
				attempt,
				target
			};
		} catch (e) {
			if (!isBusyError(e) || attempt === PREWARM_TRIES) {
				logger.debug(`预热请求图没成功（第 ${attempt} 次）：${e instanceof Error ? e.message : String(e)}`);
				return {
					ok: false,
					reason: "failed",
					message: e instanceof Error ? e.message : String(e)
				};
			}
			await busyWait(60 * attempt);
		}
	}
	return {
		ok: false,
		reason: "failed"
	};
};

/** 把 PNG 文件读成 attachment 引用（走宿主附件服务，模型才拿得到图像字节）。 */
const shotToAttachment = async (ctx, file) => {
	const store = ctx.attachments;
	if (!store || typeof store.saveImages !== "function") return {
		ok: false,
		message: "宿主没有附件服务，图片送不进模型"
	};
	let buf;
	try {
		buf = readFileSync(file);
	} catch (e) {
		return {
			ok: false,
			message: "读截图失败：" + (e instanceof Error ? e.message : String(e))
		};
	}
	if (buf.length === 0) return {
		ok: false,
		message: "截图是空的"
	};

	// 缩到长边 LOOK_MAX_EDGE 再送。整屏 2561x1601 的原图投进会话，
	// 一张就占掉几百 KB 上下文，60 秒一张几小时能把会话撑爆；
	// 「抬头看一眼你在干嘛」根本不需要那个清晰度。
	// 缩不了（不支持的 PNG 变体）就原样投——缩不了比投不进去强。
	let sendBuf = buf;
	const shrunk = shrinkPng(buf, LOOK_MAX_EDGE);
	if (shrunk.ok && !shrunk.unchanged) sendBuf = shrunk.data;
	else if (!shrunk.ok) logger.debug("截图缩放跳过：" + shrunk.message);

	try {
		const refs = await store.saveImages([{
			data: new Uint8Array(sendBuf),
			mediaType: "image/png",
			name: file.split(/[\\/]/).pop()
		}]);
		if (!refs || refs.length === 0) return {
			ok: false,
			message: "附件服务没有接收这张图"
		};
		// 先自己把请求缓存写热，宿主发请求时就能直接命中，
		// 不会在「读同一路径」的窗口里 rename 撞上 EBUSY 把整轮跑挂。
		const warmed = await prewarmRequestImage(ctx, refs[0]);
		if (!warmed.ok && warmed.reason === "failed") logger.debug("这张图的请求缓存没预热成功，宿主那条路可能还会撞 EBUSY");
		return {
			ok: true,
			ref: refs[0],
			warmed: warmed.ok === true
		};
	} catch (e) {
		return {
			ok: false,
			message: "存附件失败：" + (e instanceof Error ? e.message : String(e))
		};
	}
};

/**
 * 一次性调模型（不建会话、不进记忆）：把 system + 一句用户话（可带图）交给指定模型。
 *
 * 用 ctx.llm.stream 而不是 import 宿主的 llm 辅助函数，是为了不依赖内部模块——
 * 那些没有公开契约，换版本就断。
 */
const oneShot = async (ctx, sel, system, userText, images = []) => {
	const llm = ctx.llm;
	if (!llm || typeof llm.stream !== "function") return {
		ok: false,
		reason: "no-llm",
		message: "宿主没有 llm 服务"
	};
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 60000);
	try {
		let text = "";
		const stream = llm.stream({
			provider: sel.provider,
			model: sel.model,
			sessionId: "dsh-pet-extras",
			system,
			messages: [{
				role: "user",
				content: [{ type: "text", text: userText }, ...images.map((attachment) => ({ type: "image", attachment }))]
			}],
			temperature: 0.3,
			signal: controller.signal
		});
		for await (const chunk of stream) {
			// **只收正文，不收思维链。** 宿主的流式 chunk 长这样：
			//   { type: "text-delta" | "reasoning-delta" | "tool-call-delta", index, text }
			// 两者**都**带 `chunk.text`，所以早期那句 `chunk?.delta?.text ?? chunk?.text`
			// 会把 reasoning-delta 一起拼进来——实测气泡里直接冒出「用户要求闲聊，
			// 先对主人反应。画面是他开着一堆窗口……」整段思维草稿，用户一眼就看出不是人话。
			// 判别只认 type；老形状（没有 type 的裸 text 增量）才退回去读字段。
			const type = chunk?.type;
			if (type === "reasoning-delta" || type === "reasoning") continue;
			const delta = type === "text-delta" || type === "text"
				? chunk.text
				: chunk?.delta?.text ?? chunk?.text;
			if (typeof delta === "string") text += delta;
		}
		return {
			ok: true,
			text
		};
	} catch (e) {
		return {
			ok: false,
			reason: "generate-error",
			message: e instanceof Error ? e.message : String(e)
		};
	} finally {
		clearTimeout(timer);
	}
};

/** 学习出来的规则文件：学习流程只能写这里，改不动人格来源 */
const lookRulesPath = () => join(petHomeDir(), "look-rules.txt");

/** 读学习规则（不存在就空串）；超长直接不读，防止被人为灌爆提示词 */
const readLookRules = () => {
	try {
		const maxChars = Math.max(0, Math.min(4000, Number(readConfig().lookRulesMaxChars) || 1200));
		const txt = readFileSync(lookRulesPath(), "utf8").trim();
		if (!txt) return "";
		if (txt.length > maxChars) {
			// 超限不截断——截断会产生半句话，反而更歪；整段拒用并提示
			return "";
		}
		return txt;
	} catch {
		return "";
	}
};

/**
 * 用户要的「用户端写入文件」：把看图播报的规矩也落成一份人可读的文件，
 * 摆在 $DSH_HOME/dsh-pet/ 里，用户能自己打开看、自己改。
 *
 * 这不是运行时的规则来源（运行时用代码里的 LOOK_ASK_PROMPT），
 * 而是一份**给人看的说明书 + 可覆盖入口**：
 *   - 文件不存在：什么都不发生（不影响任何行为）
 *   - 文件存在且非空：作为附加要求拼进提示词末尾
 * 这样用户不必改代码就能加自己的偏好，比如「别老提我耳机」「叫哥哥别叫主人」。
 */
const lookUserRulesPath = () => join(petHomeDir(), "看图播报要求.md");

const readLookUserRules = () => {
	try {
		const txt = readFileSync(lookUserRulesPath(), "utf8").trim();
		if (!txt) return "";
		const maxChars = Math.max(0, Math.min(4000, Number(readConfig().lookRulesMaxChars) || 1200));
		if (txt.length > maxChars) return "";
		return txt;
	} catch {
		return "";
	}
};

/** 第一次启用时把默认说明写出去（已存在就不动，免得覆盖用户自己改的） */
const ensureLookUserRulesFile = () => {
	const file = lookUserRulesPath();
	try {
		if (existsSync(file)) return false;
		mkdirSync(petHomeDir(), { recursive: true });
		writeFileSync(file, [
			"# 桌宠看图播报的要求",
			"",
			"这个文件是给你自己改的。桌宠每次看屏幕之后要说的话，都会带上下面这几条。",
			"",
			"## 现在是这样的",
			"",
			"- 定位是**闲聊**，不是解说：先有反应，不是先报画面。",
			"- 不描述界面元素（按钮、面板、侧栏、进度条这些一律不提）。",
			"- 不解释「这是张什么图」，不总结你在干什么。",
			"- 一句话就把事儿说完，最多两句。",
			"- 认不准就说笼统的，比如「在刷视频」，不许猜错。",
			"",
			"## 想加自己的偏好，直接往下写",
			"",
			"比如：",
			"",
			"- 别老提我耳机",
			"- 叫哥哥，别叫主人",
			"- 晚上十一点以后说话轻一点",
			"",
			"写在这里的规则会附加到提示词末尾。注意：它**改不了**上面那几条定位",
			"（闲聊、不念画面），只能补充措辞和称呼这类细节。",
			"如果这里写太长（超过 lookRulesMaxChars，默认 1200 字）会整段不生效。",
		].join("\n") + "\n", "utf8");
		return true;
	} catch {
		return false;
	}
};

/**
 * 气泡该停多久（毫秒）。
 *
 * dsh-pet 的 broadcast 接口自己有个默认值 10 秒，但那是**一刀切**：三个字和三十个字
 * 停一样久，短句浪费、长句看不完。这里按字数和字形宽度算一个值传过去。
 *
 * 算法：中日韩全角字符按 1 计，换行按 2 计，其余按 0.55 计（英文数字比汉字窄）；
 * 按 5.5 字/秒的阅读速度给，再乘 1.8 倍余量——读得慢的人、扫一眼就能看清。
 * 最后夹在 4 秒到 30 秒之间：少于 4 秒来不及看清，多于 30 秒挡视线。
 */
const bubbleMs = (text) => {
	const s = String(text ?? "");
	let width = 0;
	for (const ch of s) {
		const cp = ch.codePointAt(0);
		if (cp === 10) width += 2;
		else if (cp >= 12288 && cp <= 12351) width += 1;
		else if (cp >= 19968 && cp <= 40959) width += 1;
		else if (cp >= 65280 && cp <= 65519) width += 1;
		else width += 0.55;
	}
	const ms = (width / 5.5) * 1000 * 2.6;
	return Math.min(45000, Math.max(8000, ms));
};

/**
 * 报幕腔检测：模型偶尔还是会憋回说明书体，纯靠提示词管不住。
 *
 * 命中这些开头就是「在描述图」而不是「在跟人说话」——
 * 删掉它，让正文直接从真正的反应开始。删空了就退回一个叹词开头。
 */
const REPORT_OPENERS = [
	// 老版本代码里写死过的那个前缀，模型学得很牢：单独成句、带冒号、带破折号都要吃干净。
	// 之前漏了「看了眼屏幕：xxx」这种写法——旧正则只认不带标点的那几个字，
	// 结果冒号后面那半句原样留在气泡里，用户看到的开头永远是「看了眼屏幕：」。
	/^[\s\u3000]*(我)?(刚|才|又)?(偷偷|悄悄|仔细)?(看|瞄|瞥|扫)(了|了一眼|上)?(一眼|一下)?(屏幕|显示器|桌面)[\s]*[：:，,、。—\-～~]*/,
	// 老版本代码里写死过的前缀，模型也可能自己学出来。
	/^(看了眼?屏幕|偷看了一眼屏幕|偷偷看了眼屏幕|瞄了一眼屏幕|看了一眼屏幕)/,
	// 长模式在前，短的在后——否则「这是[一张]?」会只吃掉「这」，剩个「是一张…」
	/^(这是一张|这是一幅|这是一个|这张图|图片中|图中|画面里|画面中|屏幕上|可以看到|能看出|看起来像|你似乎|主人正在|主人在|同时开着|像是在)/,
	// 「你在看/你正在看/你现在在」后面跟的是内容，不能整句删，只削壳
	/^(你现在|你正在|你在看|你现在在|正在看|正在播放)/,
];

const stripReportOpener = (text) => {
	let body = String(text ?? "").trim();
	for (const re of REPORT_OPENERS) {
		const next = body.replace(re, "").replace(/^[，,、：:]?\s*(是|有|显示着|显示)?\s*/, "").trim();
		if (next !== body) body = next;
	}
	return body;
};

/**
 * 这句话是不是在「描述画面」而不是「跟人说话」。
 *
 * 判据是**信息密度**：一口气点了三个以上画面元素（平台名、谁在干什么、旁边还有什么），
 * 那就是在念画面。人说话不会这么齐整。这类句子清洗不干净，只能整条丢掉。
 */
/**
 * 说明书特征词。**每个词单独计数**——早期把它们塞进同一条正则里，
 * 结果「截图」「画面」同时出现也只算 1 次命中，阈值形同虚设（这个坑踩过一次）。
 */
const DESCRIPTIVE_WORDS = [
	"截图", "界面", "窗口", "页面", "网页版", "画面", "图中",
	"右侧", "左侧", "上方", "下方", "中间", "底部", "顶部",
	"主人在", "你正在", "可以看到", "能看出", "展开着", "显示着", "挂着个", "停着",
	"评论", "弹幕", "进度条", "标题栏", "搜索框", "选项卡",
	"侧栏", "面板", "按钮", "小窗口", "同时开着", "像是在", "显示的是", "录屏", "视频里",
];

/** 命中多少个特征词 */
const descriptiveHits = (text) => DESCRIPTIVE_WORDS.reduce((n, w) => n + (text.includes(w) ? 1 : 0), 0);

/**
 * 阈值：一句话里命中这么多个画面词，才判死（判死 = 这一句不要）。
 *
 * 原先是 2，实测太狠——「你在看抖音，弹幕刷得比你还忙」命中「弹幕」「你在看」两个就被丢了，
 * 可它就是句吐槽。抬到 3 之后，真正念画面的句子照样过不去
 * （「截图 + 画面 + 网页版」三个词同现），而带一个两个画面词的闲聊能留下。
 * 另外 withLookPrefix 另有兜底：全被筛空就整轮不播，宁可不说话也不念图。
 */
const DESCRIPTIVE_LIMIT = 3;

const withLookPrefix = (text) => {
	const raw = String(text ?? "").trim();
	if (!raw) return raw;
	const lines = raw.split(/\n+/).map((s) => s.trim()).filter(Boolean);
	if (lines.length === 0) return raw;

	// 逐句过筛：能留的留下，留下的第一句必须像在说话
	const kept = [];
	for (const line of lines) {
		const cleaned = stripReportOpener(line);
		if (!cleaned) continue;
		// 削完还剩一大串画面元素 → 这是说明书，不是话，直接不要
		if (descriptiveHits(cleaned) >= DESCRIPTIVE_LIMIT) continue;
		kept.push(cleaned);
		if (kept.length >= 2) break;
	}

	if (kept.length === 0) {
		// 一句人话都没有——**不说话**比念一遍画面好。
		// 这里返回空串，调用方会整轮跳过播报（见 watchTick）。
		return "";
	}

	// 以前这里会给「看着干」的句子补一个「瞄了一眼——」「刚看了一眼，」之类的前缀。
	// 用户明确要求开头不要固定格式化，补任何前缀都是在制造第二次格式化，索性去掉：
	// 正文已经是话就直接说；不是话的，在上一步已经被筛掉了。
	return kept.join("\n");
};


/**
 * ===== 视野档案：`$DSH_HOME/dsh-pet/视野/` =====
 *
 * 解决一个矛盾：
 *   会话要「两端一体」（桌宠看见的 = 会话看见的），就必须把图投进会话；
 *   但整屏图每张几百 KB，永久留在历史里，几小时就能把上下文撑爆。
 *
 * 折中办法（主人定的方案）：
 *   - **图照投**，但只在会话里待一轮，之后靠上下文压缩自然淡出；
 *   - **原图 + 会话当时的原始分析**落到这个档案目录里，想查再查，不常驻上下文；
 *   - 平时不读它，只在被问到「昨天下午我在干嘛」这类问题时检索。
 *
 * 为什么存**会话的原始分析**而不是桌宠气泡：气泡是二次加工（可能被过滤删句），
 * 原始分析才是「当时到底看见了什么、怎么理解的」，以后回看才有价值。
 *
 * 目录结构：
 *   视野/index.jsonl          一行一条：时间、图文件、尺寸、体积、会话原始分析
 *   视野/2026-10-24/*.png     原图（按天分目录，方便整目录清理）
 *
 * 容量：**分开管，别一刀切**——
 *   · 图片（视野/YYYY-MM-DD/*.png）：只留最近 VIEW_KEEP_DAYS 天的目录，过期连目录一起删。
 *     图占地方（每张 1MB 上下），而且越久越没用，会话那边自己认 hash。
 *   · 索引（视野/index.jsonl）：**永久保留，永不清理**。一行几百字节，一年也就几百 KB；
 *     它是「当时看见了什么、当时怎么想的」这份记忆的真正载体，删了就真没了。
 *   （原来 sights.jsonl 是整体留 50 条，图和文字一起被砍——所以改成分开管。）
 */
const VIEW_KEEP_DAYS = 7;
const viewsDir = () => join(petHomeDir(), "视野");
const viewsIndexPath = () => join(viewsDir(), "index.jsonl");

/** 读档案索引（只读，永不抛） */
const readViews = (limit = 50) => {
	try {
		const lines = readFileSync(viewsIndexPath(), "utf8").split("\n").filter(Boolean);
		return lines.slice(-Math.max(1, limit)).map((l) => {
			try {
				return JSON.parse(l);
			} catch {
				return null;
			}
		}).filter(Boolean);
	} catch {
		return [];
	}
};

/** 把一天的目录名（YYYY-MM-DD）算出来 */
const dayOf = (d = new Date()) => {
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${y}-${m}-${day}`;
};

/**
 * 存一份到视野档案：原图 + 会话的原始分析。
 *
 * 图是**复制**过去（不是移动）：截图目录要照常滚动删除，档案才是长期的那份。
 * 失败只 warn，绝不影响播报——档案是附加价值，不是主链路。
 */
const archiveView = (file, analysis) => {
	try {
		const now = new Date();
		const day = dayOf(now);
		const dir = join(viewsDir(), day);
		mkdirSync(dir, { recursive: true });
		const name = basename(file);
		const dst = join(dir, name);
		if (file !== dst && !existsSync(dst)) {
			// 原图可能很大（1MB+），但这是本地磁盘，不花钱；要的是「以后能回看」
			writeFileSync(dst, readFileSync(file));
		}
		let size = 0;
		try {
			size = readFileSync(dst).length;
		} catch {}
		const record = {
			at: now.toISOString(),
			day,
			file: name,
			path: join(day, name).replace(/\\/g, "/"),
			bytes: size,
			// 会话当时的原始回答（气泡是它的二次加工，这里存原话）
			analysis: String(analysis ?? "").slice(0, 4000)
		};
		mkdirSync(viewsDir(), { recursive: true });
		appendFileSync(viewsIndexPath(), JSON.stringify(record) + "\n", "utf8");
		pruneViews();
		return { ok: true, record };
	} catch (e) {
		logger.warn("写视野档案失败：" + (e instanceof Error ? e.message : String(e)));
		return { ok: false, message: e instanceof Error ? e.message : String(e) };
	}
};

/** 清掉超过 VIEW_KEEP_DAYS 天的**图片目录**（index.jsonl 是长期记忆，一律不碰） */
const pruneViews = () => {
	try {
		const cutoff = new Date();
		cutoff.setDate(cutoff.getDate() - VIEW_KEEP_DAYS);
		const cutoffDay = dayOf(cutoff);
		for (const name of readdirSync(viewsDir())) {
			// 只认 YYYY-MM-DD 这种目录名，index.jsonl 之类的文件天然被这条挡掉
			if (!/^\d{4}-\d{2}-\d{2}$/.test(name)) continue;
			if (name >= cutoffDay) continue;
			rmSync(join(viewsDir(), name), { recursive: true, force: true });
			logger.debug(`视野档案：清了过期图片目录 ${name}（索引记录保留）`);
		}
	} catch {
		// 清理失败无所谓，下次再来
	}
};

/**
 * ===== 看图播报：走会话，不自己动脑 =====
 *
 * **这是本插件的「基本要求」在看图这条线上的落地。**
 *
 * 以前这里是 describeShot：把截图交给默认模型单独跑一次，用宠物人设生成一句话。
 * 那条链路和主会话毫无关系——桌宠有自己的一套「脑子」，说的不是会话说的，
 * 记忆也不共享，主人要的「两端一体」根本不存在。真正该做的是：
 *
 *   截图 → 投给主会话（等于主人自己贴图）→ 会话按它自己的上下文和记忆回一句
 *        → 这句话显示在气泡里
 *
 * 也就是和聊天走**同一条路**（talkToHostAgent）：同一个目标会话、同一把串行锁、
 * 同一份上下文和记忆。桌宠从头到尾只有眼睛（截图）、嘴（气泡）和耳朵（麦克风）。
 *
 * 画面变没变，用**会话自己上一句回答**比：说得几乎一样就是没什么新东西，
 * 这一轮不开口（也不花第二次 token）。
 */
const LOOK_ASK_PROMPT = [
	"（这是桌宠刚截的屏幕。主人不在跟你汇报，他就是在干活。你不用描述画面，也不用逐条说明。）",
	"你抬头瞄了一眼，然后跟他说句话——一两句，像平时聊天那样。",
	"如果屏幕跟上一轮比没什么变化，回一个字：「没」"
].join("\n");

const buildLookRequest = () => {
	const parts = [LOOK_ASK_PROMPT];
	const learned = readLookRules();
	if (learned) parts.push("【以前复盘学到的（只改措辞，不改你是谁）】\n" + learned);
	const userRules = readLookUserRules();
	if (userRules) parts.push("【主人自己写的要求（照做，但改不了上面的定位）】\n" + userRules);
	return parts.join("\n\n");
};

// 上一轮投图之后会话说了什么 + 投图时刻。用来判「画面变没变」，以及最小间隔。
let lastLookAt = 0;
let lastLookReply = "";
/**
 * 待重试的截图（投递失败时留着，下一轮 tick 优先重试它）。
 *
 * 为什么需要：宿主写附件缓存时偶尔会撞 Windows 文件锁
 * （`EBUSY: resource busy or locked, rename …request-images…tmp`），那一轮直接作废。
 * 没有重试的话，这张图就彻底丢了，要等 20 秒后的下一轮 tick、并且**下一张新图**落下来
 * 才有机会——一次撞锁白扔一个间隔。有了它，撞了只是晚一轮，不丢内容。
 */
let pendingShot = null;
let pendingShotTries = 0;
/** 重试上限：连撞两次说明不是偶发，别再拿同一张图反复烧 token */
const PENDING_SHOT_MAX_TRIES = 2;

/** 目标会话现在到底在不在——只看这个，别先存附件 */
const hostSessionReady = (ctx) => {
	const agents = ctx.agents;
	if (!agents || typeof agents.get !== "function") return false;
	return pickHostSessionFor(ctx, agents, true) !== void 0;
};

/**
 * 看一眼屏幕，让会话说话。
 * @param ctx plugin context
 * @param file 截图绝对路径
 * @param shareGapMs 两次投图之间最短间隔（毫秒），0=不限
 */
const watchTalk = async (ctx, file, shareGapMs) => {
	// 上一轮还在等会话回话：这一轮直接跳过，别插队、别重复占 token
	if (petTurnPending) return { ok: false, reason: "pending" };
	// 间隔按「上一次真正投出去的时刻」算。
	//
	// **不能用 lastAttemptAt**（2026-10-24 实测踩坑）：tick 是每 20 秒一轮，
	// 拿到新图就把它记成「已看过」（watchLastFile），同时占住 lastAttemptAt。
	// 结果下一张新图落下来时，tick 拿到的瞬间距上一轮只有几秒，必然判 too-soon；
	// 等真正过了间隔，tick 又因为「这张图已经看过了」直接返回，永远轮不到它。
	// 日志表现就是这个循环：每 120 秒截一张图，日志里只零星几条 too-soon，
	// 图截了却几乎不投（15:16~15:30 两小时只投出去 1 次）。
	//
	// 现在只看 lastLookAt（上一次**成功拿到回答**的时刻），配合下面的重试机制，
	// 保证「图变了就一定有机会投」。
	if (lastLookAt > 0 && Date.now() - lastLookAt < shareGapMs) return { ok: false, reason: "too-soon" };

	// **先确认有会话，再动图**。
	// shotToAttachment 会把 PNG 读出来、缩放、存进宿主附件库；会话不在时那一步必然白做，
	// 附件还会赖在 cache 里没人认领。查一次 pickHostSessionFor 是纯内存操作，先问它。
	if (!hostSessionReady(ctx)) return { ok: false, reason: "no-session" };

	const att = await shotToAttachment(ctx, file);
	if (!att.ok) return { ok: false, reason: "attach-failed", message: att.message };
	const images = [att.ref];

	const res = await talkToHostAgent(ctx, buildLookRequest(), {
		images,
		// 目标没命中就不投、不注入、不改投别人。聊天可以回落，看图不行。
		strict: true,
		// 投进去的图只是「让会话看见」，不算进「这一轮说了什么」——
		// 否则拿回答去和截图比对，永远判成画面变了。
		excludeImages: true,
		source: { kind: "dsh-pet-sight-image", id: "dsh-pet-extras" }
	});
	if (!res.ok) {
		// 这一轮报错作废（宿主侧 EBUSY 之类的偶发故障）：把截图留着，下一轮重试。
		// 别把「一次撞锁」直接变成「这一张图再也看不见」。
		if (res.reason === "turn-failed") return { ok: false, reason: "turn-failed-retry", message: res.message };
		return res;
	}

	lastLookAt = Date.now();
	// 拿到回答就清掉重试位：这张图的任务完成了，不管它下一句是「没」还是别的。
	pendingShot = null;
	pendingShotTries = 0;
	const text = String(res.text ?? "").trim();
	// 会话自己说「没变化」：记住，画面没动，本轮闭嘴
	if (/^没[。！!.…]*$/u.test(text)) return { ok: false, reason: "same-scene" };
	// 说得和上一轮几乎一样 = 画面没变，这一轮不重复念叨
	if (looksSameScene(lastLookReply, text)) return { ok: false, reason: "same-scene" };
	lastLookReply = text;
	return { ok: true, text };
};

/**
 * 两句话是不是在说同一个画面：去掉标点后比字符重合度，够高就算没变化。
 */
const looksSameScene = (a, b) => {
	const norm = (s) =>
		String(s ?? "")
			.replace(/[\s\p{P}\p{S}]/gu, "")
			.toLowerCase();
	const x = norm(a);
	const y = norm(b);
	if (!x || !y) return false;
	if (x === y) return true;
	const shorter = x.length <= y.length ? x : y;
	const longer = x.length <= y.length ? y : x;
	// 短句太短就判断不了：一句话只有几个字时，随便命中都能凑够比例，
	// 会把「猫头鹰纪录片」和「抖音看猫头鹰纪录片弹幕很热闹」判成同一画面。
	// 拿不准就算「变了」——宁可多说一句，也别让会话觉得一切照旧。
	if (shorter.length < 8) return false;
	const pool = new Map();
	for (const ch of longer) pool.set(ch, (pool.get(ch) ?? 0) + 1);
	let hit = 0;
	for (const ch of shorter) {
		const n = pool.get(ch) ?? 0;
		if (n > 0) {
			hit += 1;
			pool.set(ch, n - 1);
		}
	}
	return hit / shorter.length >= 0.7;
};

/** 一轮检查：截图目录里最新的那张，如果没看过就看一遍。 */
const watchTick = async (ctx) => {
	if (watchBusy) return;
	watchBusy = true;
	try {
		const dir = screenshotsDir();
		let names;
		try {
			names = readdirSync(dir).filter((n) => /\.png$/i.test(n)).sort();
		} catch {
			return;
		}
		if (names.length === 0) return;
		const newest = names[names.length - 1];

		// **重试优先**：上一轮投递失败（宿主 EBUSY 之类）时，先把那张图补投了，
		// 别让新图顶掉它——否则一次偶发故障就吃掉一整个间隔。
		// 重试不消耗新图，也不更新 watchLastFile，新图下一轮照常处理。
		let name = newest;
		let isRetry = false;
		if (pendingShot) {
			if (pendingShotTries >= PENDING_SHOT_MAX_TRIES) {
				logger.warn(`这张图重试 ${pendingShotTries} 次仍失败，放弃了（${pendingShot}）`);
				pendingShot = null;
				pendingShotTries = 0;
			} else {
				name = pendingShot;
				isRetry = true;
			}
		}
		if (!isRetry) {
			if (newest === watchLastFile) return;
			watchLastFile = newest;
		}

		// **看图已经和会话连成一条了**：图投给会话，会话说话，气泡显示它说的话。
		// 原来这里是 describeShot（独立模型调用）+ 注入 + 投图三条路，各自为政；
		// 现在只剩一条：talkToHostAgent（同一个目标会话、同一把锁、同一份上下文）。
		//
		// 屏幕记录**不写进桌宠的 dialogue memory（memory.json）**：
		// 屏幕记录是「我看见了什么」，不是「我们聊过什么」；而它进了会话上下文，
		// 该记的会话自己会记。memory.json 只留给真正聊过的话。
		// 看图**就是**投图，没有「投还是不投」的第二档（旧 sightShareEnabled 已删）。
		// 走到这里说明「看屏幕」开着（合并后就是 screenshotEnabled），那就是要看、要投。
		// 节奏只有一个数（sightShareMinGap）：截屏间隔跟着它走，投图闸也用它。
		// 闸门直接等于间隔，不减余量——以前的 gapSec-2 会把闸门卡得比截图节奏还紧，
		// 加上 tick 是 20 秒一轮，结果就是「图截了却几乎不投」（2026-10-24 实测）。
		const conf = readConfig();
		const gapSec = Math.max(5, Number(conf.sightShareMinGap) || 60);
		const shareGapMs = gapSec * 1000;
		const seen = await watchTalk(ctx, join(dir, name), shareGapMs);
		if (!seen.ok) {
			// 没有可投的会话（刚启动、会话还没开、目标会话没跑）：这不是故障，
			// 是「现在没人听」。只在进入/离开这个状态时各说一次，不然每 20 秒刷一行。
			// 注意：这里只看「逻辑上该不该投」，tick 已经按会话有无停过 helper，
			// 所以能走到这儿说明会话在，no-session 通常是会话刚好在这一瞬间没了。
			if (seen.reason === "no-session" || seen.reason === "target-missing") {
				if (!watchStarved) {
					watchStarved = true;
					logger.debug("没有可投的会话，看图先停着（开一个会话、或把目标会话打开就会自己接上）");
				}
			} else if (seen.reason === "turn-failed-retry") {
				// 这一轮报错作废（宿主写附件撞锁之类）：挂起重试，下一轮 tick 再投一次。
				// 重试次数有上限，连撞两次就放弃并在日志里点名，不让同一张图无限烧 token。
				if (watchStarved) {
					watchStarved = false;
					logger.debug("会话回来了，看图接上");
				}
				if (!isRetry) {
					pendingShot = name;
					pendingShotTries = 1;
				} else pendingShotTries += 1;
				logger.warn(`看图这一轮报错，下一轮重试（第 ${pendingShotTries} 次）：${seen.message ?? ""}`);
			} else {
				if (watchStarved) {
					watchStarved = false;
					logger.debug("会话回来了，看图接上");
				}
				if (seen.reason === "same-scene") logger.debug("画面没变，这一轮不念叨");
				else if (seen.reason === "too-soon" || seen.reason === "pending") logger.debug(`这一轮跳过（${seen.reason}）`);
				else logger.warn(`看图失败（${seen.reason}${seen.message ? "：" + seen.message : ""}）`);
			}
			return;
		}
		if (watchStarved) {
			watchStarved = false;
			logger.debug("会话回来了，看图接上");
		}

		// 这一轮成了（不管它说「没变」还是说了别的）：重试位清空。
		pendingShot = null;
		pendingShotTries = 0;

		// 视野档案：原图 + 会话的**原始分析**（不是气泡，气泡是二次加工）。
		// 平时不进上下文，只在被问到「昨天下午我在干嘛」这类问题时检索。
		archiveView(join(dir, name), seen.text);

		// 播报：会话已经按自己的上下文说完了，这里只负责把它显示出来。
		// 仍然过一遍 withLookPrefix：会话偶尔也会憋出说明书体，那是次要层面的兜底，
		// 过滤**只删不改**——删空了就这一轮闭嘴。
		const line = withLookPrefix(seen.text);
		if (line) {
			logger.debug(`准备播报：${JSON.stringify(line.slice(0, 30))}`);
			const said = await sayPet(ctx, line, void 0, { duration: bubbleMs(line) });
			if (!said) logger.warn(`播报没成功（sayPet 返回 false，可能是 resolvePetBase 拿不到端口或 dsh-pet 拒绝）：${JSON.stringify(line.slice(0, 30))}`);
			else logger.debug("播报已发出");
		} else logger.debug("会话回复是说明书体，本轮不播报");
	} catch (e) {
		logger.warn("看图出错：" + (e instanceof Error ? e.message : String(e)));
	} finally {
		watchBusy = false;
	}
};

/**
 * ===== 自学习（默认关）=====
 *
 * 学什么、不学什么，写死在代码里，不靠自觉：
 *   - **只读** 视野档案 + 用户标记过的评价（本机、自己说过的话）。
 *     不联网、不抓取、不引入任何外部语料——这个函数里没有任何网络请求，
 *     输入只有 readFileSync(viewsIndexPath())。
 *   - **只写** `look-rules.txt`（措辞层）。人格由**主会话**决定，
 *     学习流程拿不到、也改不了它——规则只是附加在请求里的措辞建议，永远排在人格之后。
 *   - 超长整段拒用（readLookRules 里处理），防止反复学习把提示词撑爆。
 *
 * 一句话：它能学「怎么说话更自然」，学不了「自己是谁」。
 */
const LEARN_SYSTEM_PROMPT = [
	"你在帮忙校准一只桌面宠物的说话风格。",
	"下面若干条是它以前对着屏幕说的话，[好评] 是主人认可的，[差评] 是主人觉得像说明书/太干巴的。",
	"请总结出**不超过 6 条**具体的写法规则，帮它以后说得更像真人、更少像汇报。",
	"要求：",
	"- 每条一行，以「- 」开头，不超过 30 字，直接说怎么做，不要解释。",
	"- 只谈措辞和结构（开头怎么写、要不要先给反应、哪些词别用），**不要写任何关于它是谁/性格定位的内容**。",
	"- 不要写「要像个人」「要自然」这种空话。",
	"- 如果样本太少看不出规律，就只输出一行：「（样本不足，暂不更新）」"
].join("\n");

/** 读评价标记：好评/差评存在档案里（rate 字段），这里只做聚合 */
const learnFromSights = async (ctx) => {
	const all = readViews(200);
	const rated = all.filter((s) => s && s.rate === "good" || s && s.rate === "bad");
	// 没标记就退而求其次：拿最近的条目当参考（只说「这些是它说过的话」）
	const pool = rated.length >= 6 ? rated : all.slice(-20);
	if (pool.length < 6) return { ok: false, reason: "too-few", message: `样本不足（${pool.length} 条，至少要 6 条）` };

	const lines = pool.slice(-40).map((s) => {
		const tag = s.rate === "good" ? "[好评] " : s.rate === "bad" ? "[差评] " : "";
		return tag + String(s.text ?? "").replace(/\n+/g, " / ").slice(0, 120);
	});
	const sel = ctx.agentDefaultModel?.currentSelection?.();
	if (!sel?.provider || !sel?.model) return { ok: false, reason: "no-model", message: "没有可用的默认模型" };

	const res = await oneShot(ctx, sel, LEARN_SYSTEM_PROMPT, lines.join("\n"));
	if (!res.ok) return { ok: false, reason: res.reason ?? "llm-error", message: res.message ?? "模型学习失败" };

	let text = String(res.text ?? "").trim();
	if (!text || text.includes("样本不足")) return { ok: false, reason: "not-enough-signal", message: "模型判断样本不足以总结规律" };

	const maxChars = Math.max(0, Math.min(4000, Number(readConfig().lookRulesMaxChars) || 1200));
	if (text.length > maxChars) return {
		ok: false,
		reason: "too-long",
		message: `学出来的规则 ${text.length} 字，超过上限 ${maxChars}，整段拒用（不截断，截断会留半句话）`
	};

	// 防跑偏最后一道：不允许出现「你是谁/你的身份/你其实」这类重定义人格的句子
	if (/(你是谁|你的身份|你其实是|你真正|本质上你是|你被设计成)/.test(text)) {
		return { ok: false, reason: "persona-tamper", message: "学出来的规则试图改写人格，整段拒用" };
	}

	try {
		writeFileSync(lookRulesPath(), text + "\n", "utf8");
	} catch (e) {
		return { ok: false, reason: "write-failed", message: e instanceof Error ? e.message : String(e) };
	}
	return { ok: true, chars: text.length, rules: text, samples: pool.length };
};

/** 给一条档案条目打评价标记（写回 视野/index.jsonl，供学习用） */
const rateSighting = (index, rate) => {
	const all = readViews(1000);
	const target = all[index];
	if (!target || typeof target !== "object") return { ok: false, reason: "not-found" };
	// 按 at+analysis 定位原始行，避免索引错位（readViews 是顺序读的，索引与文件行一一对应）
	const path = viewsIndexPath();
	let raw = "";
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return { ok: false, reason: "no-file" };
	}
	const rows = raw.split("\n").filter(Boolean);
	const wantAt = String(target.at ?? "");
	const wantText = String(target.analysis ?? target.text ?? "").slice(0, 40);
	for (let i = rows.length - 1; i >= 0; i--) {
		try {
			const obj = JSON.parse(rows[i]);
			if (String(obj.at ?? "") === wantAt && String(obj.analysis ?? obj.text ?? "").slice(0, 40) === wantText) {
				obj.rate = rate || void 0;
				rows[i] = JSON.stringify(obj);
				writeFileSync(path, rows.join("\n") + "\n", "utf8");
				return { ok: true, index, rate: rate || null };
			}
		} catch {}
	}
	return { ok: false, reason: "not-found" };
};

/**
 * 附件缓存自清：每小时跑一次，只删「没有任何会话引用的孤儿图」。
 *
 * 为什么需要：DSH 的 `cache/attachments/request-images` 只增不删，桌宠每看一次屏幕
 * 就塞一张整屏图进去（300~500KB）。2026-10-25 实测 633 个文件 / 232MB 里只有 28 个
 * 还被会话引用，605 个是孤儿——不清就是纯占硬盘。
 *
 * 为什么安全：判据是「会话存档里有没有出现过这个 hash」，不是按时间瞎删；
 * 具体保守规则见 attachment-sweep.js 顶部注释（只认裸 hash 文件名、只删 1 小时前的、
 * 收集失败整轮放弃）。
 *
 * 启动后先等 5 分钟再跑第一轮——刚开机时全盘扫一遍会话存档没必要凑在最忙的时候。
 */
let sweepTimer = null;
const ATTACHMENT_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const ATTACHMENT_SWEEP_FIRST_DELAY_MS = 5 * 60 * 1000;

const armAttachmentSweep = () => {
	const run = () => {
		try {
			const r = sweepAttachmentCache({ dshHome: dshHomeDir(), logger });
			if (!r.ok) logger.debug(`附件缓存自清跳过（${r.reason}）`);
			sweepTimer = setTimeout(run, ATTACHMENT_SWEEP_INTERVAL_MS);
			sweepTimer?.unref?.();
		} catch (e) {
			// 清理永远不该拖垮插件
			logger.warn("附件缓存自清出错：" + (e instanceof Error ? e.message : String(e)));
			sweepTimer = setTimeout(run, ATTACHMENT_SWEEP_INTERVAL_MS);
			sweepTimer?.unref?.();
		}
	};
	sweepTimer = setTimeout(run, ATTACHMENT_SWEEP_FIRST_DELAY_MS);
	sweepTimer?.unref?.();
};

/** 看图的调度器：跟着截屏节奏走，截屏关了就停。 */
let watchTimer = null;
/** 上一次是不是因为「没有可投的会话」而停的——只在状态翻转时打日志，别每 20 秒刷一行 */
let watchStarved = false;

const armWatch = (ctx) => {
	ctx.effect(() => {
		const tick = async () => {
			try {
				// 先跟 dsh-pet 对齐：它才是开关的唯一真相。
				// 用户可能在设置页刚关掉截屏，这里必须立刻看到并停手。
				// fresh=true：刚 await 过 refresh，缓存就是最新的。
				// 不带这个参会把 3 秒 TTL 再拦一道，可能拿到旧的 enabled=false，
				// 于是 helper 带着 OFF 起来、勾了定时截屏却不出图（真实踩过）。
				const conf = screenshotSettings(true);
				// 「看屏幕」是一个开关（2026-10-24 合并掉 screenshotWatchEnabled）：
				// 开了就=截屏 + 每张交给主会话，没有「只截不投」这档。
				// 没会话就别截：截了也没人看，白占硬盘、白亮屏。
				const hostReady = conf.enabled ? hostSessionReady(ctx) : true;
				const live = conf.enabled && !hostReady ? { ...conf, enabled: false } : conf;
				const changed = syncShotHelper(live);
				if (changed) logger.debug(`helper 已同步 enabled=${live.enabled} interval=${live.intervalSec} keep=${shotKeep()}`);
				if (conf.enabled) {
					if (hostReady) await watchTick(ctx);
					else if (!watchStarved) {
						watchStarved = true;
						logger.debug("没有可投的会话，截屏和看图都先停着（开一个会话、或把目标会话打开就会自己接上）");
					}
				} else if (watchStarved) {
					watchStarved = false;
					logger.debug("会话回来了，看图接上");
				}
			} catch (e) {
				// 以前这里是空 catch，helper 起不来时日志一片安静，排查只能靠猜。
				logger.warn("看图循环出错：" + (e instanceof Error ? e.message : String(e)));
			}
			watchTimer = setTimeout(() => void tick(), 20000);
			watchTimer?.unref?.();
		};
		watchTimer = setTimeout(() => void tick(), 20000);
		watchTimer?.unref?.();
		return () => {
			if (watchTimer) clearTimeout(watchTimer);
			watchTimer = null;
		};
	}, "dsh-pet-extras: screenshot watch");
};

/**
 * ===== HTTP 路由 =====
 *
 * 前缀 /dsh-pet-extras，与 dsh-pet 的 /dsh-pet-7340 分开，互不干扰。
 * 返回统一是 { ok, ... }，状态码尽量 200（原因写在 body 里）——
 * 调用方是设置页的 fetch，拿到 4xx 只会显示一个数字，不好排查。
 */
const json = (res, status, obj) => {
	res.statusCode = status;
	res.setHeader("content-type", "application/json; charset=utf-8");
	res.setHeader("cache-control", "no-cache, no-store");
	res.end(JSON.stringify(obj));
};

const readBody = (req) => new Promise((resolve) => {
	const chunks = [];
	req.on("data", (c) => chunks.push(c));
	req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
	req.on("error", () => resolve(""));
});

const listShots = () => {
	const dir = screenshotsDir();
	try {
		return readdirSync(dir).filter((n) => /\.png$/i.test(n)).sort().slice(-10).map((n) => {
			const file = join(dir, n);
			let bytes;
			try {
				bytes = fstatSync(openSync(file, "r")).size;
			} catch {
				bytes = void 0;
			}
			return {
				name: n,
				path: file,
				...(bytes === void 0 ? {} : { bytes })
			};
		});
	} catch {
		return [];
	}
};

const handleRoute = async (ctx, req, res) => {
	const url = new URL(req.url ?? "/", "http://127.0.0.1");
	const rest = url.pathname.replace(ROUTE_PREFIX, "").replace(/^\//, "");
	const method = req.method ?? "GET";

	// 探针：确认插件活着
	if (rest === "" || rest === "ping") return json(res, 200, {
		ok: true,
		plugin: name,
		version: "0.1.0",
		home: dshHomeDir()
	});

	// 配置：GET 读、PUT 写（body 是部分字段的 patch）
	if (rest === "config") {
		if (method === "GET") return json(res, 200, { ok: true, config: scrubConfig(readConfig()), defaults: DEFAULT_CONFIG });
		if (method === "PUT" || method === "POST") {
			let parsed = {};
			try {
				parsed = JSON.parse((await readBody(req)) || "{}");
			} catch {
				return json(res, 400, { ok: false, error: "invalid JSON body" });
			}
			const saved = writeConfig(parsed);
			// 配置一变就让后台进程跟上：关掉就杀、间隔变了就重启。
			// 不这么做的话，已经跑起来的 helper 会带着旧定时器一直截下去。
			syncShotHelper(screenshotSettings());
			return json(res, 200, { ok: true, config: saved });
		}
		return json(res, 405, { ok: false, error: "method not allowed" });
	}

	// 截屏：GET 列表 + 状态，POST 立刻抓一张
	if (rest === "screenshot") {
		if (method === "POST") {
			// 抓图前先拉一次最新配置：用户刚在设置页打开截屏、马上点「立刻抓一张」时，
			// 缓存里可能还是旧的 false，helper 会带着 OFF 起来（真实踩过）。
		}
		const settings = screenshotSettings(true);
		if (method !== "POST") return json(res, 200, {
			ok: true,
			enabled: settings.enabled,
			intervalSec: settings.intervalSec,
			dir: screenshotsDir(),
			endpoint: shotChannel.endpoint ?? null,
			recent: listShots()
		});
		ensureShotHelper(settings);
		// 端口要等 helper 起来才上报，最多等 10 秒
		for (let i = 0; i < 40 && !shotChannel.endpoint; i++) await new Promise((r) => setTimeout(r, 250));
		const shot = await captureShot();
		if (!shot || shot.ok !== true) return json(res, 200, {
			ok: false,
			reason: shot?.reason ?? "shot-failed",
			message: shot?.message ?? "抓图失败"
		});
		return json(res, 200, {
			ok: true,
			file: shot.file,
			bytes: shot.bytes,
			width: shot.width,
			height: shot.height,
			enabled: settings.enabled,
			intervalSec: settings.intervalSec
		});
	}

	// 接智能体：GET 状态、POST 指定会话、带 text 就直接投递一句话
	if (rest === "agent") {
		if (method === "GET") {
			return json(res, 200, { ok: true, ...agentBridgeInfo(ctx) });
		}
		if (method === "POST" || method === "PUT") {
			let parsed = {};
			try {
				parsed = JSON.parse((await readBody(req)) || "{}");
			} catch {
				return json(res, 400, { ok: false, error: "invalid JSON body" });
			}
			if (typeof parsed.text === "string" && parsed.text.trim()) {
				const text = parsed.text.trim();
				// async:true —— 投递出去就返回，不占着 HTTP 连接等回复。
				// 目标会话忙的时候排队可能要好几分钟，同步等会让调用方（桌宠气泡、客户端 fetch）一直挂着，
				// 看起来像卡死；异步模式下结果走日志 + 桌宠气泡，接口立刻回 { ok:true, queued:true }。
				if (parsed.async === true) {
					void (async () => {
						try {
							const bridged = await talkToHostAgent(ctx, text);
							if (bridged.ok) {
								logger.debug(`[agent] 后台投递完成（${bridged.sessionId ?? "-"}）：${String(bridged.text).slice(0, 200)}`);
								await sayPet(ctx, bridged.text, void 0, { duration: bubbleMs(bridged.text) });
							} else {
								logger.warn(`[agent] 后台投递失败（${bridged.reason}）：${bridged.message ?? ""}`);
							}
						} catch (e) {
							logger.warn("[agent] 后台投递异常：" + (e instanceof Error ? e.message : String(e)));
						}
					})();
					return json(res, 200, { ok: true, queued: true, mode: "async" });
				}
				const bridged = await talkToHostAgent(ctx, text);
				return json(res, 200, bridged);
			}
			// 精确 id 优先（设置页下拉传的就是 id），其次才是老的标题字段。
			const wantedId = typeof parsed.targetSessionId === "string" ? parsed.targetSessionId.trim() : "";
			const wantedTitle = typeof parsed.sessionId === "string" ? parsed.sessionId.trim() : "";
			const key = wantedId || wantedTitle;
			const list = key ? listHostSessions(ctx, ctx.agents) : [];
			const hit = key ? list.find((x) => x.id === key || x.title === key) : void 0;
			// 下拉里选的是 id，但用户可能选完才关掉那条会话——id 形状合法就照存，
			// 别让「会话先关了」变成保存失败。投递那边会自己报 missing 并拒绝投，
			// 不会因为存了个关掉的 id 就偷偷改投别人。
			const idShaped = wantedId.startsWith("session-");
			if (key && !hit && !idShaped) {
				return json(res, 400, {
					ok: false,
					error: "target-not-found",
					message: `找不到会话「${key}」：它现在不在运行中的会话列表里（可能已经关掉了）。`,
					available: list
				});
			}
			if (hit) writeConfig({ targetSessionId: hit.id, agentBridgeTarget: hit.title });
			else if (idShaped) writeConfig({ targetSessionId: wantedId });
			else writeConfig({ targetSessionId: "", agentBridgeTarget: "" });
			return json(res, 200, { ok: true, ...agentBridgeInfo(ctx) });
		}
		return json(res, 405, { ok: false, error: "method not allowed" });
	}

	// 屏幕限制：GET 读当前状态，PUT/POST 写并立刻下发
	if (rest === "confine") {
		if (method === "GET") {
			const conf = readConfig();
			const live = await readPetConfig(ctx);
			return json(res, 200, {
				ok: true,
				want: conf.confineToScreen === true,
				live: live ? live.confineToScreen === true : null
			});
		}
		if (method === "PUT" || method === "POST") {
			let parsed = {};
			try {
				parsed = JSON.parse((await readBody(req)) || "{}");
			} catch {
				return json(res, 400, { ok: false, error: "invalid JSON body" });
			}
			if (typeof parsed.value !== "boolean") return json(res, 400, { ok: false, error: "value 必须是 true / false" });
			const saved = writeConfig({ confineToScreen: parsed.value });
			const pushed = await pushConfineToScreen(ctx, parsed.value);
			return json(res, 200, { ok: true, want: saved.confineToScreen === true, push: pushed });
		}
		return json(res, 405, { ok: false, error: "method not allowed" });
	}

	/**
	 * 投图最短间隔：GET 读，PUT/POST 写。
	 *
	 * 为什么单独开一个接口：这个值只存在于本插件的配置里，dsh-pet 本体没有它，
	 * 所以设置页画出来的那个数字框得由我们接住（跟 confine 同一套路）。
	 * 只改自己的配置，不往 dsh-pet 推——它不需要知道。
	 *
	 * （2026-10-24：这里原来是「投图开关 + 间隔」两个字段。开关删了——
	 * 看图就是投图，关掉开关只会变成「发一句话不带图」，主会话拿着话看不见屏幕。
	 * 现在只剩间隔，`enabled` 保留在响应里恒为 true，是为了让旧版 dsh-pet 的设置页
	 * 不至于因为读不到字段而崩，升级后就不再读它了。）
	 */
	if (rest === "sight-share") {
		if (method === "GET") {
			const conf = readConfig();
			return json(res, 200, {
				ok: true,
				enabled: true,
				minGapSec: Math.max(0, Number(conf.sightShareMinGap) || 0)
			});
		}
		if (method === "PUT" || method === "POST") {
			let parsed = {};
			try {
				parsed = JSON.parse((await readBody(req)) || "{}");
			} catch {
				return json(res, 400, { ok: false, error: "invalid JSON body" });
			}
			// 只认 minGapSec；老调用方还会带 value（布尔），忽略即可，不报错。
			if (parsed.minGapSec === undefined) return json(res, 400, { ok: false, error: "缺少 minGapSec（只接受这一个字段）" });
			// 非法值直接拒，别悄悄改成默认值——那样用户会以为是 bug。
			const gap = Number(parsed.minGapSec);
			if (!Number.isFinite(gap) || gap < 0) return json(res, 400, { ok: false, error: "minGapSec 必须是不小于 0 的数字" });
			// 顺手把老版本留下的 `sightShareEnabled` 从配置文件里清掉：它已经没有任何代码读了，
			// 留着会让人以为「这儿还有个开关」。语义上「要不要看屏幕」现在由 screenshotEnabled 表达。
			const saved = scrubConfig(writeConfig({ sightShareMinGap: gap }));
			logger.info(`投图最短间隔：${saved.sightShareMinGap} 秒`);
			return json(res, 200, {
				ok: true,
				enabled: true,
				minGapSec: Math.max(0, Number(saved.sightShareMinGap) || 0)
			});
		}
		return json(res, 405, { ok: false, error: "method not allowed" });
	}

	/**
	 * 视野档案：GET /sights?limit=N 取最近 N 条（含原始分析和图路径），DELETE /sights 清空索引。
	 *
	 * 给「没有记忆系统」的用户留的出口——任何外部工具都能来取，
	 * 不依赖 mnemon / MEMORY.md 那套。路径保持 `/sights` 是为了不破坏已有调用方。
	 */
	if (rest === "sights") {
		if (method === "GET") {
			const limit = Math.max(1, Math.min(500, Number(url.searchParams.get("limit")) || 50));
			return json(res, 200, {
				ok: true,
				path: viewsIndexPath(),
				dir: viewsDir(),
				// 索引永久保留（长期记忆），所以这里是**全部**记录条数，不是近 500 条
				total: readViews(1e9).length,
				items: readViews(limit),
				learned: readLookRules() || null,
				learnEnabled: readConfig().lookLearnEnabled === true
			});
		}
		if (method === "DELETE") {
			// 只清索引，图文件留着（图是真数据，删了没法恢复；要清图请手动删目录）
			try {
				writeFileSync(viewsIndexPath(), "", "utf8");
			} catch {}
			return json(res, 200, { ok: true, cleared: true, note: "只清了索引，原图仍在" + viewsDir() });
		}
		return json(res, 405, { ok: false, error: "method not allowed" });
	}

	// POST /rate { index, rate: "good"|"bad"|"" } —— 给某条播报打评价，供自学习参考
	if (rest === "rate") {
		if (method !== "POST") return json(res, 405, { ok: false, error: "method not allowed" });
		let body = {};
		try {
			body = JSON.parse(await readBody(req)) ?? {};
		} catch {
			return json(res, 400, { ok: false, error: "invalid JSON body" });
		}
		const rate = body.rate === "good" || body.rate === "bad" ? body.rate : "";
		const result = rateSighting(Number(body.index), rate);
		return json(res, result.ok ? 200 : 400, result);
	}

	// 手动催一轮看图：不等定时器。只用于验证/排查，不会改任何配置。
	if (rest === "look") {
		if (method !== "POST") return json(res, 405, { ok: false, error: "method not allowed" });
		const started = Date.now();
		await watchTick(ctx);
		return json(res, 200, {
			ok: true,
			elapsedMs: Date.now() - started,
			// 看图现在由**主会话**开口，人设就是那条会话的人设——不再有第二套人格来源
			personaSource: "host-session",
			lastSight: readViews(1)[0] ?? null
		});
	}

	if (rest === "learn") {
		if (method === "GET") {
			return json(res, 200, {
				ok: true,
				enabled: readConfig().lookLearnEnabled === true,
				rules: readLookRules() || null,
				path: lookRulesPath(),
				maxChars: readConfig().lookRulesMaxChars
			});
		}
		if (method !== "POST") return json(res, 405, { ok: false, error: "method not allowed" });
		if (readConfig().lookLearnEnabled !== true) {
			return json(res, 200, { ok: false, reason: "disabled", message: "自学习没开（配置 lookLearnEnabled = false）。这是默认值，开它之前请先看 README 的隐私说明。" });
		}
		const result = await learnFromSights(ctx);
		if (!result.ok) logger.warn(`自学习失败（${result.reason}）：${result.message}`);
		else logger.debug(`自学习完成，写入 ${result.chars} 字，样本 ${result.samples} 条`);
		return json(res, 200, result);
	}

	return json(res, 404, {
		ok: false,
		error: `dsh-pet-extras: 不认识的路径 /${rest}`
	});
};

export function apply(ctx) {
	logger.debug(`loaded, home=${dshHomeDir()}`);

	ctx.effect(() => ctx.webServer.register({
		kind: "prefix",
		path: ROUTE_PREFIX,
		handler: (req, res) => {
			void handleRoute(ctx, req, res).catch((e) => {
				try {
					json(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) });
				} catch {}
			});
		}
	}), "dsh-pet-extras: routes");

	armWatch(ctx);
	armAttachmentSweep();

	// 第一次加载时把「看图播报要求.md」写出去，让用户能自己看、自己加偏好。
	// 已存在就不覆盖——那是用户改过的文件，不能被插件重置。
	if (ensureLookUserRulesFile()) logger.debug(`已生成 ${lookUserRulesPath()}`);

	// 启动时把屏幕限制同步给 dsh-pet。
	// 延后 3 秒：dsh-pet 的路由是同一批插件的 effect 里注册的，加载期立刻请求可能还没起来。
	// 只用 setTimeout 不挂 ctx.effect：这是「尽力而为的一次下发」，插件卸载时没必要取消。
	const confineTimer = setTimeout(() => {
		const conf = readConfig();
		void pushConfineToScreen(ctx, conf.confineToScreen === true).then((r) => {
			if (r.ok === false && r.reason !== "pet-unavailable") logger.warn(`屏幕限制下发失败：${r.reason}`);
		});
	}, 3000);
	confineTimer?.unref?.();

	// 老版本留在配置文件里的废弃键，启动时擦一次（GET /config 也会擦，这里保证没人调用接口时也干净）。
	scrubConfig(readConfig());

	// ===== dsh-pet 工作状态补丁（按版本触发，不是每次都跑）=====
	//
	// 起因：dsh-pet 投递消息的 source 是 { kind: "user", id: "dsh-pet-<ts>" }，
	// 跟主人手敲在结构上一样，宿主认不出来，于是桌宠对话时头顶会冒「思考中/工具调用」。
	// 修法在 dsh-pet 自己的 reduceWorkStatus 附近，但它是 npm 第三方包、没有 git，
	// 改了下一次更新就没了。而本插件是本地目录，不随 npm 更新——所以修复放这儿。
	//
	// 只在「dsh-pet 版本号变了」时动手：版本没变就直接返回，连它的源码都不读。
	// 注意：改的是磁盘上的源码，**下次启动 dsh-pet 才生效**，当次不会热生效。
	const patchStatePath = () => join(petHomeDir(), "extras-state.json");
	const readPatchState = () => {
		try {
			const raw = readFileSync(patchStatePath(), "utf8");
			const obj = JSON.parse(raw);
			return obj && typeof obj === "object" ? obj.petWorkStatusPatch ?? null : null;
		} catch {
			return null;
		}
	};
	const savePatchState = (next) => {
		try {
			mkdirSync(petHomeDir(), { recursive: true });
			let obj = {};
			try {
				obj = JSON.parse(readFileSync(patchStatePath(), "utf8")) ?? {};
			} catch {}
			if (!obj || typeof obj !== "object") obj = {};
			obj.petWorkStatusPatch = next;
			writeFileSync(patchStatePath(), JSON.stringify(obj, null, 2), "utf8");
		} catch (e) {
			logger.warn(`记不下工作状态补丁状态：${e instanceof Error ? e.message : String(e)}`);
		}
	};
	try {
		const patchResult = ensurePetWorkStatusPatch(readPatchState(), savePatchState, (msg) => logger.info(msg));
		if (patchResult?.ok === false && patchResult.skipped !== true) {
			logger.warn(`工作状态补丁未生效：${patchResult.reason}`);
		}
	} catch (e) {
		// 补丁器自身崩了也不能拖垮插件：它只是锦上添花。
		logger.warn(`工作状态补丁异常：${e instanceof Error ? e.message : String(e)}`);
	}
}
