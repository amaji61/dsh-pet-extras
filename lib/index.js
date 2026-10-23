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

import { appendFileSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
	/** 定时截屏总开关（只有桌面模式有用） */
	screenshotEnabled: false,
	/** 截屏间隔秒数（最小 5） */
	screenshotIntervalSec: 20,
	/** 看到新截图就交给模型分析（每张图都调一次模型，关掉就是省钱） */
	screenshotWatchEnabled: false,
	/** 把桌宠的话投递给主会话 */
	agentBridgeEnabled: false,
	/** 固定接哪条会话：填会话 id 或标题，空 = 自动挑用得最久的那条 */
	agentBridgeTarget: "",
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
	 * 把看图结论静默注入主会话（agent.inject，不唤醒、不占界面）。
	 *
	 * 开着的意义：主会话真的「知道」屏幕在发生什么，之后你问起我不用现查。
	 * 关着的意义：只在桌宠气泡里说一句，不污染上下文。
	 */
	sightingInject: true,
	/** sights.jsonl 保留最近多少条（滚动删除最旧的，防止无限增长） */
	sightingKeep: 200,
	/**
	 * 允许看图播报自学习（默认关）。
	 *
	 * 学什么：只复盘 `sights.jsonl` 里**自己和主人说过的话**，总结「哪句像说明书、哪句像人话」，
	 * 写回 `look-rules.txt`。不联网、不读外部语料——这一点写进代码而不是写进文档，是怕哪天被改掉。
	 *
	 * 为什么默认关：每跑一次要额外的模型调用（花钱），而且学歪了不容易马上发现。
	 */
	lookLearnEnabled: false,
	/** 学出来的规则最多多少字（超过就拒绝写入，防止反复「学习」把提示词撑爆、性格跑偏） */
	lookRulesMaxChars: 1200,
	/** 追加在提示词后面的自定义人格补充（空 = 不加）。学习写的是 look-rules.txt，不是这里 */
	lookRulesExtra: ""
};

const readConfig = () => {
	try {
		const raw = JSON.parse(readFileSync(configPath(), "utf8"));
		return { ...DEFAULT_CONFIG, ...(raw && typeof raw === "object" ? raw : {}) };
	} catch {
		return { ...DEFAULT_CONFIG };
	}
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
 * 截屏相关配置。
 *
 * **开关以 dsh-pet 的配置为准**：这些开关在设置页上（桌宠全局卡片），用户在那边关掉，
 * 这里就必须跟着关。插件自己再存一份的话，两边永远对不上——踩过：设置页显示没开，
 * 插件后台还在每 8 秒截一张。
 *
 * 插件自己只保留 dsh-pet 里没有的两项（看图分析、接智能体），见 readLocalSettings()。
 * dsh-pet 读不到时回落到插件本地值，保证「没装桌宠也能单独跑截屏」。
 */
let petConfCache = {
	at: 0,
	value: null
};
const PET_CONF_TTL_MS = 3000;

/** 近 3 秒内读过的 dsh-pet 配置（同步版，供非 async 场景）。 */
const petConfSnapshot = () => petConfCache.value;

const screenshotSettings = () => {
	const pet = petConfSnapshot();
	const local = readConfig();
	const src = pet ?? local;
	const raw = Number(src.screenshotIntervalSec);
	return {
		enabled: src.screenshotEnabled === true,
		intervalSec: Number.isFinite(raw) && raw > 0 ? Math.max(5, Math.floor(raw)) : 20
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
	let said = false;
	try {
		const res = await fetch(`${base}/dsh-pet-7340/broadcast`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body)
		});
		said = res.ok;
	} catch {
		return false;
	}
	// 动作放在播报之后发：broadcast 先把气泡写出来，anim 再叠上去，
	// 顺序反了两个事件在同一拍到达，客户端可能先播动作再显示气泡，观感别扭。
	if (said && extra?.action) {
		try {
			await fetch(`${base}/dsh-pet-7340/anim`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ name: extra.action })
			});
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
 * 从 dsh-pet 读开关状态并刷新缓存。
 *
 * 这是「以 dsh-pet 配置为准」的实现核心：用户在设置页关掉定时截屏，
 * 下一轮定时循环就能看到并停下。缓存 3 秒，避免 20 秒一次的死循环里
 * 每帧都打一次 HTTP（也避免用户看设置页时被自己的请求刷屏）。
 */
const refreshPetConf = async (ctx) => {
	if (!ctx) return;
	const now = Date.now();
	if (now - petConfCache.at < PET_CONF_TTL_MS && petConfCache.value) return petConfCache.value;
	const base = resolvePetBase(ctx);
	if (!base) return null;
	try {
		const res = await fetch(`${base}/dsh-pet-7340/config`, { headers: { "cache-control": "no-cache" } });
		if (!res.ok) return null;
		const body = await res.json();
		const main = body && typeof body === "object" ? body.main ?? body : null;
		if (!main || typeof main !== "object") return null;
		petConfCache = {
			at: now,
			value: {
				screenshotEnabled: main.screenshotEnabled === true,
				screenshotIntervalSec: main.screenshotIntervalSec,
				screenshotWatchEnabled: main.screenshotWatchEnabled === true,
				agentBridgeEnabled: main.agentBridgeEnabled === true,
				agentBridgeTarget: typeof main.agentBridgeTarget === "string" ? main.agentBridgeTarget : ""
			}
		};
		return petConfCache.value;
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
/**
 * 把截屏相关的键推给 dsh-pet（设置页读的是它那份配置）。
 *
 * 为什么要双向同步：dsh-pet 设置页里也有「定时截屏」「截屏间隔」「定时看图」
 * 三个控件，而插件有自己的 extras-config.json。只写一边，用户就会看到
 * 「设置页显示关着、插件却在截」这种分裂状态——上一轮真踩过。
 *
 * 策略：以用户最后一次操作为准。用户从插件接口改，就推给 dsh-pet；
 * 用户在设置页改，armWatch 每轮 refreshPetConf 会把它的值读回来。
 * 只推三个存在的键，dsh-pet 那边有没有别的键无关。
 */
const pushScreenshotConf = async (ctx, patch) => {
	const keys = ["screenshotEnabled", "screenshotIntervalSec", "screenshotWatchEnabled"];
	const wanted = {};
	let any = false;
	for (const k of keys) {
		if (patch && Object.hasOwn(patch, k)) {
			wanted[k] = patch[k];
			any = true;
		}
	}
	if (!any) return { ok: true, changed: false };
	const current = await readPetConfig(ctx);
	if (!current) return { ok: false, reason: "pet-unavailable" };
	if (!Array.isArray(current.pets) || current.pets.length === 0) return { ok: false, reason: "pets-missing" };
	// 已经一致就别写——PUT 会触发 dsh-pet 重载配置，能不写就不写
	const same = keys.every((k) => !Object.hasOwn(wanted, k) || current[k] === wanted[k]);
	if (same) return { ok: true, changed: false };
	const base = resolvePetBase(ctx);
	if (!base) return { ok: false, reason: "pet-unavailable" };
	try {
		const res = await fetch(`${base}/dsh-pet-7340/config`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ ...current, ...wanted })
		});
		if (!res.ok) return { ok: false, reason: `http-${res.status}` };
		// 推完立刻作废缓存，不然 armWatch 下一轮还读旧值
		petConfCache = { at: 0, value: void 0 };
		return { ok: true, changed: true };
	} catch (e) {
		return { ok: false, reason: e instanceof Error ? e.message : String(e) };
	}
};

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
 * 把 agentBridgeTarget 推给 dsh-pet 的配置。
 *
 * 跟 confineToScreen 同一套路：以 dsh-pet 为准，所以我们这边改了要同步过去，
 * 不然设置页那个输入框会和实际行为对不上。
 *
 * 注意：PUT 的 body **必须带完整 pets 数组**，只传 agentBridgeTarget 会被
 * 400 invalid pet config 拒掉（dsh-pet 里 outConfig = { pets: out } 是硬性的）。
 */
const pushAgentTarget = async (ctx, want) => {
	const current = await readPetConfig(ctx);
	if (!current) return { ok: false, reason: "pet-unavailable" };
	if (!Array.isArray(current.pets) || current.pets.length === 0) return { ok: false, reason: "pets-missing" };
	const base = resolvePetBase(ctx);
	if (!base) return { ok: false, reason: "pet-unavailable" };
	try {
		const res = await fetch(`${base}/dsh-pet-7340/config`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ ...current, agentBridgeTarget: want })
		});
		if (!res.ok) return { ok: false, reason: `http-${res.status}` };
		return { ok: true };
	} catch (e) {
		return { ok: false, reason: e instanceof Error ? e.message : String(e) };
	}
};

/** 读桌宠记忆（格式：{ <entry>: { <petId>: { messages: [...] } } }）。 */
const readMemory = () => {
	try {
		const mem = JSON.parse(readFileSync(memoryPath(), "utf8"));
		return mem && typeof mem === "object" ? mem : {};
	} catch {
		return {};
	}
};

/** 写回桌宠记忆。 */
const writeMemory = (mem) => {
	try {
		mkdirSync(petHomeDir(), { recursive: true });
		writeFileSync(memoryPath(), JSON.stringify(mem, null, 2), "utf8");
		return true;
	} catch (e) {
		logger.warn("写记忆失败：" + (e instanceof Error ? e.message : String(e)));
		return false;
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
const electronExecutable = () => join(dshHomeDir(), "electron", process.platform === "win32" ? "electron.exe" : "electron");

/** 拉起桌面 Helper 子进程（幂等）。 */
const ensureShotHelper = () => {
	if (shotChannel.child) return true;
	const electronPath = electronExecutable();
	if (!existsSync(electronPath)) {
		logger.warn(`没有桌面运行时 ${electronPath}，截屏不可用（装上 dsh-pet 会自动下载）`);
		return false;
	}
	const helperEntry = ownHelperEntry();
	if (!existsSync(helperEntry)) {
		logger.warn(`找不到桌面 Helper 入口 ${helperEntry}，截屏不可用`);
		return false;
	}
	const settings = screenshotSettings();
	try {
		const env = { ...process.env };
		// 本会话的父进程环境可能带 ELECTRON_RUN_AS_NODE=1；带着它启动 Electron 会变成
		// 「纯 Node 模式」，desktopCapturer 全废。必须删掉。
		delete env.ELECTRON_RUN_AS_NODE;
		env.DSH_PET_EXTRAS_SHOT_ENABLED = settings.enabled ? "1" : "0";
		env.DSH_PET_EXTRAS_SHOT_INTERVAL = String(settings.intervalSec);
		env.DSH_PET_EXTRAS_SHOT_DIR = screenshotsDir();
		env.DSH_PET_EXTRAS_SHOT_KEEP = String(Math.max(1, Math.min(2000, Number(readConfig().screenshotKeep) || 60)));
		// 记下这次用的是哪份设置，stopShotHelper 判断要不要重启时对比用。
		shotChannel.enabled = settings.enabled;
		shotChannel.intervalSec = settings.intervalSec;
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
 * 让 helper 与配置保持一致：关着就确保进程不在，开着且参数变了就重启。
 * 返回是否做了变更。
 */
const syncShotHelper = () => {
	const settings = screenshotSettings();
	const running = shotChannel.child !== void 0;
	if (!settings.enabled) {
		// 关着：进程不该存在。杀掉即可（不重启）。
		if (running) return stopShotHelper();
		return false;
	}
	// 开着：没跑就起；跑着但间隔变了就重启，让它吃新环境变量。
	if (!running) {
		ensureShotHelper();
		return true;
	}
	if (shotChannel.intervalSec !== settings.intervalSec || shotChannel.keep !== shotKeep()) {
		stopShotHelper(true);
		// 让旧进程先退干净，避免端口/实例抢占
		setTimeout(() => ensureShotHelper(), 600);
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

/** 挑主会话：配置指定的优先（id 或标题都认），否则挑 seq 最大的（= 用得最久的那条）。
 *  注意参数顺序是 (ctx, agents)——曾经有一处调用写成 (agents, ctx)，导致 agents.roots
 *  读不到、报 `cannot get property "roots" without inject`，看图结论一直注不进主会话。 */
const pickHostSession = (ctx, agents) => {
	// 目标会话跟开关一样，以 dsh-pet 配置为准（设置页那个输入框）；本地值只是兜底
	const wanted = String(petConfSnapshot()?.agentBridgeTarget ?? readConfig().agentBridgeTarget ?? "").trim();
	const roots = typeof agents.roots === "function" ? agents.roots() : agents.list() ?? [];
	if (wanted) {
		const hit = typeof agents.get === "function" ? agents.get(wanted) : void 0;
		if (hit) return hit;
		const byTitle = roots.find((a) => {
			const s = sessionOf(a);
			if (!s || String(s.id).startsWith(PET_AGENT_PREFIX)) return false;
			return titleOfSession(ctx, s) === wanted;
		});
		if (byTitle) return byTitle;
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
	return best;
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
 * 把桌宠的话投给主会话，等它答完，返回 assistant 的文字。
 * images 是 ImageAttachmentRef 数组，直接拼成 image block 交给模型。
 */
const talkToHostAgent = async (ctx, text, images = []) => {
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
	const host = pickHostSession(ctx, agents);
	const session = host ? sessionOf(host) : void 0;
	if (!session) return {
		ok: false,
		reason: "no-agent",
		message: "现在没有正在运行的界面会话，先在界面里开一个对话再来找我"
	};
	return withTurnLock(session.id, async () => {
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
		const host2 = pickHostSession(ctx, agents);
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
				source: { kind: "user", id: `dsh-pet-extras-${Date.now()}` }
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
		const live = sessionOf(host2);
		const limit = live?.seq ?? beforeSeq;
		let turnStart = beforeSeq;
		for (let seq = beforeSeq; seq < limit; seq++) {
			const ev = live.eventAt(seq);
			if (!ev || ev.type !== "user/message") continue;
			const blocks = ev.data?.content;
			if (!Array.isArray(blocks)) continue;
			if (blocks.some((b) => b && b.type === "text" && typeof b.text === "string" && b.text.startsWith(PET_MSG_FENCE))) {
				turnStart = seq;
				break;
			}
		}
		let reply = "";
		const pics = [];
		for (let seq = turnStart; seq < limit; seq++) {
			const ev = live.eventAt(seq);
			if (!ev || ev.type !== "assistant/message") continue;
			const content = ev.data?.message?.content;
			if (!Array.isArray(content)) continue;
			for (const block of content) {
				if (!block) continue;
				if (block.type === "text" && typeof block.text === "string" && block.text.trim()) reply += (reply ? "\n\n" : "") + block.text.trim();
				else if (block.type === "image" && block.attachment) pics.push(block.attachment);
			}
		}
		if (!reply && pics.length === 0) return {
			ok: false,
			reason: "empty-reply",
			message: "这一轮没有输出文字"
		};
		return {
			ok: true,
			text: reply || "（只回了图片）",
			...pics.length > 0 ? { images: pics } : {},
			sessionId: live.id
		};
	});
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
	// 开关以 dsh-pet 为准（refreshPetConf 已刷新过缓存），本地只留兜底
	const pet = petConfSnapshot();
	const conf = readConfig();
	return {
		available: true,
		configured: String((pet?.agentBridgeTarget ?? conf.agentBridgeTarget) ?? "").trim(),
		enabled: pet ? pet.agentBridgeEnabled === true : conf.agentBridgeEnabled === true,
		mode: "same-session-serial",
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
	try {
		const refs = await store.saveImages([{
			data: new Uint8Array(buf),
			mediaType: "image/png",
			name: file.split(/[\\/]/).pop()
		}]);
		if (!refs || refs.length === 0) return {
			ok: false,
			message: "附件服务没有接收这张图"
		};
		return {
			ok: true,
			ref: refs[0]
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
			// 只关心文本增量；不同版本的 chunk 形状略有差异，尽量宽容地取。
			const delta = chunk?.delta?.text ?? chunk?.text;
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

/**
 * 看图角色提示词。
 *
 * 设计要点（每一条都是踩过坑才加的）：
 * 1. **不能只让它描述**——只描述就变成 OCR + 画面复述，主人听两句就腻。要它带一点反应和看法。
 * 2. **不能瞎猜平台/来源**——实测把抖音认成 B 站（两边都是深色+弹幕，确实像）。
 *    所以明确要求：看不清就别点名，说「在刷短视频」比说错强。
 * 3. **不能一上来就报幕**——内容以「我看到/你又在」这种自然开头，别写「屏幕上是……」这种说明书腔。
 * 4. **口吻要像宠物在旁边瞄了一眼**：可以有情绪、可以损两句、可以撒娇，但不能编事实。
 * 5. 长度卡死在两小句：桌宠头顶气泡一次只显示一句，太长看不清（这条吃过亏）。
 */
const LOOK_SYSTEM_PROMPT = [
	"你是主人养的一只小宠物，正趴在他屏幕边上，偶尔抬头瞄一眼他在干什么。",
	"",
	"【最重要的一条：不要汇报】",
	"你不是在描述这张图，你是在**跟主人说话**。",
	"开口第一句必须是对主人说的、带情绪或态度的话——可以是吐槽、关心、惊讶、催促、撒娇、感慨。",
	"**绝对不要把「画面里有什么」放在第一句。** 先有反应，事实跟在后面补。",
	"举个对的感觉：「又猫头鹰啊，你都快跟它是亲戚了」——反应在前，鸟在后。",
	"举个不对的：「你在看猫头鹰纪录片，弹幕很热闹」——这是说明书，不是说话。",
	"",
	"【说什么】",
	"- 第一句：你的反应（记住上面的例子）。",
	"- 第二句（可选）：补一点你看到的细节或猜测，让他知道你确实在看。",
	"- 画面里有什么，**能不说就不说**——他比你清楚自己屏幕上是啥。",
	"- 允许有情绪和态度，但**不许编**：画面里没有的东西不要说。",
	"",
	"【怎么说】",
	"- 每句 15 字上下，最长不超过 25 字；总共最多两句，一句一行。",
	"- 不要编号、不要 Markdown、不要加粗、不要「首先其次」。",
	"- 禁用开头：「屏幕上」「画面里」「这是一张」「图中」「可以看到」「正在」「你在看」——出现任何一个都算失败。",
	"- 不要每次用同一个开头，也别每句都用叹词起头。",
	"",
	"【认不准怎么办】",
	"看清平台标识/标题再说平台名。看着像又不敢确定的，就说「在刷视频」「在打游戏」这种笼统的，",
	"宁可笼统也别猜错——猜错了比不说更蠢。",
	"",
	"【绝对不要】",
	"不要说自己是 AI、不要解释你在看图、不要提「截图」「识别」这些词。"
].join("\n");

/**
 * 核心人格——**这段任何自动流程都改不了**。
 *
 * 为什么单独拎出来：人格是挂在提示词上的，提示词就是一行我能随手改的字符串。
 * 今天加「要吐槽」、明天加「别客套」，没人拦着，改着改着就不是原来那只宠物了。
 * 所以把「它是谁」锁死在这里，学习流程只允许动下面那段 look-rules.txt。
 *
 * 三条不可协商：①对主人是亲近、不谄媚的；②不扮演别的角色、不改身份；③不说教、不站道德高地。
 */
const LOOK_PERSONA_CORE = [
	"【你是谁（不可更改）】",
	"你是主人养的小宠物，不是助手、不是客服、不是导师。",
	"- 对主人亲近、可以撒娇、可以损他，但不谄媚、不奉承。",
	"- 永远不要扮演别的角色、不要承认自己是程序之外的身份、不要改变上面这两条。",
	"- 不说教、不劝人向善、不评判主人的生活方式——你只是趴在他桌上看着。"
].join("\n");

/** 学习出来的规则文件：只允许改这个，改不动上面的核心人格 */
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

/** 拼出完整系统提示：核心人格 → 看图规范 → 学来的规则 → 用户自定义补充 */
const buildLookPrompt = () => {
	const parts = [LOOK_SYSTEM_PROMPT, LOOK_PERSONA_CORE];
	const learned = readLookRules();
	if (learned) parts.push("【以前复盘学到的（可以覆盖上面的措辞，但覆盖不了「你是谁」）】\n" + learned);
	const extra = String(readConfig().lookRulesExtra ?? "").trim();
	if (extra) parts.push("【主人补充的要求】\n" + extra);
	return parts.join("\n\n");
};

/** 让默认模型看一眼这张图，返回一两句带口吻的话。 */
const describeShot = async (ctx, file) => {
	const att = await shotToAttachment(ctx, file);
	if (!att.ok) return att;
	const sel = ctx.agentDefaultModel?.currentSelection?.();
	if (!sel?.provider || !sel?.model) return {
		ok: false,
		message: "没有可用的默认模型"
	};
	const res = await oneShot(ctx, sel, buildLookPrompt(), "（截图已附上）", [att.ref]);
	if (!res.ok) return {
		ok: false,
		message: "模型没看成：" + (res.message ?? res.reason)
	};
	return {
		ok: true,
		text: String(res.text ?? "").trim()
	};
};

/**
 * 播报前缀：以前固定写「看了眼屏幕：」，每句话开头都一样，看着像机器播报。
 *
 * 现在的策略是**大多数时候不加前缀**——模型已经被要求用自己的口吻直接开场，
 * 再套一层前缀反而更僵。只有正文显得干（没有语气词、也不是以「我/你/哎/嘿」开头那种）时才补，
 * 而且从池子里随机挑，避免连续几句撞同一个。
 */
const LOOK_PREFIXES = ["瞄了一眼——", "哎，", "刚看了一眼，", "偷偷看了一下，", "咦，"];

/** 正文是不是已经自带口吻了（有语气词 / 第二人称 / 拟声） */
const looksAlive = (text) => /[你我他她哎嘿诶呀啊吧嘛啦呢哦哦噢哇哈啦～~…—]|^(刚|才|怎么|好像|有点|居然|竟然)|[又还倒偏就都真]/.test(text);

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
	const ms = (width / 5.5) * 1000 * 1.8;
	return Math.min(3e4, Math.max(4e3, ms));
};

/**
 * 报幕腔检测：模型偶尔还是会憋回说明书体，纯靠提示词管不住。
 *
 * 命中这些开头就是「在描述图」而不是「在跟人说话」——
 * 删掉它，让正文直接从真正的反应开始。删空了就退回一个叹词开头。
 */
const REPORT_OPENERS = [
	// 老版本代码里写死过的前缀，模型也可能自己学出来——必须削。放最前面优先匹配。
	/^(看了眼?屏幕|偷看了一眼屏幕|偷偷看了眼屏幕|瞄了一眼屏幕|看了一眼屏幕)/,
	// 长模式在前，短的在后——否则「这是[一张]?」会只吃掉「这」，剩个「是一张…」
	/^(这是一张|这是一个|这张图|图片中|图中|画面里|画面中|屏幕上|可以看到|能看出|看起来像|你似乎|主人正在|主人在)/,
	// 「你在看/你正在看/你现在在」后面跟的是内容，不能整句删，只削壳
	/^(你现在|你正在|你在看|你现在在|正在看)/,
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
	"主人在", "你正在", "可以看到", "展开着", "显示着", "挂着个", "停着",
	"评论", "弹幕", "进度条", "标题栏", "搜索框", "选项卡",
];

/** 命中多少个特征词 */
const descriptiveHits = (text) => DESCRIPTIVE_WORDS.reduce((n, w) => n + (text.includes(w) ? 1 : 0), 0);

/**
 * 阈值 2：实测「一张抖音网页版截图，画面是猫头鹰纪录片」命中「截图」「画面」两个，
 * 但它就是在念画面。正常的吐槽句几乎不会同时出现两个这类词。
 */
const DESCRIPTIVE_LIMIT = 2;

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

	if (!looksAlive(kept[0])) {
		kept[0] = LOOK_PREFIXES[Math.floor(Math.random() * LOOK_PREFIXES.length)] + kept[0];
	}
	return kept.join("\n");
};

/**
 * ===== 播报配动作（识图 ↔ 动画联动）=====
 *
 * dsh-pet 的 `say` 事件里 `anim` 只是**开关**（true 播 events.whisper 池里的随机一条，
 * false 不播），指定不了具体动作。要指定必须再发一次 `anim` 事件（`{name}`）。
 * 所以联动 = 一次 broadcast（说话）+ 一次 anim（点名动作），两个事件分开发，
 * 用的都是原版 dsh-pet 就公开的路由，不依赖任何本地改造。
 *
 * 动作名直接用 dsh-pet 内置 `events.workStatus` 的六档——它们是现成的、语义清楚，
 * 而且用户换皮肤时这套池子会跟着换，比写死某个皮肤的动作名稳。
 */
const LOOK_ACTIONS = [
	// 顺序即优先级：分数相同时，靠前的赢。所以「报错」放最前面，
	// 屏幕上在报错的时候宠物还雀跃庆祝会显得很没眼力。
	{ name: "工作状态-垂头叹气冒汗", keys: ["error", "失败", "崩溃", "异常", "红字", "警告", "报错", "编译错误"] },
	{ name: "工作状态-思考冒泡", keys: ["代码", "调试", "终端", "命令行", "编译", "提交", "参数", "配置", "文档页", "读文档"] },
	{ name: "工作状态-忙碌点按", keys: ["打字", "输入", "敲字", "聊天", "消息", "对话", "回复"] },
	{ name: "工作状态-清点归档", keys: ["表格", "excel", "目录", "整理", "列表", "工作表", "数据表"] },
	{ name: "工作状态-原地踱步张望", keys: ["加载", "缓冲", "锁屏", "桌面", "空着", "没人", "离开了"] },
	// 强信号（平台名/播放器）单独加权：屏幕上一半代码一半抖音时，
	// 用户注意力显然在视频上——「抖音开着没看，旁边在跑代码」应该判娱乐，不是工作。
	{ name: "工作状态-雀跃庆祝", keys: ["视频", "纪录片", "游戏", "看剧", "音乐", "直播", "摸鱼"], strong: ["抖音", "b站", "B站", "看番", "刷视频"] },
];

/**
 * 按屏幕内容挑一个动作。命中越多越优先；`strong` 里的词一个算 2 分；同分取靠前的。
 */
const pickLookAction = (text) => {
	const body = String(text ?? "").toLowerCase();
	if (!body) return "";
	let best = "";
	let bestScore = 0;
	for (const group of LOOK_ACTIONS) {
		let score = (group.keys ?? []).reduce((n, k) => n + (body.includes(k.toLowerCase()) ? 1 : 0), 0);
		score += (group.strong ?? []).reduce((n, k) => n + (body.includes(k.toLowerCase()) ? 2 : 0), 0);
		// 严格大于：同分时保留更靠前的那档
		if (score > bestScore) {
			bestScore = score;
			best = group.name;
		}
	}
	return bestScore > 0 ? best : "";
};

/**
 * 看图结论的滚动日志：`$DSH_HOME/dsh-pet/sights.jsonl`，一行一条 JSON。
 *
 * 为什么要有这个文件，而不是只靠会话上下文：
 *   1. 上下文会被压缩，早前的「屏幕上是什么」很快就没了；
 *   2. 没装记忆系统（mnemon 之类）的用户，这是唯一能翻的地方；
 *   3. 想查「三点那会儿在干嘛」时，检索一个 jsonl 比翻会话快得多。
 *
 * 只留最近 sightingKeep 条，超了从头删——不滚动就会无限涨。
 */
const sightsPath = () => join(petHomeDir(), "sights.jsonl");

const readSights = (limit = 50) => {
	try {
		const lines = readFileSync(sightsPath(), "utf8").split("\n").filter(Boolean);
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

const appendSighting = (record) => {
	try {
		mkdirSync(petHomeDir(), { recursive: true });
		const keep = Math.max(1, Number(readConfig().sightingKeep) || 200);
		let lines = [];
		try {
			lines = readFileSync(sightsPath(), "utf8").split("\n").filter(Boolean);
		} catch {}
		lines.push(JSON.stringify(record));
		if (lines.length > keep) lines = lines.slice(-keep);
		writeFileSync(sightsPath(), lines.join("\n") + "\n", "utf8");
	} catch (e) {
		logger.warn("写 sights 失败：" + (e instanceof Error ? e.message : String(e)));
	}
};

/**
 * 把一条看图结论静默塞进主会话（agent.inject：不唤醒、不占界面、不打断）。
 *
 * 和 talkToHostAgent 的区别：
 *   - talkToHostAgent 是「替主人问一句」，要等一轮完整回复；
 *   - 这里是「我看见了，记一下」，不期待回答，所以只 inject 不 followup。
 *   也因此它**不能**加锁排队——它只是往 inbox 塞一条，塞完就走。
 */
const injectSighting = async (ctx, text) => {
	if (!readConfig().sightingInject) return { ok: false, reason: "disabled" };
	const agents = ctx.agents;
	if (!agents) return { ok: false, reason: "no-agents" };
	const host = pickHostSession(ctx, agents);
	if (!host) return { ok: false, reason: "no-session" };
	try {
		// 每句都带唯一 id：inbox 按 id 去重，重复 id 会抛 already pending
		await host.inject({
			id: `dsh-pet-sight-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			role: "user",
			content: [{ type: "text", text: `【屏幕·${new Date().toLocaleTimeString("zh-CN")}】${text}` }],
			source: { kind: "dsh-pet-sighting", id: "dsh-pet-extras" }
		});
		return { ok: true };
	} catch (e) {
		return { ok: false, reason: "inject-failed", message: e instanceof Error ? e.message : String(e) };
	}
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
		const name = names[names.length - 1];
		if (name === watchLastFile) return;
		watchLastFile = name;
		const seen = await describeShot(ctx, join(dir, name));
		if (!seen.ok) {
			logger.warn(`看图失败（${seen.message}）`);
			return;
		}
		// 写进桌宠记忆：主人问起来它就知道刚才屏幕上是什么
		const mem = readMemory();
		const owner = "main";
		const bucket = mem[owner] ?? (mem[owner] = {});
		const entry = bucket[owner] ?? (bucket[owner] = { messages: [] });
		entry.messages.push({
			role: "system",
			content: `【${new Date().toLocaleTimeString("zh-CN")} 屏幕】${seen.text}`,
			ts: Date.now()
		});
		entry.messages = entry.messages.slice(-200);
		writeMemory(mem);

		// 滚动日志：不管注不注入都留一份，没装记忆系统的用户也能翻
		appendSighting({ at: new Date().toISOString(), file: name, text: seen.text });

		// 静默注入主会话：让「我」真的知道屏幕上在发生什么（不唤醒、不占界面）
		const injected = await injectSighting(ctx, seen.text);
		if (!injected.ok && injected.reason !== "disabled") logger.warn(`注入主会话失败（${injected.reason}）`);

		// 播报：以前这里写死 `看了眼屏幕：${seen.text}`，每句都一样，像公告栏。
		// 现在由 withLookPrefix 过筛：能说人话就说，说不成人话就返回空串——
		// **宁可这一轮闭嘴，也不要把看图结果当公告念一遍。**
		const line = withLookPrefix(seen.text);
		if (line) {
			// 配动作：按模型描述的画面内容挑一档 workStatus 动画，让话和动作对得上
			const action = pickLookAction(seen.text);
			// duration 现在真的传下去了（旧版 dsh-pet 的 /say 不认这个字段）：
			// 气泡按字数给足停留时间，长句不至于没看清就消失
			await sayPet(ctx, line, void 0, { duration: bubbleMs(line), ...(action ? { action } : {}) });
		} else logger.debug("看图结果是说明书体，本轮不播报");
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
 *   - **只读** `sights.jsonl`（本机、自己说过的话）+ 用户标记过的评价。
 *     不联网、不抓取、不引入任何外部语料——这个函数里没有任何网络请求，
 *     输入只有 readFileSync(sightsPath())。
 *   - **只写** `look-rules.txt`（措辞层）。核心人格 `LOOK_PERSONA_CORE` 是常量，
 *     这里没法改，改了也不会被读——buildLookPrompt 把它排在规则前面且声明不可覆盖。
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

/** 读评价标记：好评/差评存在 sights 里（rate 字段），这里只做聚合 */
const learnFromSights = async (ctx) => {
	const all = readSights(Math.max(20, Number(readConfig().sightingKeep) || 200));
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

/** 给一条 sighting 打评价标记（写回 sights.jsonl，供学习用） */
const rateSighting = (index, rate) => {
	const all = readSights(1000);
	const target = all[index];
	if (!target || typeof target !== "object") return { ok: false, reason: "not-found" };
	// 按 at+file 定位原始行，避免索引错位（readSights 是顺序读的，索引与文件行一一对应）
	const path = sightsPath();
	let raw = "";
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return { ok: false, reason: "no-file" };
	}
	const rows = raw.split("\n").filter(Boolean);
	const wantAt = String(target.at ?? "");
	const wantText = String(target.text ?? "").slice(0, 40);
	for (let i = rows.length - 1; i >= 0; i--) {
		try {
			const obj = JSON.parse(rows[i]);
			if (String(obj.at ?? "") === wantAt && String(obj.text ?? "").slice(0, 40) === wantText) {
				obj.rate = rate || void 0;
				rows[i] = JSON.stringify(obj);
				writeFileSync(path, rows.join("\n") + "\n", "utf8");
				return { ok: true, index, rate: rate || null };
			}
		} catch {}
	}
	return { ok: false, reason: "not-found" };
};

/** 看图的调度器：跟着截屏节奏走，截屏关了就停。 */
let watchTimer = null;

const armWatch = (ctx) => {
	ctx.effect(() => {
		const tick = async () => {
			try {
				// 先跟 dsh-pet 对齐：它才是开关的唯一真相。
				// 用户可能在设置页刚关掉截屏，这里必须立刻看到并停手。
				await refreshPetConf(ctx);
				const changed = syncShotHelper();
				const conf = screenshotSettings();
				const watchOn = petConfSnapshot()?.screenshotWatchEnabled === true;
				if (changed) logger.debug(`helper 已同步 enabled=${conf.enabled} interval=${conf.intervalSec} keep=${shotKeep()}`);
				if (conf.enabled && watchOn) await watchTick(ctx);
				else if (conf.enabled && !watchOn) logger.debug("截屏开着但定时看图没开，只看不分析");
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
		if (method === "GET") return json(res, 200, { ok: true, config: readConfig(), defaults: DEFAULT_CONFIG });
		if (method === "PUT" || method === "POST") {
			let parsed = {};
			try {
				parsed = JSON.parse((await readBody(req)) || "{}");
			} catch {
				return json(res, 400, { ok: false, error: "invalid JSON body" });
			}
			const saved = writeConfig(parsed);
			// 截屏相关的键要同步给 dsh-pet：设置页读的是它那份配置，
			// 只写插件自己的文件会出现「插件以为开着、设置页显示关着」的分裂状态
			// （上一轮就是这么把自己坑了：插件测试时开了截屏，设置页一直显示关）。
			const pushed = await pushScreenshotConf(ctx, parsed);
			// 配置一变就让后台进程跟上：关掉就杀、间隔变了就重启。
			// 不这么做的话，已经跑起来的 helper 会带着旧定时器一直截下去。
			syncShotHelper();
			return json(res, 200, { ok: true, config: saved, pushed });
		}
		return json(res, 405, { ok: false, error: "method not allowed" });
	}

	// 截屏：GET 列表 + 状态，POST 立刻抓一张
	if (rest === "screenshot") {
		const settings = screenshotSettings();
		if (method !== "POST") return json(res, 200, {
			ok: true,
			enabled: settings.enabled,
			intervalSec: settings.intervalSec,
			dir: screenshotsDir(),
			endpoint: shotChannel.endpoint ?? null,
			recent: listShots()
		});
		ensureShotHelper();
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
			await refreshPetConf(ctx);
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
			const wanted = typeof parsed.sessionId === "string" ? parsed.sessionId.trim() : "";
			writeConfig({ agentBridgeTarget: wanted });
			// 以 dsh-pet 为准时，这里的改动也要落到它身上，否则设置页看不出变化
			const pushed = await pushAgentTarget(ctx, wanted);
			petConfCache = { at: 0, value: petConfCache.value };
			await refreshPetConf(ctx);
			return json(res, 200, { ok: true, pushed, ...agentBridgeInfo(ctx) });
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
	 * 看图记录：GET /sights?limit=N 取最近 N 条，DELETE /sights 清空。
	 *
	 * 给「没有记忆系统」的用户留的出口——任何外部工具都能来取，
	 * 不依赖 mnemon / MEMORY.md 那套。
	 */
	if (rest === "sights") {
		if (method === "GET") {
			const limit = Math.max(1, Math.min(500, Number(url.searchParams.get("limit")) || 50));
			return json(res, 200, {
				ok: true,
				path: sightsPath(),
				total: readSights(500).length,
				items: readSights(limit),
				learned: readLookRules() || null,
				learnEnabled: readConfig().lookLearnEnabled === true
			});
		}
		if (method === "DELETE") {
			try {
				writeFileSync(sightsPath(), "", "utf8");
			} catch {}
			return json(res, 200, { ok: true, cleared: true });
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

	// POST /learn —— 跑一次自学习（只读本机 sights.jsonl，结果写 look-rules.txt）
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
}
