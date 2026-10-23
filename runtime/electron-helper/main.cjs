/**
 * dsh-pet-extras 的桌面 Helper（Electron 主进程）
 *
 * 只干一件事：抓屏幕并落盘。
 *
 * 为什么单独起一个 Electron 进程：截屏要 desktopCapturer，那是 Electron 才有的
 * 原生能力，宿主进程里没有。所以由宿主 spawn 这个脚本，先起一个只监听 127.0.0.1
 * 的小 HTTP 服务，再往 stdout 打一行
 *   [extras-shot] http://127.0.0.1:PORT
 * 宿主从日志行里抓到端口，之后 POST /shot 就抓一张。
 *
 * 为什么不走 stdin：Electron 主进程被 spawn 之后实测收不到通过 stdin 写进去的行
 * （写进去几十秒零回应），管道下发命令这条路走不通。
 *
 * 环境变量：
 *   DSH_PET_EXTRAS_SHOT_ENABLED   "1" 开启定时抓图（默认关）
 *   DSH_PET_EXTRAS_SHOT_INTERVAL  秒，最小 5，默认 20
 *   DSH_PET_EXTRAS_SHOT_DIR       落盘目录（必填，没有就只开服务不定时）
 *   DSH_PET_EXTRAS_SHOT_KEEP      保留张数，默认 60
 */

const { app, desktopCapturer, screen } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const SHOT_ENABLED = process.env.DSH_PET_EXTRAS_SHOT_ENABLED === '1';
const SHOT_INTERVAL_SEC = Math.max(5, Number(process.env.DSH_PET_EXTRAS_SHOT_INTERVAL) || 20);
const SHOT_DIR = process.env.DSH_PET_EXTRAS_SHOT_DIR || '';
const SHOT_KEEP = Math.max(1, Number(process.env.DSH_PET_EXTRAS_SHOT_KEEP) || 60);

let shotTimer = null;
let shotBusy = false;
let shotServer = null;

/** 目录里现有的截图，按文件名（含 ISO 时间）升序。 */
function listShots() {
	if (!SHOT_DIR) return [];
	try {
		return fs
			.readdirSync(SHOT_DIR)
			.filter((n) => /\.png$/i.test(n))
			.sort();
	} catch {
		return [];
	}
}

/**
 * 抓一张主屏，落盘。
 *
 * 尺寸按「逻辑分辨率 × 缩放因子」给，否则高分屏上会拿到一张缩小的糊图。
 * 返回 { ok, file, bytes, width, height } 或 { ok:false, reason, message? }。
 */
async function captureScreen(reason) {
	if (!SHOT_DIR) return { ok: false, reason: 'no-dir', message: '没有配置落盘目录' };
	if (shotBusy) return { ok: false, reason: 'busy', message: '上一张还没写完' };
	shotBusy = true;
	try {
		const display = screen.getPrimaryDisplay();
		const scale = display.scaleFactor || 1;
		const width = Math.round(display.size.width * scale);
		const height = Math.round(display.size.height * scale);
		const sources = await desktopCapturer.getSources({
			types: ['screen'],
			thumbnailSize: { width, height },
			fetchWindowIcons: false
		});
		const shot = sources.find((s) => String(s.display_id) === String(display.id)) || sources[0];
		if (!shot) return { ok: false, reason: 'no-source', message: '拿不到屏幕源' };
		const image = shot.thumbnail;
		if (!image || image.isEmpty()) return { ok: false, reason: 'empty', message: '抓到的画面是空的' };
		fs.mkdirSync(SHOT_DIR, { recursive: true });
		const name = `shot-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
		const file = path.join(SHOT_DIR, name);
		const png = image.toPNG();
		fs.writeFileSync(file, png);
		// 只留最近的 SHOT_KEEP 张（图片会一直堆积，必须自己收）
		const all = listShots();
		for (const old of all.slice(0, Math.max(0, all.length - SHOT_KEEP))) {
			try {
				fs.unlinkSync(path.join(SHOT_DIR, old));
			} catch {}
		}
		return { ok: true, file, bytes: png.length, width: image.getSize().width, height: image.getSize().height, reason };
	} catch (e) {
		return { ok: false, reason: 'shot-failed', message: e instanceof Error ? e.message : String(e) };
	} finally {
		shotBusy = false;
	}
}

/** 定时抓图的循环：setTimeout 链（不用 setInterval，免得慢的那张堆积）。 */
function armShot() {
	if (!SHOT_ENABLED || !SHOT_DIR) return;
	const tick = async () => {
		await captureScreen('timer').catch(() => {});
		shotTimer = setTimeout(() => void tick(), SHOT_INTERVAL_SEC * 1000);
		shotTimer?.unref?.();
	};
	shotTimer = setTimeout(() => void tick(), SHOT_INTERVAL_SEC * 1000);
	shotTimer?.unref?.();
}

/** HTTP 通道：POST /shot 抓一张，GET /health 探活。只监听 127.0.0.1。 */
function startShotChannel() {
	shotServer = http.createServer((req, res) => {
		const send = (status, obj) => {
			res.statusCode = status;
			res.setHeader('content-type', 'application/json; charset=utf-8');
			res.end(JSON.stringify(obj));
		};
		const url = (req.url || '/').split('?')[0];
		if (req.method === 'POST' && url === '/shot') {
			captureScreen('manual').then((r) => send(200, r), (e) => send(500, { ok: false, reason: 'shot-failed', message: String(e) }));
			return;
		}
		if (req.method === 'GET' && url === '/health') {
			send(200, { ok: true, enabled: SHOT_ENABLED, intervalSec: SHOT_INTERVAL_SEC, dir: SHOT_DIR });
			return;
		}
		send(404, { ok: false, error: 'dsh-pet-extras helper: unknown path ' + url });
	});
	shotServer.on('error', (e) => {
		process.stderr.write('[extras-shot] server error: ' + (e && e.message) + '\n');
	});
	shotServer.listen(0, '127.0.0.1', () => {
		const addr = shotServer.address();
		// 宿主靠这一行正则抓端口，格式别改
		process.stdout.write('[extras-shot] http://127.0.0.1:' + addr.port + '\n');
	});
	// 别让这个服务把进程钉住：宿主退出时跟着走
	shotServer.unref();
}

// 单实例：宿主重启可能留下旧的 helper，两个都跑会抢屏幕
if (!app.requestSingleInstanceLock()) {
	app.quit();
} else {
	app.disableHardwareAcceleration();
	app.whenReady().then(() => {
		startShotChannel();
		if (SHOT_ENABLED) {
			process.stderr.write('[extras-shot] screenshots ON every ' + SHOT_INTERVAL_SEC + 's -> ' + SHOT_DIR + ' (keep ' + SHOT_KEEP + ')\n');
			armShot();
		} else {
			process.stderr.write('[extras-shot] screenshots OFF (manual still available)\n');
		}
	});
	// 没有窗口，不能因为「所有窗口都关了」退出
	app.on('window-all-closed', () => {});
	app.on('before-quit', () => {
		if (shotTimer) clearTimeout(shotTimer);
		try {
			shotServer?.close();
		} catch {}
	});
}
