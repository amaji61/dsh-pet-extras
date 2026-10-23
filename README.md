# dsh-pet-extras

给 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）的桌面桌宠 [`dsh-pet`](https://github.com/PC2005-cloud/dsh-pet) 加装的扩展能力。

> **它本身不提供桌宠。** 没装 `dsh-pet` 这个插件就没有使用意义——请先装 `dsh-pet`，再加这个。
>
> **这是个人开发者的业余项目，不是官方扩展，与 `dsh-pet` 作者无关。** 现在是 `0.1.0` 早期版本，作者第一次用 GitHub 发布插件，**功能上仍可能有 bug**，遇到问题欢迎提 issue，我会尽力修。

> 英文说明见 [README.en.md](README.en.md)。

---

## ⚠️ 先读这个：它会截你的整个屏幕

**如果这一节看完你接受不了，请不要安装。**

| 它做什么 | 你要知道的 |
|---|---|
| 按你设的间隔**截取主显示器整屏** | 截图里可能出现聊天记录、密码框、别人的隐私 |
| 默认**只存在本地磁盘** | `$DSH_HOME/dsh-pet/screenshots/`，插件自己不上传任何地方 |
| **只有在你自己打开「定时看图」之后**，图才会发给模型 | 发给你**自己在 DSH 里配置的**模型提供方，用**你自己的 API Key**，费用你自己承担 |

**默认状态：定时截屏是关的，定时看图是关的，不截图、不联网、不调用任何模型。** 什么都不开的话，它只是个躺在磁盘上的插件。

不想让图离开电脑，就永远别打开 `screenshotWatchEnabled`。

完整的数据流图表见下面的 [**隐私与数据处理**](#隐私与数据处理请务必读完这一节再安装)。

---

## 功能

| 功能 | 说明 | 默认 |
|---|---|---|
| **定时整屏截图** | 每隔 N 秒抓一张主屏，存成本地 PNG。**不上传、不调模型、不耗 token** | 关 |
| **看图播报** | 有新截图就交给视觉模型看一眼，用一两句像人话的嘟囔说出「屏幕上是什么、你在干嘛」，显示在桌宠头顶气泡里，并按内容配一个对应动作 | 关 |
| **看图记录** | 每次看图的文字结论存进 `sights.jsonl` 滚动日志，并静默注入主会话，让 AI 真的知道屏幕在发生什么 | 开注入 |
| **接宿主智能体** | 桌宠说的话投递给 DSH 里的一条真实会话，回答再用桌宠的声音逐句说出来。共享那条会话的上下文和记忆 | 关 |
| **锁在屏幕内** | 把 `confineToScreen` 开关下发到 dsh-pet，防止宠物窗口跑出屏幕边界 | 开 |

### 和 `dsh-pet` 自带的对话有什么区别

`dsh-pet` 自带一个「小模型自聊」：只读它自己那份精简记忆，跟界面里的大上下文不通。

打开**接宿主智能体**之后，桌宠说的话是真的进了你界面上那条会话——同一个脑子、同一份上下文、同一份记忆。你在界面上说过的、它都知道；因此它说的话也会占那条会话的 token 额度，说得多会更快撞到上下文上限。

---

## 安装

```bash
dsh plugin add dsh-pet-extras
```

装完重启 DSH。

需要先装 `dsh-pet`（本插件是它的外挂）。

---

## 配置

配置文件在 `$DSH_HOME/dsh-pet/extras-config.json`，也可以走 HTTP 接口：

```bash
# 看当前配置
curl http://127.0.0.1:<PORT>/dsh-pet-extras/config

# 改配置（只传要改的字段）
curl -X PUT http://127.0.0.1:<PORT>/dsh-pet-extras/config \
  -H 'content-type: application/json' \
  -d '{"screenshotEnabled": true, "screenshotIntervalSec": 30}'
```

`<PORT>` 是 DSH 的 Web 端口，和地址栏里的一致。

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `screenshotEnabled` | bool | `false` | 定时截屏总开关 |
| `screenshotIntervalSec` | number | `20` | 间隔秒数，最小 5 |
| `screenshotWatchEnabled` | bool | `false` | 看到新截图就交给模型分析（**每张图都调一次模型，会花 token**） |
| `agentBridgeEnabled` | bool | `false` | 桌宠的话投递给宿主会话 |
| `agentBridgeTarget` | string | `""` | 固定接哪条会话：会话 id 或**会话标题**都行。空 = 自动挑用得最久的那条 |
| `confineToScreen` | bool | `true` | 窗口锁在屏幕工作区内 |
| `screenshotKeep` | number | `60` | 截图文件保留张数（1~2000），超了删最旧的 |
| `sightingInject` | bool | `true` | 把看图结论静默注入主会话（`agent.inject`，不唤醒、不占界面） |
| `sightingKeep` | number | `200` | `sights.jsonl` 保留最近多少条 |
| `lookLearnEnabled` | bool | `false` | 看图播报的自学习（见下） |
| `lookRulesMaxChars` | number | `1200` | 学到多少字就停止采用（0~4000） |
| `lookRulesExtra` | string | `""` | 你自己写的额外播报规则 |

> **注意**：截图和接智能体这两组开关会同步到 `dsh-pet` 的设置页，两边改哪边都行，以 dsh-pet 设置为准。

---

## HTTP 接口

全部挂在 `/dsh-pet-extras` 下：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/ping` | 探活，返回插件名、版本、DSH_HOME |
| GET | `/config` | 读当前配置 + 默认值 |
| PUT/POST | `/config` | 改配置（只传要改的键） |
| GET | `/screenshot` | 列出最近截图和开关状态 |
| POST | `/screenshot` | 立刻抓一张（会拉起截图 helper） |
| GET | `/agent` | 桥接状态：目标会话、队列深度、可选会话列表 |
| POST/PUT | `/agent` | body `{"sessionId": "..."}` 换目标；`{"text": "..."}` 直接投递一句话；加 `"async": true` 立刻返回、后台播报 |
| GET | `/confine` | 读屏幕锁定开关 |
| PUT/POST | `/confine` | body `{"value": true}`，立刻下发给 dsh-pet |
| GET | `/sights?limit=N` | 取最近 N 条看图记录（默认 50，上限 500） |
| DELETE | `/sights` | 清空看图记录 |
| POST | `/rate` | body `{"index": 0, "rate": "good"\|"bad"\|""}`，给某条播报打标 |
| GET | `/learn` | 自学习状态与学到的规则 |
| POST | `/learn` | 跑一次自学习（需要 `lookLearnEnabled: true`） |

---

## 工作方式

### 截图

DSH 宿主进程拉不起 `desktopCapturer`（那是 Electron 渲染进程的能力），所以本插件会**自己 spawn 一个最小化的 Electron 进程**专门截图：

- 进程入口 `runtime/electron-helper/main.cjs`
- 它在 `127.0.0.1:随机端口` 起一个只监听本机的 HTTP 服务，启动时把地址打到 stdout
- 宿主从 stdout 正则抓到端口，之后通过 `POST /shot` 让它截图
- 图片落在 `$DSH_HOME/dsh-pet/screenshots/`，默认保留最近 60 张

**为什么不用 IPC/stdin**：实测 Electron 被 `spawn` 起来之后 stdin 不通，写进去的行收不到。所以走了本机 HTTP。

### 接智能体

投递不是「复制一遍上下文」，是**真的进入那条会话**：

1. 按 `agentBridgeTarget`（或自动规则）挑一条宿主会话
2. 等它空闲
3. 把桌宠的话 `followup` 投递进去
4. 等这一轮跑完，从会话事件流里抽出 `assistant/message` 的正文
5. 用桌宠逐句气泡说出来

好处是共享那条会话的完整上下文和记忆，不需要额外维护一份。代价是必须排队——那条会话正在忙的时候，桌宠得等。

**桌宠的回复怎么和你在界面里说的话区分开**：投递的文本前面会加三个零宽空格作为围栏，扫回复时只认围栏之后的那一段，所以你自己的对话不会被误当成桌宠的回答念出来。

### 看图播报

播报不是念检测结果，是让它像人在旁边嘟囔一句：

- 提示词明确要求**不要用「屏幕上」「画面里」这类报幕腔开头**，也不要每次同一个开头
- 认不准就笼统说（「在刷短视频」「在打游戏」），**宁可笼统也不猜错**
- 允许有自己的反应和看法，但**不许编**看不见的东西
- 播报前缀是随机的（「瞄了一眼——」「哎，」「咦，」…），而且**只有正文看着像干巴巴的检测报告时才补前缀**

代码层还有一道过滤：整句里出现两个以上「截图 / 画面 / 右侧 / 弹幕 / 进度条」这类描述性词汇，这句直接丢掉不播。一句人话都没有时，**这一轮它就闭嘴**——宁可不说话，也不念说明书。

气泡停留时间按字数算（5.5 字/秒 × 1.8 余量，夹在 4~30 秒），不是一刀切的固定时长。

### 看图播报的自学习（默认关）

打开 `lookLearnEnabled` 后，你可以用 `POST /rate` 给每次播报打「好 / 差」标记。之后 `POST /learn` 会把标记过的样本交给模型，总结出「什么样的说法像人话」，写进 `$DSH_HOME/dsh-pet/look-rules.txt`，后续播报会参考这些规则。

**它不会联网学习，也不会改变桌宠的性格**：

- 唯一的输入是本地 `sights.jsonl`，不抓取任何外部内容
- 核心人格写在代码里（`LOOK_PERSONA_CORE`），**学习写不进这一层**
- 学到的规则里如果出现「你是谁 / 你的身份 / 你其实是」这类改写人格的内容，会被直接拒用，整份规则作废
- 规则超过 `lookRulesMaxChars` 就整段不采用（不截断——截断留半句话更容易学歪）

---

## 兼容性

- 直接依赖：**只有 Node.js 内置模块**（`node:fs` / `node:http` / `node:child_process` 等），不 import 任何 `@deepseek-ai/*` 包，所以版本对不上也不会炸
- 通过 `inject` 声明获取宿主服务：`webServer`、`attachments`、`agentDefaultModel`、`agents`、`llm`
- 与 dsh-pet 的耦合只有 HTTP 接口：`POST /dsh-pet-7340/broadcast`（播报）、`POST /dsh-pet-7340/anim`（动作）、`GET /dsh-pet-7340/config`（读宠物配置）。**这些都是 dsh-pet 原版就公开的路由**，不需要安装任何改版
- 路径全部走 `DSH_HOME` 环境变量，**没有写死任何绝对路径**
- 窗口定位按 `screen.getPrimaryDisplay().workArea` 实时计算

---

## 隐私与数据处理（**请务必读完这一节再安装**）

这个插件会截你的**整个主屏幕**。截图里可能包含聊天记录、密码框、别人的隐私。请确认你能接受这几点。

### 截什么、存在哪

- 截的是**主显示器整屏**，按你设的间隔抓，存到 `$DSH_HOME/dsh-pet/screenshots/` 下的 PNG
- 默认**只在本地落盘**，插件不往任何服务器上传
- 文件数量按 `screenshotKeep` 滚动，默认只留 60 张；随时可以手动删目录

### 什么时候数据会离开你的电脑

**只有一个条件：你主动打开 `screenshotWatchEnabled`（默认关闭）。**

打开之后，每次产生新截图，插件会把它交给**你自己在 DSH 里配置的模型**分析一次。这意味着：

- 图片内容会作为请求发到**那个模型的提供方**（DeepSeek 或你配置的其它 provider）
- 用的是**你自己的 API Key**，计费和授权都由你承担
- 插件不经过第三方中转，**没有任何隐藏上报端点**（可自行 `grep` 验证：全文只有本地 `127.0.0.1` 和宿主提供的 `ctx.llm` 调用）

**不想让图离开电脑，就保持 `screenshotWatchEnabled: false`。** 此时截图只躺在本地磁盘里。

### 它还会写什么

| 路径 | 内容 | 控制 |
|---|---|---|
| `$DSH_HOME/dsh-pet/screenshots/*.png` | 原始截图 | `screenshotKeep` 控制张数 |
| `$DSH_HOME/dsh-pet/sights.jsonl` | 每张图的**文字结论**（不含图片），一行一条 | `sightingKeep` 控制条数，`DELETE /sights` 清空 |
| `$DSH_HOME/dsh-pet/memory.json` | 借 dsh-pet 的会话记忆，同步一份看图结论 | 关掉 `screenshotWatchEnabled` 就停 |
| `$DSH_HOME/dsh-pet/extras-config.json` | 插件自己的配置 | — |
| `$DSH_HOME/dsh-pet/look-rules.txt` | 自学习写出的规则（没开自学习就没有这个文件） | `lookLearnEnabled` |

开了 `sightingInject` 后，文字结论还会**静默注入你正在用的 DSH 会话**（`agent.inject`，不会弹消息打断你），目的是让主会话知道屏幕在发生什么。不想让主会话知道，把 `sightingInject` 关掉。

### 权限说明（供安全扫描参考）

- 用 `child_process.spawn` 启动一个 **Electron 子进程**跑截图 helper。启动的**只有本插件包内的固定文件** `runtime/electron-helper/main.cjs`，**不接受任何外部传入的命令或参数**，不存在远程命令执行
- helper 自己起一个 `127.0.0.1` 随机端口的 HTTP 服务，只监听本机回环地址，不对局域网开放
- 通过 `inject` 申请的宿主服务是功能必需：`attachments`（存图）、`llm`（分析图）、`agents`（注入会话）、`webServer`（提供接口）
- **不读环境变量里的密钥，不写注册表，不安装任何依赖，没有任何 postinstall 脚本**

---

## 已知问题（老实说，这个版本不完美）

- **只在桌面模式（`display: desktop`）有效**。web 模式下没有 Electron 进程，截图功能不可用
- 改 `screenshotIntervalSec` 之后需要等 helper 重启才生效（手动 `POST /screenshot` 会触发重启）
- **接智能体是串行的**：桌面宠物和你说话时，目标会话很可能正在忙（就是你自己正在用的那条），这时候桌宠要排队。等空闲最多 90 秒，等不到就回一句「在忙」。这是个设计取舍，不是 bug：想立刻有回应，就指定一条空闲会话，或者关掉接智能体
- 播报依赖 `dsh-pet`：没装或版本太老时，看图分析照跑但说不出话（返回 `pet-unavailable`）
- **`0.1.0` 版本，作者第一次用 GitHub 发布，代码里可能还有我没想到的边界情况。** 遇到问题请提 issue，附上 `$DSH_HOME/dsh-pet/extras.log` 会好排查很多
- 只测过 Windows + DSH 桌面版。其它平台理论可行（路径都走 `DSH_HOME`），但没有实测过

---

## 卸载

```bash
dsh plugin remove dsh-pet-extras
```

然后重启 DSH。

卸载**不会自动删你的数据**，想清干净就手动删这几个（都在 `$DSH_HOME/dsh-pet/`）：

| 路径 | 是什么 |
|---|---|
| `screenshots/` | 截图 PNG，可能很大 |
| `sights.jsonl` | 看图的文字记录 |
| `extras-config.json` | 插件配置 |
| `extras.log` | 运行日志 |
| `look-rules.txt` | 自学习写出的规则 |

`memory.json` 是 dsh-pet 自己的，**别删**——里面是桌宠的对话记忆，跟本插件无关。

---

## 常见问题

**看不见设置项？**
本插件没有自己的设置面板，功能开关挂在 dsh-pet 的配置页里（设置 → 桌宠配置）。所以没装 `dsh-pet` 就看不到任何界面。

**开了定时截屏，截图目录没动静？**
确认两点：①桌宠的显示模式是 `desktop`（web 模式没有 Electron 进程）；②`GET /dsh-pet-extras/screenshot` 返回的 `enabled` 是 `true`。改过间隔要等 helper 重启，手动 `POST /dsh-pet-extras/screenshot` 会立刻触发一次重启。

**桌宠说话很久才回，或者干脆回「在忙」？**
接智能体是串行的：目标会话正在跑任务时，桌宠得排队。等空闲最多 90 秒。想让它立刻有回应，就关掉接智能体，或者把目标会话改成一条空闲的（填会话标题或 id 都行）。

**看图播报有一阵子不说话了？**
这是故意的。模型偶尔会吐出「屏幕上是一张截图，画面里有…」这种说明书体，插件会把这句丢掉不播，而不是念给你听。连续几次都不说话，说明那段时间屏幕内容确实不好说人话。

**换了显示器 / 改了缩放，宠物窗口又跑到屏幕外了？**
把 `confineToScreen` 打开，插件会在启动时和每次改配置时把它下发到 dsh-pet。

---

## 致谢

- 桌宠本体来自 [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet)（MIT）。本项目**只是调用它的公开 HTTP 接口**，没有复制它的代码。桌宠可爱是作者的功劳，本插件只是给它加了几件事
- 宿主框架 [DeepSeek Harness](https://github.com/deepseek-ai)

## 许可

MIT，见 [LICENSE](LICENSE)。

本项目与 `dsh-pet` 的作者没有隶属关系，也不代表其立场。`dsh-pet` 的版权归 `PC2005-cloud` 所有。
