/**
 * dsh-pet-extras —— 设置页（浏览器半边）
 *
 * 为什么需要这一半：本插件的配置真值都在 extras-config.json 里，而 dsh-pet 的设置页
 * 是它自己的前端，**不知道本插件存在**。用户装了官方 dsh-pet + 本插件后，能在桌宠
 * 设置里看到的只有 dsh-pet 自己的字段——「看屏幕间隔」这种插件独有的旋钮根本没地方调，
 * 只能去手改 JSON 或 curl。加上这一半，插件自己往 DSH 设置里挂一节。
 *
 * 为什么不改 dsh-pet 源码：那是别人的包，改了下个版本就被覆盖；而且用户装的是
 * npm 上的官方版，我们的改动他那儿压根不存在。走 DSH 官方的 slots 机制才是正道。
 *
 * 设计约束（照抄 dsh-pet 自己的做法，保持一致）：
 *   - 不 import 任何其它插件模块，只 require("react")；
 *   - 不写死绝对路径，数据全部走本插件自己的 HTTP 接口（/dsh-pet-extras/*）；
 *   - 样式自带、去重注入，风格尽量贴近 dsh-pet 设置页，不引外部字体与资源；
 *   - 任何一步失败都静默降级（格子不渲染 / 显示只读值），绝不把设置页弄坏。
 */
window.__ModuleLoader__.load({
	id: "dsh-pet-extras",
	factory: (require) => {
		const module = { exports: {} };
		const exports = module.exports;

		const react = require("react");
		const { useEffect, useState, useRef, createElement: h } = react;

		const NS = "dsh-pet-extras";

		/** 样式只注入一次，用 data-plugin-css 去重（与 dsh-pet 同一套约定）。 */
		const STYLE_TAG = "dsh-pet-extras/settings.css";
		const CSS = [
			".dsh-px-cfg{container-type:inline-size;display:flex;flex-direction:column;gap:12px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}",
			".dsh-px-cfg__title{margin:0 0 2px;font-size:15px;font-weight:600;display:flex;align-items:center;gap:6px}",
			".dsh-px-cfg__card{border:1px solid var(--dsw-alias-border-weak,rgba(127,127,127,.22));border-radius:10px;padding:12px 14px;display:flex;flex-direction:column;gap:10px}",
			".dsh-px-cfg__cardHead{display:flex;align-items:center;gap:6px;font-weight:600;font-size:13px}",
			".dsh-px-cfg__grid2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px 16px;align-items:end}",
			".dsh-px-cfg__field{display:flex;flex-direction:column;gap:4px;min-width:0}",
			".dsh-px-cfg__label{display:flex;align-items:center;gap:5px;font-size:12px;opacity:.82}",
			".dsh-px-cfg__hint{font-size:12px;line-height:1.5;opacity:.72}",
			".dsh-px-cfg__inp{width:100%;box-sizing:border-box;padding:5px 8px;border-radius:7px;border:1px solid var(--dsw-alias-border-weak,rgba(127,127,127,.3));background:var(--dsw-alias-bg-base,transparent);color:inherit;font:inherit}",
			".dsh-px-cfg__inp:disabled{opacity:.5}",
			".dsh-px-cfg__actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}",
			".dsh-px-cfg__btn{padding:5px 14px;border-radius:7px;border:1px solid var(--dsw-alias-border-weak,rgba(127,127,127,.3));background:transparent;color:inherit;font:inherit;cursor:pointer}",
			".dsh-px-cfg__btn:disabled{opacity:.5;cursor:default}",
			".dsh-px-cfg__btn.is-primary{background:var(--dsw-alias-brand-primary,#4d6bfe);border-color:transparent;color:#fff}",
			".dsh-px-cfg__btn.is-on{background:var(--dsw-alias-brand-primary,#4d6bfe);border-color:transparent;color:#fff}",
			".dsh-px-cfg__msg{font-size:12px}",
			".dsh-px-cfg__msg.is-err{color:var(--dsw-alias-label-danger,#e5484d)}",
			".dsh-px-cfg__q{display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;border-radius:50%;border:1px solid currentColor;font-size:10px;font-style:normal;opacity:.5;cursor:default;flex:none}",
			"@container (max-width:400px){.dsh-px-cfg__grid2{grid-template-columns:minmax(0,1fr)}}"
		].join("\n");
		const injectCss = () => {
			if (typeof document === "undefined") return;
			if (document.querySelector('style[data-plugin-css="' + STYLE_TAG + '"]') !== null) return;
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-pet-extras";
			tag.dataset.pluginCss = STYLE_TAG;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		};

		/** 文案。插件自带的 NS 注册在 host 半边（lib/index.js）里，这里用兜底字典：
		 *  host 没注册成功时也能显示中文，不至于一片空白。 */
		const DICT = {
			zh: {
				nav: "桌宠扩展",
				title: "桌宠扩展",
				intro: "由 dsh-pet-extras 插件提供：把桌宠接到你的一条真实会话上，让它说的话、它看到的屏幕都由那条会话回答。这里只放插件自己的旋钮——桌宠本体的开关仍在上面「桌宠配置」里。",
				bridgeTitle: "接智能体",
				bridgeHint: "总闸。开 = 桌宠跟你说的话、以及它看到的屏幕，都交给下面选的那条会话来回答；关 = 桌宠完全自己聊，不碰你的会话、不截图、不占 token。",
				bridgeOn: "开",
				bridgeOff: "关",
				lookTitle: "看屏幕",
				lookHint: "截屏并交给接的那条会话看一眼。它是「接智能体」下面的子开关：总闸关着时这里开了也不会动。",
				lookOn: "开",
				lookOff: "关",
				gapLabel: "看屏幕间隔（秒）",
				gapHint: "唯一的节奏旋钮：每隔这么多秒截一张、交一张。最小 5 秒。一张整屏约 1024 token，60 秒一张盯一天最坏 1400 多张，别调太小。改完保存即刻生效，不用重启。",
				save: "保存",
				saved: "已保存",
				reload: "重新读取",
				loading: "正在读取插件配置…",
				unavailable: "读不到插件配置：插件可能没在运行，或者这一节不该出现。",
				notInstalled: "没连上 dsh-pet-extras 的后端接口。",
				invalidGap: "间隔要填 5 以上的整数",
				sessionTitle: "接哪条会话",
				sessionHint: "桌宠看屏幕的结论只投给这一条会话。不选就什么都不投——绝不替你猜。选了才会开始定时截屏；选错了就是往别人的会话里灌图，一次一小时六十张。",
				sessionNone: "（不选：不投，也不截屏）",
				sessionMissing: "（原来选的会话已经关了，重新选一条）",
				sessionEmpty: "现在没有开着的会话。先开一个会话，再回来选。",
				sessionNotSaved: "还没选目标会话，所以桌宠还接不上去。",
				bridgeOffSaved: "已保存。接智能体关着：桌宠不会碰你的会话，也不截图。"
			},
			en: {
				nav: "Pet extras",
				title: "Pet extras",
				intro: "Provided by the dsh-pet-extras plugin: connect the pet to one of your real sessions, so what it says and what it sees are answered by that session. Only the plugin's own knobs live here — the pet's own switches stay in \"Pet config\" above.",
				bridgeTitle: "Connect a session",
				bridgeHint: "The master switch. On = what the pet says to you and what it sees on screen are answered by the session you pick below. Off = the pet chats entirely on its own, never touches your session, never captures the screen, spends no tokens.",
				bridgeOn: "On",
				bridgeOff: "Off",
				lookTitle: "Watch the screen",
				lookHint: "Capture the screen and hand it to the connected session. This is a child switch of \"Connect a session\": with the master switch off it does nothing even when on.",
				lookOn: "On",
				lookOff: "Off",
				gapLabel: "Watch interval (sec)",
				gapHint: "The only pace knob: every N seconds one shot is taken and shared. Minimum 5. A full-screen image is ~1024 tokens, so one per minute all day can reach 1400+ — don't set it too small. Saving applies immediately, no restart needed.",
				save: "Save",
				saved: "Saved",
				reload: "Reload",
				loading: "Reading plugin config…",
				unavailable: "Can't read the plugin config: the plugin may not be running, or this section shouldn't be here.",
				notInstalled: "The dsh-pet-extras backend is not reachable.",
				invalidGap: "Interval must be an integer of at least 5",
				sessionTitle: "Connected session",
				sessionHint: "Both what the pet says and what it sees are answered by this one session. Leave it unselected and nothing is delivered — the plugin never guesses. Picking wrong floods another session with an image a minute.",
				sessionNone: "(none: nothing is delivered)",
				sessionMissing: "(the session you picked is gone — pick another)",
				sessionEmpty: "No session is open right now. Open one, then come back and pick it.",
				sessionNotSaved: "No target session yet, so the pet cannot connect.",
				bridgeOffSaved: "Saved. The master switch is off: the pet never touches your session and never captures the screen."
			}
		};

		/** host 侧字典形状：{ zh: {...}, en: {...} }（与 dsh-pet 的注册方式一致）。 */
		const dictForLocale = () => ({ zh: DICT.zh, en: DICT.en });

		/** 极简翻译：优先用 host 注册的字典，没有就用内置的。 */
		const makeT = (ctx) => {
			let bound = null;
			try {
				bound = typeof ctx?.locale?.bind === "function" ? ctx.locale.bind(NS) : null;
			} catch {
				bound = null;
			}
			const lang = (() => {
				try {
					const l = typeof ctx?.locale?.current === "function" ? ctx.locale.current() : null;
					return String(l ?? "").toLowerCase().startsWith("en") ? "en" : "zh";
				} catch {
					return "zh";
				}
			})();
			return (key) => {
				if (bound) {
					try {
						const v = bound(key);
						if (typeof v === "string" && v && v !== key) return v;
					} catch {}
				}
				const d = DICT[lang];
				return d[key] ?? DICT.zh[key] ?? key;
			};
		};

		const GET_JSON = async (url) => {
			const res = await fetch(url, { cache: "no-store" });
			if (!res.ok) throw new Error(String(res.status));
			return await res.json();
		};
		const PUT_JSON = async (url, body) => {
			const res = await fetch(url, {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body)
			});
			if (!res.ok) throw new Error(String(res.status));
			return await res.json();
		};

		/** 设置页内容组件。owner props 只有 { close }，这里用不到 close。 */
		const ExtrasSection = () => {
			injectCss();
			const t = ExtrasSection.t;
			const [state, setState] = useState("loading");
			const [bridge, setBridge] = useState(null);
			const [on, setOn] = useState(null);
			const [gap, setGap] = useState(null);
			const [sessions, setSessions] = useState([]);
			const [targetId, setTargetId] = useState("");
			const [busy, setBusy] = useState(false);
			const [msg, setMsg] = useState({ kind: "", text: "" });
			const alive = useRef(true);

			const load = async () => {
				setState("loading");
				setMsg({ kind: "", text: "" });
				try {
					// 开关的真值在 dsh-pet 的配置里（合并后这就是 screenshotEnabled），
					// 插件的 /config 会把它一起回给我们；间隔的真值在插件自己那边。
					const cfg = await GET_JSON("/dsh-pet-extras/config");
					const c = cfg?.config ?? {};
					const share = await GET_JSON("/dsh-pet-extras/sight-share");
					if (!alive.current) return;
					setBridge(c.agentBridgeEnabled === true);
					setOn(c.screenshotEnabled === true);
					setGap(Number.isFinite(Number(share?.minGapSec)) ? Number(share.minGapSec) : Number(c.sightShareMinGap) || 60);
					// 目标会话：拿现有候选列表 + 当前存的那条
					try {
						const agent = await GET_JSON("/dsh-pet-extras/agent");
						if (!alive.current) return;
						setSessions(Array.isArray(agent?.candidates) ? agent.candidates : []);
						setTargetId(String(agent?.targetSessionId ?? "") || "");
					} catch {
						setSessions([]);
						setTargetId("");
					}
					setState("ready");
				} catch {
					if (!alive.current) return;
					// 插件没装 / 没起来：这一节本来就不该出现，安静退出即可。
					setState("unavailable");
				}
			};

			useEffect(() => {
				alive.current = true;
				void load();
				return () => {
					alive.current = false;
				};
			}, []);

			const save = async () => {
				const n = Number(gap);
				if (!Number.isInteger(n) || n < 5) {
					setMsg({ kind: "err", text: t("invalidGap") });
					return;
				}
				setBusy(true);
				setMsg({ kind: "", text: "" });
				try {
					await PUT_JSON("/dsh-pet-extras/config", {
						agentBridgeEnabled: bridge === true,
						screenshotEnabled: on === true
					});
					await PUT_JSON("/dsh-pet-extras/sight-share", { minGapSec: n });
					// 目标会话：空串 = 清掉（回到「不许投」），这里必须能清，否则关不掉
					await PUT_JSON("/dsh-pet-extras/agent", { targetSessionId: targetId || "" });
					setMsg({
						kind: "ok",
						text: bridge !== true ? t("bridgeOffSaved") : targetId ? t("saved") : t("sessionNotSaved")
					});
				} catch (e) {
					setMsg({ kind: "err", text: String(e?.message ?? e) });
				} finally {
					if (alive.current) setBusy(false);
				}
			};

			if (state === "loading") {
				return h("section", { className: "dsh-px-cfg", style: { maxWidth: "720px" } }, [
					h("h2", { key: "t", className: "dsh-px-cfg__title", children: t("title") }),
					h("div", { key: "s", className: "dsh-px-cfg__msg", children: t("loading") })
				]);
			}
			if (state === "unavailable") {
				return h("section", { className: "dsh-px-cfg", style: { maxWidth: "720px" } }, [
					h("h2", { key: "t", className: "dsh-px-cfg__title", children: t("title") }),
					h("div", { key: "s", className: "dsh-px-cfg__msg is-err", children: t("unavailable") }),
					h("div", { key: "a", className: "dsh-px-cfg__actions" }, [
						h("button", {
							key: "r",
							type: "button",
							className: "dsh-px-cfg__btn",
							onClick: () => void load(),
							children: t("reload")
						})
					])
				]);
			}

			return h("section", { className: "dsh-px-cfg", style: { maxWidth: "720px" } }, [
				h("h2", { key: "t", className: "dsh-px-cfg__title", children: t("title") }),
				h("div", { key: "i", className: "dsh-px-cfg__hint", children: t("intro") }),
				// 总闸放最前面：下面的「看屏幕」「接哪条会话」都是它的下家，
				// 关着的时候那两个怎么设都不会动，所以先说清楚。
				h("div", { key: "br", className: "dsh-px-cfg__card" }, [
					h("div", { key: "h", className: "dsh-px-cfg__cardHead" }, [
						h("span", { key: "t", children: t("bridgeTitle") }),
						h("i", { key: "q", className: "dsh-px-cfg__q", title: t("bridgeHint"), children: "?" })
					]),
					h("div", { key: "b", className: "dsh-px-cfg__grid2" }, [
						h("div", { key: "sw", className: "dsh-px-cfg__field" }, [
							h("div", { key: "l", className: "dsh-px-cfg__label", children: t("bridgeTitle") }),
							h("button", {
								key: "c",
								type: "button",
								disabled: busy,
								className: "dsh-px-cfg__btn" + (bridge === true ? " is-on" : ""),
								onClick: () => setBridge((v) => v !== true),
								children: bridge === true ? t("bridgeOn") : t("bridgeOff")
							})
						])
					]),
					h("div", { key: "bh", className: "dsh-px-cfg__hint", children: t("bridgeHint") })
				]),
				h("div", { key: "c", className: "dsh-px-cfg__card" }, [
					h("div", { key: "h", className: "dsh-px-cfg__cardHead" }, [
						h("span", { key: "t", children: t("lookTitle") }),
						h("i", { key: "q", className: "dsh-px-cfg__q", title: t("lookHint"), children: "?" })
					]),
					h("div", { key: "b", className: "dsh-px-cfg__grid2" }, [
						h("div", { key: "sw", className: "dsh-px-cfg__field" }, [
							h("div", { key: "l", className: "dsh-px-cfg__label", children: t("lookTitle") }),
							h("button", {
								key: "c",
								type: "button",
								disabled: busy,
								className: "dsh-px-cfg__btn" + (on === true ? " is-on" : ""),
								onClick: () => setOn((v) => v !== true),
								children: on === true ? t("lookOn") : t("lookOff")
							})
						]),
						h("div", { key: "gap", className: "dsh-px-cfg__field" }, [
							h("div", { key: "l", className: "dsh-px-cfg__label" }, [
								h("span", { key: "s", children: t("gapLabel") }),
								h("i", { key: "q", className: "dsh-px-cfg__q", title: t("gapHint"), children: "?" })
							]),
							h("input", {
								key: "i",
								type: "number",
								min: 5,
								step: 1,
								disabled: busy || on !== true,
								className: "dsh-px-cfg__inp",
								value: gap === null ? "" : String(gap),
								onInput: (e) => setGap(e.target.value === "" ? null : Number(e.target.value))
							})
						])
					]),
					h("div", { key: "gh", className: "dsh-px-cfg__hint", children: t("gapHint") })
				]),
				h("div", { key: "sc", className: "dsh-px-cfg__card" }, [
					h("div", { key: "h", className: "dsh-px-cfg__cardHead" }, [
						h("span", { key: "t", children: t("sessionTitle") }),
						h("i", { key: "q", className: "dsh-px-cfg__q", title: t("sessionHint"), children: "?" })
					]),
					h("div", { key: "f", className: "dsh-px-cfg__field" }, [
						h("div", { key: "l", className: "dsh-px-cfg__label", children: t("sessionTitle") }),
						h("select", {
							key: "sel",
							disabled: busy,
							className: "dsh-px-cfg__inp",
							value: targetId,
							onChange: (e) => setTargetId(String(e.target.value ?? "")),
							children: [
								h("option", { key: "__none", value: "", children: t("sessionNone") }),
								...(targetId && !sessions.some((x) => x.id === targetId)
									? [h("option", { key: "__miss", value: targetId, children: t("sessionMissing") })]
									: []),
								...sessions.map((x) =>
									h("option", {
										key: x.id,
										value: x.id,
										children: `${x.title || x.id}${x.status ? `（${x.status}）` : ""}`
									})
								)
							]
						})
					]),
					h("div", {
						key: "sh",
						className: "dsh-px-cfg__hint",
						children: sessions.length === 0 ? t("sessionEmpty") : t("sessionHint")
					})
				]),
				h("div", { key: "a", className: "dsh-px-cfg__actions" }, [
					h("button", {
						key: "s",
						type: "button",
						disabled: busy,
						className: "dsh-px-cfg__btn is-primary",
						onClick: () => void save(),
						children: t("save")
					}),
					h("button", {
						key: "r",
						type: "button",
						disabled: busy,
						className: "dsh-px-cfg__btn",
						onClick: () => void load(),
						children: t("reload")
					}),
					msg.text
						? h("span", { key: "m", className: "dsh-px-cfg__msg" + (msg.kind === "err" ? " is-err" : ""), children: msg.text })
						: null
				])
			]);
		};
		ExtrasSection.t = (key) => key;

		const install = (ctx) => {
			const t = makeT(ctx);
			ExtrasSection.t = t;
			// 字典注册失败不影响显示（组件里有兜底），所以不包 try 也不 await。
			try {
				ctx.effect(() => ctx.locale.register(NS, dictForLocale()), "dsh-pet-extras: dictionaries");
			} catch {}
			ctx.slots.inject("settings.section", () =>
				ctx.slots.register(
					{
						name: "settings.section",
						id: "dsh-pet-extras",
						order: 40,
						label: () => t("nav"),
						inject: () => ({})
					},
					ExtrasSection
				)
			);
		};

		const name = "pet-extras";
		const inject = ["slots", "locale"];

		function apply(ctx) {
			try {
				install(ctx);
			} catch (e) {
				// 设置节挂不上就算了，绝不能连累整个设置面板。
				console.warn("[dsh-pet-extras] 设置页挂载失败：" + (e instanceof Error ? e.message : String(e)));
			}
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});
