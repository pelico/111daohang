/**
 * nas-ingest
 * 定时采样各 node_exporter /metrics 源，服务端计算速率，写入 D1(历史) + KV(实时快照/设备表)。
 *
 * 阶段 1：单设备跑通。优先读 vars.METRICS_URL；为空时回退读 KV device:list（多源，阶段3）。
 * 计数器用 BigInt 处理，避免 uint64 绕回 / 精度丢失；boot_time 变化则重置速率基准。
 */
import { parseVmMetrics } from './parse.js';

// 抽取一个 metrics 源的速度基准：请求超时，防止一个源卡死整体
const FETCH_TIMEOUT_MS = 15000;
// 历史采样在 D1 的保留天数（与每日清理 Cron 对齐，仅作写前兜底）
const RETENTION_DAYS = 30;
// 物理上限：网络速率 > 5GB/s（≈40Gbps）视为"不可能"读数，丢弃；温度合理范围
const MAX_NET_BPS = 5e9;
const TEMP_MIN = -20, TEMP_MAX = 120;

let lastRun = 0;

async function fetchSource(url, signal) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	signal?.addEventListener('abort', () => controller.abort(), { once: true });
	try {
		const res = await fetch(url, { signal: controller.signal, headers: { accept: 'text/plain' } });
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		return await res.text();
	} finally {
		clearTimeout(timer);
	}
}

export default {
	async scheduled(event, env, ctx) {
		const started = Date.now();
		const results = [];
		try {
			const sources = await resolveSources(env);
			await Promise.all(
				sources.map(async url => {
					try {
						await ingestOne(url, env, started);
						results.push({ url, ok: true });
					} catch (e) {
						console.error(`ingest[${url}]`, e);
						results.push({ url, ok: false, error: e.message });
					}
				})
			);
		} catch (e) {
			console.error('ingest batch failed', e);
		}
		// 全链路是否成功写入 D1，作为健康检查信号（用于 /health 与调试）
		await env.KV.put('ingest:last_status', JSON.stringify({
			ts: Math.floor(started / 1000),
			durationMs: Date.now() - started,
			results,
		}));
		// 扩展执行时间，避免日志被截断/超时
		ctx.waitUntil(Promise.resolve());
	},

	async fetch(request, env) {
		const url = new URL(request.url);
		if (url.pathname === '/health') {
			const st = await env.KV.get('ingest:last_status', 'text');
			return json(st ? JSON.parse(st) : { ts: 0, results: [] });
		}
		return json({ ok: true, hello: 'nas-ingest' });
	},
};

async function resolveSources(env) {
	// 总是合并 device:list 里登记的多源（含前端/断链/新增），再补默认单源，按 url 去重
	const urls = [];
	const seen = new Set();
	const add = u => { if (u && !seen.has(u)) { seen.add(u); urls.push(u); } };

	const raw = await env.KV.get('device:list', 'text');
	if (raw) {
		let ids = [];
		try { ids = JSON.parse(raw); } catch (e) { /* 忽略 */ }
		const metas = await Promise.all(ids.map(id => env.KV.get(`dev:meta:${id}`, 'json')));
		for (const m of metas) if (m && m.url) add(m.url);
	}
	if (env.METRICS_URL) add(env.METRICS_URL);
	return urls;
}

async function ingestOne(url, env, nowMs) {
	const text = await fetchSource(url);
	const m = parseVmMetrics(text);

	const nowSec = Math.floor(nowMs / 1000);
	// 设备号：若该 URL 已在寄存器登记过（设置弹窗添加），沿用其 id 保持前后台一致；
	// 否则优先真实主机名，泛化名（node_exporter/docker 容器环境）时改用链接 host 主标签
	const deviceId = await deviceIdForUrl(env, url, m.hostname);

	// 读取上次基准（原始计数器 + 采样时间）
	const prev = (await env.KV.get(`dev:prev:${deviceId}`, 'json')) || null;

	let upBps = 0, downBps = 0, cpuPct = null;
	const rebooted = prev && m.bootTime > 0 && prev.bootTime > 0 && m.bootTime !== prev.bootTime;

	if (prev && !rebooted) {
		const dtSec = nowSec - prev.ts;
		if (dtSec > 0) {
			downBps = safeRate(m.net.recv, prev.net.recv, dtSec);
			upBps = safeRate(m.net.sent, prev.net.sent, dtSec);
			if (m.cpu.idleValid && prev.cpu.idle > 0 && m.cpu.total > prev.cpu.total) {
				const idleDiff = m.cpu.idle - prev.cpu.idle;
				const totalDiff = m.cpu.total - prev.cpu.total;
				if (totalDiff > 0) cpuPct = Math.max(0, Math.min(100, 100 * (1 - Number(idleDiff) / Number(totalDiff))));
			}
		}
	}
	const memPct = clampPct(m.memPct);
	const tempC = sanitizeTemp(m.temp);

	// 写 D1 历史（UPSERT，主键 device_id+ts）
	await env.DB.prepare(
		`INSERT OR REPLACE INTO samples (device_id, ts, cpu, mem, up_bps, down_bps, temp)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`
	)
		.bind(deviceId, nowSec,
			cpuPct == null ? null : round(cpuPct, 1),
			memPct,
			round(upBps), round(downBps),
			tempC)
		.run();

	// 登记设备表（自动发现 / 换域名识别同一台）
	await env.DB.prepare(
		`INSERT INTO devices (device_id, url, hostname, first_seen, last_seen)
		 VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT(device_id) DO UPDATE SET
		   url = excluded.url, hostname = COALESCE(excluded.hostname, devices.hostname), last_seen = excluded.last_seen`
	)
		.bind(deviceId, url, m.hostname || null, nowSec, nowSec)
		.run();

	// 实时快照（前端零计算读这里）
	await env.KV.put(`device:last:${deviceId}`, JSON.stringify({
		device_id: deviceId, url, ts: nowSec,
		bootTime: m.bootTime || 0,
		cpu: cpuPct == null ? null : round(cpuPct, 1),
		mem: memPct,
		up: round(upBps), down: round(downBps),
		temp: tempC,
		fs: m.fs.total > 0 ? { total: Math.round(m.fs.total), avail: Math.round(m.fs.avail) } : null,
	}));

	// 更新设备列表 + 元数据（KV，前端 index/realtime 读 device:list 和 dev:meta）
	await addToDeviceList(env, deviceId, url);

	// 保存本次原始计数器，作为下次基准（BigInt 以字符串保存，避免精度丢失）
	await env.KV.put(`dev:prev:${deviceId}`, JSON.stringify({
		ts: nowSec,
		bootTime: m.bootTime || 0,
		net: { recv: m.net.recv.toString(), sent: m.net.sent.toString() },
		cpu: { total: m.cpu.total.toString(), idle: m.cpu.idle.toString() },
	}));

	// 写前兜底滚动删除（与 Cron 双保险；见下方 dailyCleanup）
	await maybeCleanup(env, nowSec);
}

// 生成稳定的设备标识：优先复用寄存器里已登记的 id（保证前后台一致），否则用真实主机名，泛化时用链接 host 主标签
async function deviceIdForUrl(env, url, hostname) {
	const raw = await env.KV.get('device:list', 'text');
	if (raw) {
		let ids = [];
		try { ids = JSON.parse(raw); } catch (e) {}
		for (const id of ids) {
			if (typeof id !== 'string') continue;
			const m = await env.KV.get(`dev:meta:${id}`, 'json');
			if (m && m.url === url) return id;
		}
	}
	return deviceIdFor(url, hostname);
}

function deviceIdFor(url, hostname) {
	const sanitize = s => s.toLowerCase().replace(/[^a-z0-9_.-]/g, '_');
	if (hostname && !/^(node_exporter|localhost|docker|gateway|unraid)$/i.test(hostname)) {
		const clean = sanitize(hostname);
		if (clean) return clean;
	}
	const h = sanitize(new URL(url).hostname);
	return h.split('.')[0] || h;
}

// 用原始计数差值算速率（B/s）；异常（绕回/为负/超物理上限）返回 0，不污染图表
function safeRate(curStr, prevStr, dtSec) {
	try {
		const cur = BigInt(curStr), prev = BigInt(prevStr);
		if (cur < prev) return 0;
		const diff = cur - prev;
		const perSec = Number(diff) / dtSec;   // Number 转换在速率量级下安全
		if (!Number.isFinite(perSec) || perSec < 0 || perSec > MAX_NET_BPS) return 0;
		return perSec;
	} catch (e) { return 0; }
}

// 百分比 clamp 到 [0,100]；非法返回 null
function clampPct(v) {
	if (v == null || !Number.isFinite(v)) return null;
	return round(Math.max(0, Math.min(100, v)), 1);
}

// 温度合理性校验：先按摄氏度判断；超出范围可能为毫摄氏度（node_exporter 常见），÷1000 后若合理则采纳；否则视为传感器异常
function sanitizeTemp(v) {
	if (v == null || !Number.isFinite(v)) return null;
	if (v >= TEMP_MIN && v <= TEMP_MAX) return round(v, 1);
	const c = v / 1000;
	if (c >= TEMP_MIN && c <= TEMP_MAX) return round(c, 1);
	return null;
}

async function addToDeviceList(env, deviceId, url) {
	// 写入元数据，保证前端 /api/nas/index 能拿到 url（否则设备会被过滤掉）
	if (url) {
		const meta = (await env.KV.get(`dev:meta:${deviceId}`, 'json')) || {};
		if (meta.url !== url) {
			meta.id = deviceId; meta.url = url;
			if (!meta.added) meta.added = Math.floor(Date.now() / 1000);
			await env.KV.put(`dev:meta:${deviceId}`, JSON.stringify(meta));
		}
	}
	const raw = await env.KV.get('device:list', 'text');
	let list = [];
	try { if (raw) list = JSON.parse(raw); } catch (e) {}
	if (!list.includes(deviceId)) {
		list.push(deviceId);
		await env.KV.put('device:list', JSON.stringify(list));
	}
}

// 滚动清理：带节流（每 6 小时最多一次），避免每 60s 都跑 DELETE。崩溃/重启由 Cron 与 dailyCleanup 兜底
async function maybeCleanup(env, nowSec) {
	try {
		const last = parseInt(await env.KV.get('ingest:last_cleanup', 'text') || '0', 10);
		if (nowSec - last < 6 * 3600) return;
		const deadline = nowSec - RETENTION_DAYS * 86400;
		await env.DB.prepare('DELETE FROM samples WHERE ts < ?').bind(deadline).run();
		await env.KV.put('ingest:last_cleanup', String(nowSec));
	} catch (e) { /* 忽略，下次再试 */ }
}

// 每日滚动清理（供 Cron 单独调度，或手动执行）
export async function dailyCleanup(env) {
	const deadline = Math.floor(Date.now() / 1000) - RETENTION_DAYS * 86400;
	await env.DB.prepare('DELETE FROM samples WHERE ts < ?').bind(deadline).run();
	await env.KV.put('ingest:cleanup_at', String(Date.now()));
}

function round(n, p = 2) {
	const f = Math.pow(10, p);
	return Math.round(n * f) / f;
}

function json(obj, status = 200) {
	return new Response(JSON.stringify(obj), {
		status,
		headers: { 'Content-Type': 'application/json; charset=utf-8' },
	});
}