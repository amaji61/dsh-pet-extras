# dsh-pet-extras

Extra capabilities for [`dsh-pet`](https://github.com/PC2005-cloud/dsh-pet), the desktop pet plugin for [DeepSeek Harness](https://github.com/deepseek-ai) (DSH).

> **This plugin does not provide the pet itself.** It is meaningless without `dsh-pet` — install that one first.
>
> **This is a hobby project by an individual developer, not an official extension, and not affiliated with the `dsh-pet` author.** It is at `0.2.0`, an early release. This is the author's first time publishing on GitHub, so **there may still be bugs**. Issues are welcome and I'll do my best to fix them.

> 中文说明见 [README.md](README.md).

---

## ⚠️ Read this first: it captures your entire screen

**If you are not comfortable with this section, please do not install.**

| What it does | What you should know |
|---|---|
| Captures a **full-screen image of the primary display** at an interval you set | Screenshots may contain chat logs, password fields, or other people's private information |
| By default, **stores them on your local disk only** | `$DSH_HOME/dsh-pet/screenshots/`. The plugin uploads them nowhere |
| Images are sent to a model **only after you enable "watch" yourself** | They go to **the model provider you configured in DSH**, billed to **your own API key** |

**Default state: "watch the screen" is OFF — no screenshots, no network, no model calls.** With everything off, it is just a plugin sitting on disk doing nothing.

If you never want images to leave your machine, simply never enable `screenshotEnabled`.

See [**Privacy and data handling**](#privacy-and-data-handling-please-read-before-installing) below for the complete data-flow table.

---

## The agent bridge: this plugin's foundation, not an optional extra

Start with the mechanism — everything else is built on it.

**`dsh-pet` ships with its own small brain**: it talks to a default model by itself, reading only its own trimmed memory. That is a completely separate brain from the session you have open in the UI. It does not know what you said there, and you cannot find what it said.

**What this plugin does is remove that small brain and point the pet at your real one.**

```
what you say / what is on screen
      ↓
  delivered into a real DSH session   ← the very session you normally use
      ↓
  that session answers with its own context and memory
      ↓
  the reply comes back to the pet, spoken in its voice, line by line
```

**What you get out of it:**

- **One brain.** The pet does not keep a second memory. What it says is what your session says. Anything you told that session is known to the pet too.
- **It can hold a conversation.** No longer a one-shot toy — it carries the last dozens of turns, follows up, stays on topic.
- **It can do work for you.** What gets delivered is a real message, so the session really calls tools, reads files, runs commands. The pet turns from a talking ornament into a working entry point.
- **The screen is its business too.** Narration uses the same mechanism: the screenshot goes in as an attachment, the session actually looks at the picture before speaking instead of guessing from a sentence.

**The costs, stated plainly:**

- Every sentence the pet says and every look it takes **spends that session's tokens**. Watch more often and you hit the context limit sooner.
- Delivery is **serialized**: while that session is busy with your task, the pet waits.
- It **really enters your session**. Do not think of it as "just a pet" — what it does is the same as you sending a message yourself.

> This is also why "Watch the screen" must go through this path: sending a sentence like "look at the screen" without the image would leave the session blind, so it could only invent. **To narrate, you hand over the image. If you do not want that, do not narrate.**

### How this differs from dsh-pet's built-in chat

| | `dsh-pet` built-in | with the agent bridge on |
|---|---|---|
| Who answers | a separately-called default model | **the real session open in your UI** |
| Memory | its own trimmed memory | the session's full context and memory |
| Knows what you said | no | yes |
| Can call tools and do work | no | yes (these are real messages) |
| Whose tokens it spends | a separate call | **that session's budget** |

---

## Features

| Feature | Description | Default |
|---|---|---|
| **Agent bridge** | The foundation. What you say to the pet is delivered into a real DSH session, and that session's reply is spoken back through the pet, sentence by sentence. Shares that session's context and memory. **Turn it off and the two below stop working** | Off |
| **Watch the screen** | One switch for the whole thing: grabs the primary display every N seconds (local PNG) **and hands that shot to the connected session**, which answers in one or two lines using its own context and memory — shown in the bubble above the pet. **Turning it on always calls the model and costs tokens**; turning it off stops everything. There is no "capture only, never share" mode | Off |
| **Sight archive** | Every look stores the **original screenshot + the session's raw analysis** in `dsh-pet/视野/` (one folder per day, kept 7 days). Never loaded into context; open it when you want to know what was on screen yesterday afternoon | On |
| **Keep on screen** | Pushes the `confineToScreen` flag to `dsh-pet` so the pet window cannot leave the screen bounds | On |

### Settings page

Once installed, DSH settings gains a **"Pet extras"** section holding the plugin's own knobs: the **Watch the screen** switch and the **Watch interval (sec)** field. Save applies immediately.

Why a separate section: these keys live in this plugin's own config file and `dsh-pet`'s settings page knows nothing about them. Previously the only ways in were editing JSON or curl; now there is a UI.

> **An earlier version of this file claimed the switches were "the same key, synchronised with the `dsh-pet` settings page" — no such thing exists.** The plugin's config lives only in its own `extras-config.json` and is edited only from Settings → Pet extras. Nothing is synced anywhere.

---

## Install

Requires `dsh-pet` first — this plugin is an add-on; it does not provide the pet itself.

### Desktop app: one-click (recommended, no JSON editing)

1. **Settings → Plugins → Add plugin**
2. Enter the **absolute path** of the package, either form:
   - the `.tgz`: `D:\some\dir\dsh-pet-extras-0.2.0.tgz`
   - the extracted folder: `D:\some\dir\package`
3. Confirm, then restart DSH when prompted

You do **not** need to edit `package.json` on this path: the plugin manager reads `dsh.bundle` from the package and writes the name into `dsh.profile.bundles` automatically (that is `reconcile()` in `dsh-plugin-manager`).

**Right after installing**: go to Settings → **Pet extras**, pick a session under "Connected session", then switch "Watch the screen" on.

With no session selected the plugin **does not capture and does not deliver** — deliberately. Earlier builds silently picked "the session with the most messages", and in the wild that flooded an unrelated session with full-screen screenshots. Now: **nothing selected, nothing happens**.

### Manual install (`pnpm add` / offline tgz): two places must be edited

DSH only loads packages listed in `dsh.profile.bundles`. `pnpm add` writes `dependencies` only — files land, you restart, and the settings page shows nothing while every route 404s.

With the profile directory `$DSH_PROFILE` (usually `$DSH_HOME/profiles/desktop` on desktop), edit `$DSH_PROFILE/package.json`:

```jsonc
{
  "dependencies": {
    "dsh-pet": "0.3.8",
    "dsh-pet-extras": "0.2.0"      // (1) added by pnpm add
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        // ... other bundles
        "dsh-pet",
        "dsh-pet-extras"            // (2) must be added by hand, or the plugin never loads
      ]
    }
  }
}
```

Restart DSH afterwards. **On uninstall, remove both.**

### Verify it actually loaded

```bash
# ok/enabled/minGapSec means loaded; 404 means not loaded (bundles missing, or no restart)
curl http://127.0.0.1:<PORT>/dsh-pet-extras/sight-share
```

Expected: `{"ok":true,"enabled":true,"minGapSec":60}`. A 404 / `no such route` sends you back to the bundles line.

> The port changes on every restart — read it from the DSH window or startup log.

### This version no longer touches any `dsh-pet` file

Early 0.1.0/0.1.x builds read `screenshotEnabled` / `agentBridgeEnabled` from the `dsh-pet` config file — keys **we had injected into `dsh-pet`'s private config**. Official 0.3.8 has none of them, and updates wipe them. That is exactly why switches stayed off for other people.

Now the plugin's config is fully **self-contained** (`$DSH_HOME/dsh-pet/extras-config.json`); it does not read `dsh-pet`'s config and does not need `dsh-pet/assets/config.jsonc` edited.

The only remaining `dsh-pet` modification is the optional work-status patch — see [Work-status bubble vs. pet chat](#work-status-bubble-vs-pet-chat). If it cannot apply, it skips itself and everything else still works.
---

## Configuration

**Recommended: change these in DSH settings → Pet extras** (switch + number field, applied on save).

The config file lives at `$DSH_HOME/dsh-pet/extras-config.json`. It is also reachable over HTTP:

```bash
# Read the current config
curl http://127.0.0.1:<PORT>/dsh-pet-extras/config

# Change config (send only the fields you want to change)
curl -X PUT http://127.0.0.1:<PORT>/dsh-pet-extras/config \
  -H 'content-type: application/json' \
  -d '{"screenshotEnabled": true, "sightShareMinGap": 60}'
```

`<PORT>` is DSH's web port — the same number in your address bar.

| Key | Type | Default | Description |
|---|---|---|---|
| `agentBridgeEnabled` | bool | `false` | **The foundation switch**: deliver pet messages to a host session. **Turn it off and "Watch the screen" cannot deliver either** — narration goes through this same path |
| `targetSessionId` | string | `""` | **Connected session** (the authoritative key): the full session id, e.g. `session-1d86…`. **Empty = no delivery and no capture.** If the id no longer exists, nothing is delivered — it never silently switches to another session |
| `agentBridgeTarget` | string | `""` | Legacy: session title. The settings page writes it alongside `targetSessionId`; used only as a fallback when `targetSessionId` is empty |
| `screenshotEnabled` | bool | `false` | **Watch-the-screen master switch**: on = timed capture + every shot handed to the connected session (costs tokens per image); off = everything stops. **Requires `agentBridgeEnabled` to be on as well** |
| `sightShareMinGap` | number | `60` | **The only pace knob**: minimum seconds between one share and the next (minimum 5). This is a **gate, not a metronome** — real triggering is also affected by the screenshot helper's 20-second polling alignment, the session's generation time, and occasional skipped ticks. See "Real pacing" below. For a steadier cadence use a multiple of 20 |
| ~~`screenshotIntervalSec`~~ | number | `20` | **Deprecated**: the interval is decided by `sightShareMinGap` above. The default stays only so old config files still parse; changing it has no effect |
| `confineToScreen` | bool | `true` | Keep the window inside the screen work area |
| `screenshotKeep` | number | `60` | How many screenshot files to keep (1–2000); oldest deleted first |
| `lookLearnEnabled` | bool | `false` | Self-learning for narration (see below) |
| `lookRulesMaxChars` | number | `1200` | Stop applying learned rules beyond this length (0–4000) |
| Extra narration rules | file | — | Written in `$DSH_HOME/dsh-pet/看图播报要求.md` (not a config key; a template is created on first use) |

> **Switch dependencies**: `agentBridgeEnabled` is the foundation and `screenshotEnabled` sits on top of it. Both on means "Watch the screen" is actually running; `screenshotEnabled` alone only ever reports `disabled`.

> **Note**: there is no synchronisation with the `dsh-pet` settings page — that claim (and the code behind it) is gone. This plugin's settings are edited only in Settings → Pet extras.

---

## HTTP API

All routes are under `/dsh-pet-extras`:

| Method | Path | Description |
|---|---|---|
| GET | `/ping` | Health check: plugin name, version, DSH_HOME |
| GET | `/config` | Current config plus defaults |
| PUT/POST | `/config` | Update config (partial keys allowed) |
| GET | `/screenshot` | List recent screenshots and switch state |
| POST | `/screenshot` | Capture one immediately (spawns the helper) |
| GET | `/agent` | Bridge status: target session, queue depth, candidate sessions |
| POST/PUT | `/agent` | Body `{"sessionId": "..."}` to retarget; `{"text": "..."}` to deliver one message; add `"async": true` to return immediately and narrate in the background |
| GET | `/confine` | Read the keep-on-screen flag |
| PUT/POST | `/confine` | Body `{"value": true}` — pushed to `dsh-pet` immediately |
| GET | `/sights?limit=N` | Recent N sighting records (default 50, max 500) |
| DELETE | `/sights` | Clear the sighting log |
| POST | `/rate` | Body `{"index": 0, "rate": "good"\|"bad"\|""}` — rate one narration |
| GET | `/learn` | Self-learning status and learned rules |
| POST | `/learn` | Run self-learning once (requires `lookLearnEnabled: true`) |

---

## How it works

### Screenshots

The DSH host process cannot reach `desktopCapturer` (that is an Electron renderer capability), so the plugin **spawns its own minimal Electron process** for capture:

- Entry point: `runtime/electron-helper/main.cjs`
- It starts an HTTP server on `127.0.0.1:<random port>` that listens on loopback only, and prints the address to stdout on startup
- The host extracts the port from stdout with a regex and then calls `POST /shot` to request a capture
- PNGs land in `$DSH_HOME/dsh-pet/screenshots/`, 60 kept by default

**Why not IPC/stdin**: in testing, stdin to a spawned Electron process does not work — written lines are never received. Hence loopback HTTP.

### Agent bridge

This does not copy context across. It genuinely enters that session:

1. Pick a host session according to `agentBridgeTarget` (or the automatic rule)
2. Wait for it to become idle
3. `followup` the pet's message into it
4. Wait for the turn to finish, then extract the body of `assistant/message` events
5. Speak the reply through the pet, one bubble per sentence

The benefit is sharing that session's full context and memory with no duplicate store. The cost is queueing: while that session is busy, the pet has to wait.

**How pet replies are distinguished from things you typed**: delivered text is prefixed with three zero-width spaces as a fence. When collecting replies the plugin only reads events after that fence, so your own conversation is never read aloud as if it were the pet's answer.

### Narration

Narration is not a read-out of detection results; the pet is meant to mutter a remark the way a person would:

- The prompt explicitly forbids report-style openers like "On the screen…" or "In the image…", and forbids reusing the same opener every time
- When unsure, stay vague ("scrolling short videos", "playing a game") — **better vague than wrong**
- It may have its own reactions and opinions, but must **not invent** things it cannot see
- Opening interjections are randomised ("took a peek —", "hey,", "huh," …) and **only added when the body reads like a dry detection report**

There is also a code-level filter: if a sentence contains two or more descriptive words such as "screenshot", "window", "right side", "comments", "progress bar", the whole sentence is dropped. If nothing human survives, **it stays silent for that round** — better silence than reading out a screen description.

Bubble duration is computed from text length (5.5 characters per second × 2.6 headroom, clamped to 8–45 seconds), not a fixed value. Short lines stay at least 8 s, a typical 20-character line gets 13–14 s, and long ones can reach 45 s.

#### Real pacing: the configured interval is not the gap between two narrations

`Watch interval` is a **gate** (at least this long between two shares), not a **metronome** (a narration every N seconds, guaranteed). The real gap between two narrations = interval + the following:

| Item | Typical extra | Why |
| --- | --- | --- |
| Screenshot helper polling alignment | 0–20 s | The helper checks for a new image every 20 s, so the actual trigger aligns to the next 20-second tick |
| Session generating the reply | 1–6 s | The session has to actually run a turn before there is anything to say |
| Skipped tick | up to one interval | When a round is judged `too-soon` or misses the slot, everything shifts back one tick |

**So with 120 s configured, expect roughly 2 min 05 s – 2 min 25 s between narrations; occasionally a gap of 3.5 minutes or more** (when a tick is skipped). With 60 s, expect about 1 min 05 s – 1 min 25 s.

For the steadiest cadence, set the interval to a **multiple of 20** (20 s is the helper's minimum polling granularity) — 60 / 120 / 180 — which minimises jitter.

> To watch the real pacing, search `$DSH_HOME/dsh-pet/extras.log` for `准备播报` or `这一轮跳过（too-soon）`; every line carries a millisecond timestamp.

### Self-learning for narration (off by default)

With `lookLearnEnabled` on, you can rate narrations good/bad via `POST /rate`. Then `POST /learn` feeds the rated samples to the model, which summarises "what sounds like a person talking", and writes the result to `$DSH_HOME/dsh-pet/look-rules.txt`. Later narrations take those rules into account.

**It does not learn from the internet, and it cannot change the pet's personality**:

- The only input is the local `dsh-pet/视野/index.jsonl`; nothing is fetched
- **The personality is not decided by this plugin**: narration comes out of your connected session, so the voice and manner follow the tone you use in that session. The plugin only handles the "don't sound like a manual" layer of wording and cannot touch personality. This is a result of the 2026-10-24 rework — earlier versions hard-coded a personality here (`LOOK_PERSONA_CORE`), and it has been removed
- If the learned rules contain personality-rewriting content such as "you are / your identity / you are actually", they are rejected outright and the whole rule set is discarded
- Rules longer than `lookRulesMaxChars` are not applied at all (not truncated — a truncated rule is more likely to go wrong)

---

## Compatibility

- Direct dependencies: **Node.js built-ins only** (`node:fs`, `node:http`, `node:child_process`, …). No `@deepseek-ai/*` imports, so version mismatches cannot break it
- Host services obtained via `inject`: `webServer`, `attachments`, `agentDefaultModel`, `agents`, `llm`
- Coupling with dsh-pet is HTTP-only: `POST /dsh-pet-7340/broadcast` (speak), `POST /dsh-pet-7340/anim` (animation), `GET /dsh-pet-7340/config` (read pet config). **All of these are public routes in stock dsh-pet** — no patched build required
- All paths resolve through the `DSH_HOME` environment variable; **no absolute paths are hard-coded**
- Window placement is computed live from `screen.getPrimaryDisplay().workArea`

### System notifications

`dsh-pet` ships its own system notifications (turn completed / generation failed / output
truncated / permission asked / waiting on you), popped into the corner when the window is
not focused.

If they get in the way, set `notificationsEnabled` to `false` in
`$DSH_HOME/dsh-pet/main-config.jsonc`. That is the master switch — it turns all of them off
at once. This plugin has no notifications of its own and never touches that key.

---

## Privacy and data handling (**please read before installing**)

This plugin captures your **entire primary screen**. Screenshots may contain chat logs, password fields, or other people's private information. Please make sure you are comfortable with the following.

### What is captured, and where it is stored

- It captures the **entire primary display** at your configured interval and saves a PNG under `$DSH_HOME/dsh-pet/screenshots/`
- By default the file **stays on your local disk**; the plugin uploads it nowhere
- The number of files rolls over according to `screenshotKeep` (60 by default); delete the directory at any time

### When data leaves your machine

**There is exactly one condition: you turn on `screenshotEnabled` (off by default).**

Once enabled, every new screenshot is handed to **the model you configured in DSH** for analysis. That means:

- Image content is sent as a request to **that model provider** (DeepSeek, or whichever provider you configured)
- It uses **your own API key**; billing and authorisation are your responsibility
- There is no third-party relay and **no hidden telemetry endpoint** (verify with `grep`: the code only talks to local `127.0.0.1` and the host-provided `ctx.llm`)

**If you do not want images to leave your machine, keep `screenshotEnabled: false`.** Screenshots then stay on disk only.

### What else it writes

| Path | Contents | Control |
|---|---|---|
| `$DSH_HOME/dsh-pet/screenshots/*.png` | Raw screenshots | `screenshotKeep` |
| `$DSH_HOME/dsh-pet/视野/index.jsonl` | Index of every look: time, image path, size, **the session's raw analysis** | kept 7 days, `DELETE /sights` clears the index |
| `$DSH_HOME/dsh-pet/视野/YYYY-MM-DD/*.png` | The original full-screen captures | folders older than 7 days are removed automatically |
| `$DSH_HOME/dsh-pet/memory.json` | dsh-pet's chat memory, with sighting conclusions mirrored in | Stops when `screenshotEnabled` is off |
| `$DSH_HOME/dsh-pet/extras-config.json` | Plugin config | — |
| `$DSH_HOME/dsh-pet/look-rules.txt` | Rules produced by self-learning (absent if never used) | `lookLearnEnabled` |

Narration has exactly **one** path: the screenshot is handed to the connected session.

| | What is sent | What the session gets | Cost |
|---|---|---|---|
| (early `sightingInject`, removed) | One sentence | A retelling (knows "watching Douyin", never saw the picture) | Very low |
| **Current narration** | **The screenshot itself** | Really sees it, can judge on its own, and it lands in the conversation | **≈76k tokens per share** (97% of it is that session's history; the image itself is only 1–2k) |

Two gates before each share: **more than `sightShareMinGap` seconds since the last share**, and **the session itself says the scene changed** (answering with a bare "没" meaning "nothing new", or replying almost the same as last time, sends nothing).

> **Why the "share toggle" is gone**: early versions had a `sightShareEnabled` flag that only controlled "attach the image or not". Turning it off produced "send a sentence without the picture" — the session was told *go look at the screen* while seeing nothing, so it could only make things up. After the merge: **narration means sharing the screenshot; if you don't want to share, don't narrate** — decided solely by `screenshotEnabled`. `sightShareMinGap` stays, because "how often to look" is a knob that genuinely needs tuning.

> **Migration note**: the early `sightingInject` / `sightingKeep` / `lookPersonaOwner` / `sightShareEnabled` keys have been removed, and **`screenshotWatchEnabled` went away with the switch merge** (2026-10-24: "timed capture" and "timed screen reading" were two switches nobody could keep straight; they are now one `screenshotEnabled` — on means capture + share, off means everything stops). Leaving any of them in an old config file causes no errors — the plugin scrubs them on startup.

> ⚠️ **Cost estimate**: about 76k tokens per share (see table above). At a 120 s interval and eight hours of continuous use that is roughly 240 shares ≈ **18 million tokens**; at 60 s it doubles to ≈ 36 million. This is a real per-hour expense — **doubling the interval halves the bill**, which beats any amount of image compression.

### Permission notes (for security scanners)

- Uses `child_process.spawn` to launch an **Electron child process** as the capture helper. The only file launched is the fixed in-package path `runtime/electron-helper/main.cjs`; **no external commands or arguments are accepted**, so there is no remote code execution surface
- The helper opens an HTTP server on `127.0.0.1` at a random port — loopback only, not reachable from the LAN
- The services requested via `inject` are functionally required: `attachments` (store images), `llm` (analyse images), `agents` (inject into sessions), `webServer` (provide routes)
- **Does not read secrets from environment variables, does not write to the registry, installs no dependencies, and has no postinstall script**

---

## Known issues (being honest — this release is not perfect)

- **Desktop mode only** (`display: desktop`). In web mode there is no Electron process and capture is unavailable
- Changes to `sightShareMinGap` **apply automatically** — the helper restarts itself when the interval changes, no manual step needed
- **The agent bridge is serial.** While you are talking to the pet, the target session is very likely busy (it is the one you are using). The pet has to queue. It waits up to 90 seconds for idle, then answers "busy". This is a design trade-off, not a bug: pick an idle session, or turn the bridge off, if you want instant replies
- Narration depends on `dsh-pet`. Without it (or with a very old version), analysis still runs but nothing can be spoken (`pet-unavailable`)
- **This is `0.2.0`, the author's first GitHub release**, so there may be edge cases I have not thought of. If you hit one, please open an issue and attach `$DSH_HOME/dsh-pet/extras.log` — it makes debugging much easier
- Only tested on Windows with the DSH desktop build. Other platforms should work in principle (all paths go through `DSH_HOME`) but have not been tested

### Work-status bubble vs. pet chat

`dsh-pet` delivers its messages in the shape of an ordinary user message (`source.id` starts with `dsh-pet-`), so the host cannot tell "the human typed this" from "the pet posted this" — which means pet turns also light up the "thinking / tool call" bubble.

> **Early 0.1.0/0.1.x builds failed on other people's machines with `anchor-miss:fence`**: their anchors relied on a constant that only existed in the `dsh-pet` we had patched locally; stock 0.3.8 has no such constant. It has been rewritten as v2, anchored entirely on **stock code**, and validated on a clean 0.3.8 copy with 12 install tests + 10 behaviour tests.

This plugin patches that automatically, but **only after the `dsh-pet` version changes**: it touches its files exactly once per new version, records what it did in `$DSH_HOME/dsh-pet/extras-state.json`, and otherwise stays out of the way. Notes:

- It edits the source on disk, so the fix applies on the **next DSH start**, not immediately
- It backs up first, to `lib/index.js.bak-workstatus-guard` (once only — the original is kept)
- It only patches the `0.x` series; if `dsh-pet`'s structure changes so the anchors no longer match, it **gives up and logs** rather than risk breaking someone else's package
- To undo: restore the backup over `lib/index.js` and delete that entry from `extras-state.json`

If the auto-patch does not land (check the `工作状态补丁` lines in `extras.log`), the installed `dsh-pet` has changed shape — patch it by hand or wait for a plugin update.

---


### This plugin modifies files in `dsh-pet` — here is exactly what and why

To be upfront: **this plugin modifies one source file of the `dsh-pet` you installed** (`node_modules/dsh-pet/lib/index.js`). This section lays every change out.

**Why it has to**: the work-status bubble ("thinking… / calling tools") is computed by `dsh-pet` itself. It listens to all session events from the host and raises the status by event type. Messages delivered by the pet look like `{kind:"user", id:"dsh-pet-<timestamp>"}` — **structurally identical** to something you typed, so `dsh-pet` cannot tell them apart, and the pet's turns light the bubble as if work were happening. The plugin cannot intercept this: those events go from the host to `dsh-pet`, and the plugin is not on that chain.

**The exact edits (4 insertions, all anchored on stock 0.3.8 code)**:

| # | Anchor (present in stock `dsh-pet`) | What it does |
|---|---|---|
| 1 | after `const dispose = ctx.on("session/event", …)` | declares the `petPending` / `petTurn` bookkeeping |
| 2 | the `if (type === "user/message") {` branch | recognises a pet delivery (`source.kind` or `source.id` starting with `dsh-pet`) and flags it; clears the flag for the three host-injected kinds (`runtime-context`, `time-context`, `dsh-mnemon`) |
| 3 | the `if (type === "turn/start") {` branch | records whether this turn was started by the pet, following the queue semantics |
| 4 | before `const next = reduceWorkStatus(…);` | events from the pet's turn `return` immediately and never enter work status; on `turn/end` the flags clear and `workStatus.clear` runs |

**What is NOT touched**: message delivery, screenshots, shrinking, the sight archive, session contents, and any data file — **none of it**. The patch only changes "how a turn's events count as work status".

**How it stays safe**:

- Only acts on the first start after a version change, records it in `$DSH_HOME/dsh-pet/extras-state.json`, and stays out of the way while the version is unchanged
- Backs up to `lib/index.js.bak-workstatus-guard` first (once only, keeping the original)
- Only patches the `0.x` series; if a structural change makes an anchor miss, it **gives up and logs**, never forcing an edit
- Verifies all 4 fingerprints after editing and abandons the whole thing if any is missing
- Edits the on-disk source; **takes effect on the next DSH start**

**To undo**:

```bash
# restore from the backup and drop the state record, then it will not patch again
cp "$DSH_HOME/profiles/desktop/node_modules/dsh-pet/lib/index.js.bak-workstatus-guard"    "$DSH_HOME/profiles/desktop/node_modules/dsh-pet/lib/index.js"
```

Then delete the `petWorkStatusPatch` entry from `$DSH_HOME/dsh-pet/extras-state.json` (that file holds only this one entry, so deleting the file also works).

**Do not want it patched at all?** Uninstall the plugin. If auto-patching does not take effect, `extras.log` has `工作状态补丁` lines explaining why.

## Uninstallation

```bash
dsh plugin remove dsh-pet-extras
```

Then restart DSH.

Uninstalling **does not delete your data**. To clean up fully, remove these (all under `$DSH_HOME/dsh-pet/`):

| Path | What it is |
|---|---|
| `screenshots/` | Screenshot PNGs, potentially large |
| `视野/` | Sight archive: originals + the session's raw analysis |
| `extras-config.json` | Plugin config |
| `extras.log` | Runtime log |
| `look-rules.txt` | Learned narration rules |
| `extras-state.json` | Plugin state (currently: which dsh-pet version was patched) |

`memory.json` belongs to dsh-pet — **do not delete it**; it holds the pet's chat memory and has nothing to do with this plugin.

---

## FAQ

**I cannot see any settings.**
This plugin has its own settings page: **Settings → Pet extras** (the "Watch the screen" switch and interval provided by `dsh-pet-extras`; the section is hidden when `dsh-pet` is not installed). In addition, the `screenshotEnabled` and `agentBridgeEnabled` keys are the same keys the `dsh-pet` settings page uses, so changing them from either side works.

**"Watch the screen" is enabled but the screenshot directory stays empty.**
Check two things: (1) the pet's display mode is `desktop` (web mode has no Electron process); (2) `GET /dsh-pet-extras/screenshot` reports `enabled: true`. After changing the interval, the helper must restart — a manual `POST /dsh-pet-extras/screenshot` triggers that restart immediately.

**The pet takes a long time to reply, or just says "busy".**
The agent bridge is serial: while the target session is running a task, the pet must queue. It waits at most 90 seconds for idle. For instant replies, turn the bridge off or point it at an idle session (by title or id).

**Narration has gone quiet for a while.**
That is intentional. The model occasionally emits report-style text ("the screen shows a screenshot with…"), and the plugin drops it rather than reading it aloud. Several silent rounds in a row means the screen content genuinely did not lend itself to a human-sounding remark.

**I changed monitors or display scaling and the pet window is off-screen again.**
Enable `confineToScreen`; the plugin pushes it to dsh-pet at startup and whenever the config changes.

---

## Credits

- The pet itself comes from [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet) (MIT). This project **only calls its public HTTP routes** and does not copy its code. The pet being adorable is the original author's work; this plugin merely adds a few things on top
- Host framework: [DeepSeek Harness](https://github.com/deepseek-ai)

## License

MIT — see [LICENSE](LICENSE).

This project is not affiliated with, nor endorsed by, the author of `dsh-pet`. Copyright of `dsh-pet` belongs to `PC2005-cloud`.
