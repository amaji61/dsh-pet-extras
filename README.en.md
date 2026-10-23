# dsh-pet-extras

Extra capabilities for [`dsh-pet`](https://github.com/PC2005-cloud/dsh-pet), the desktop pet plugin for [DeepSeek Harness](https://github.com/deepseek-ai) (DSH).

> **This plugin does not provide the pet itself.** It is meaningless without `dsh-pet` — install that one first.
>
> **This is a hobby project by an individual developer, not an official extension, and not affiliated with the `dsh-pet` author.** It is at `0.1.0`, an early release. This is the author's first time publishing on GitHub, so **there may still be bugs**. Issues are welcome and I'll do my best to fix them.

> 中文说明见 [README.md](README.md).

---

## ⚠️ Read this first: it captures your entire screen

**If you are not comfortable with this section, please do not install.**

| What it does | What you should know |
|---|---|
| Captures a **full-screen image of the primary display** at an interval you set | Screenshots may contain chat logs, password fields, or other people's private information |
| By default, **stores them on your local disk only** | `$DSH_HOME/dsh-pet/screenshots/`. The plugin uploads them nowhere |
| Images are sent to a model **only after you enable "watch" yourself** | They go to **the model provider you configured in DSH**, billed to **your own API key** |

**Default state: timed capture is OFF, screen watching is OFF — no screenshots, no network, no model calls.** With everything off, it is just a plugin sitting on disk doing nothing.

If you never want images to leave your machine, simply never enable `screenshotWatchEnabled`.

See [**Privacy and data handling**](#privacy-and-data-handling-please-read-before-installing) below for the complete data-flow table.

---

## Features

| Feature | Description | Default |
|---|---|---|
| **Timed full-screen capture** | Grabs the primary display every N seconds and saves a local PNG. **No upload, no model call, no tokens spent** | Off |
| **Screen narration** | Each new screenshot is handed to a vision model, which produces one or two human-sounding remarks about what is on screen and what you are doing. Shown in the speech bubble above the pet, with a matching animation | Off |
| **Sighting log** | The text conclusion of every capture is appended to a rolling `sights.jsonl` and silently injected into the main session, so the agent actually knows what is happening on screen | Inject: on |
| **Agent bridge** | What you say to the pet is delivered into a real DSH session, and that session's reply is spoken back through the pet, sentence by sentence. Shares that session's context and memory | Off |
| **Keep on screen** | Pushes the `confineToScreen` flag to `dsh-pet` so the pet window cannot leave the screen bounds | On |

### How this differs from dsh-pet's built-in chat

`dsh-pet` has a small self-contained chat model: it only reads its own trimmed memory and knows nothing about the large context in your UI.

With the **agent bridge** enabled, what you say to the pet genuinely enters the session you have open — one brain, one context, one memory. It knows what you have been discussing. The trade-off is that everything it says also consumes that session's token budget, so heavy use hits the context limit sooner.

---

## Installation

```bash
dsh plugin add dsh-pet-extras
```

Restart DSH afterwards.

`dsh-pet` must already be installed (this plugin is an add-on for it).

---

## Configuration

The config file lives at `$DSH_HOME/dsh-pet/extras-config.json`. It is also reachable over HTTP:

```bash
# Read the current config
curl http://127.0.0.1:<PORT>/dsh-pet-extras/config

# Change config (send only the fields you want to change)
curl -X PUT http://127.0.0.1:<PORT>/dsh-pet-extras/config \
  -H 'content-type: application/json' \
  -d '{"screenshotEnabled": true, "screenshotIntervalSec": 30}'
```

`<PORT>` is DSH's web port — the same number in your address bar.

| Key | Type | Default | Description |
|---|---|---|---|
| `screenshotEnabled` | bool | `false` | Master switch for timed capture |
| `screenshotIntervalSec` | number | `20` | Interval in seconds; minimum 5 |
| `screenshotWatchEnabled` | bool | `false` | Send each new screenshot to the model (**one model call per image — costs tokens**) |
| `agentBridgeEnabled` | bool | `false` | Deliver pet messages to a host session |
| `agentBridgeTarget` | string | `""` | Pin a session by id **or session title**. Empty = automatically pick the longest-running one |
| `confineToScreen` | bool | `true` | Keep the window inside the screen work area |
| `screenshotKeep` | number | `60` | How many screenshot files to keep (1–2000); oldest deleted first |
| `sightingInject` | bool | `true` | Silently inject sighting conclusions into the main session (`agent.inject` — no wake, no UI interruption) |
| `sightingKeep` | number | `200` | How many entries `sights.jsonl` retains |
| `lookLearnEnabled` | bool | `false` | Self-learning for narration (see below) |
| `lookRulesMaxChars` | number | `1200` | Stop applying learned rules beyond this length (0–4000) |
| `lookRulesExtra` | string | `""` | Your own extra narration rules |

> **Note**: the capture and agent-bridge switches are synchronised with the `dsh-pet` settings page. You can change them from either side; `dsh-pet`'s settings are authoritative.

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

Bubble duration is computed from text length (5.5 characters per second × 1.8 headroom, clamped to 4–30 seconds), not a fixed value.

### Self-learning for narration (off by default)

With `lookLearnEnabled` on, you can rate narrations good/bad via `POST /rate`. Then `POST /learn` feeds the rated samples to the model, which summarises "what sounds like a person talking", and writes the result to `$DSH_HOME/dsh-pet/look-rules.txt`. Later narrations take those rules into account.

**It does not learn from the internet, and it cannot change the pet's personality**:

- The only input is the local `sights.jsonl`; nothing is fetched
- The core personality is compiled into the code (`LOOK_PERSONA_CORE`) and **learning cannot write into that layer**
- If the learned rules contain personality-rewriting content such as "you are / your identity / you are actually", they are rejected outright and the whole rule set is discarded
- Rules longer than `lookRulesMaxChars` are not applied at all (not truncated — a truncated rule is more likely to go wrong)

---

## Compatibility

- Direct dependencies: **Node.js built-ins only** (`node:fs`, `node:http`, `node:child_process`, …). No `@deepseek-ai/*` imports, so version mismatches cannot break it
- Host services obtained via `inject`: `webServer`, `attachments`, `agentDefaultModel`, `agents`, `llm`
- Coupling with dsh-pet is HTTP-only: `POST /dsh-pet-7340/broadcast` (speak), `POST /dsh-pet-7340/anim` (animation), `GET /dsh-pet-7340/config` (read pet config). **All of these are public routes in stock dsh-pet** — no patched build required
- All paths resolve through the `DSH_HOME` environment variable; **no absolute paths are hard-coded**
- Window placement is computed live from `screen.getPrimaryDisplay().workArea`

---

## Privacy and data handling (**please read before installing**)

This plugin captures your **entire primary screen**. Screenshots may contain chat logs, password fields, or other people's private information. Please make sure you are comfortable with the following.

### What is captured, and where it is stored

- It captures the **entire primary display** at your configured interval and saves a PNG under `$DSH_HOME/dsh-pet/screenshots/`
- By default the file **stays on your local disk**; the plugin uploads it nowhere
- The number of files rolls over according to `screenshotKeep` (60 by default); delete the directory at any time

### When data leaves your machine

**There is exactly one condition: you turn on `screenshotWatchEnabled` (off by default).**

Once enabled, every new screenshot is handed to **the model you configured in DSH** for analysis. That means:

- Image content is sent as a request to **that model provider** (DeepSeek, or whichever provider you configured)
- It uses **your own API key**; billing and authorisation are your responsibility
- There is no third-party relay and **no hidden telemetry endpoint** (verify with `grep`: the code only talks to local `127.0.0.1` and the host-provided `ctx.llm`)

**If you do not want images to leave your machine, keep `screenshotWatchEnabled: false`.** Screenshots then stay on disk only.

### What else it writes

| Path | Contents | Control |
|---|---|---|
| `$DSH_HOME/dsh-pet/screenshots/*.png` | Raw screenshots | `screenshotKeep` |
| `$DSH_HOME/dsh-pet/sights.jsonl` | **Text conclusions** per capture (no images), one per line | `sightingKeep`, `DELETE /sights` |
| `$DSH_HOME/dsh-pet/memory.json` | dsh-pet's chat memory, with sighting conclusions mirrored in | Stops when `screenshotWatchEnabled` is off |
| `$DSH_HOME/dsh-pet/extras-config.json` | Plugin config | — |
| `$DSH_HOME/dsh-pet/look-rules.txt` | Rules produced by self-learning (absent if never used) | `lookLearnEnabled` |

With `sightingInject` enabled, text conclusions are also **silently injected into the DSH session you are using** (`agent.inject` — no popup, no interruption), so the main session knows what is happening on screen. Turn `sightingInject` off to prevent that.

### Permission notes (for security scanners)

- Uses `child_process.spawn` to launch an **Electron child process** as the capture helper. The only file launched is the fixed in-package path `runtime/electron-helper/main.cjs`; **no external commands or arguments are accepted**, so there is no remote code execution surface
- The helper opens an HTTP server on `127.0.0.1` at a random port — loopback only, not reachable from the LAN
- The services requested via `inject` are functionally required: `attachments` (store images), `llm` (analyse images), `agents` (inject into sessions), `webServer` (provide routes)
- **Does not read secrets from environment variables, does not write to the registry, installs no dependencies, and has no postinstall script**

---

## Known issues (being honest — this release is not perfect)

- **Desktop mode only** (`display: desktop`). In web mode there is no Electron process and capture is unavailable
- Changes to `screenshotIntervalSec` take effect only after the helper restarts (a manual `POST /screenshot` triggers a restart)
- **The agent bridge is serial.** While you are talking to the pet, the target session is very likely busy (it is the one you are using). The pet has to queue. It waits up to 90 seconds for idle, then answers "busy". This is a design trade-off, not a bug: pick an idle session, or turn the bridge off, if you want instant replies
- Narration depends on `dsh-pet`. Without it (or with a very old version), analysis still runs but nothing can be spoken (`pet-unavailable`)
- **This is `0.1.0` and the author's first GitHub release**, so there may be edge cases I have not thought of. If you hit one, please open an issue and attach `$DSH_HOME/dsh-pet/extras.log` — it makes debugging much easier
- Only tested on Windows with the DSH desktop build. Other platforms should work in principle (all paths go through `DSH_HOME`) but have not been tested

---

## Uninstallation

```bash
dsh plugin remove dsh-pet-extras
```

Then restart DSH.

Uninstalling **does not delete your data**. To clean up fully, remove these (all under `$DSH_HOME/dsh-pet/`):

| Path | What it is |
|---|---|
| `screenshots/` | Screenshot PNGs, potentially large |
| `sights.jsonl` | Text sighting log |
| `extras-config.json` | Plugin config |
| `extras.log` | Runtime log |
| `look-rules.txt` | Learned narration rules |

`memory.json` belongs to dsh-pet — **do not delete it**; it holds the pet's chat memory and has nothing to do with this plugin.

---

## FAQ

**I cannot see any settings.**
This plugin has no settings panel of its own; its switches live in the dsh-pet settings page (Settings → Pet config). Without `dsh-pet` installed you will see no UI at all.

**Timed capture is enabled but the screenshot directory stays empty.**
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
