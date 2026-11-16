/**
 * nas-ingest
 * 定时采样各 node_exporter /metrics 源，服务端计算速率，写入 D1(历史) + KV(实时快照/设备表)。
 *
 * 阶段 1：单设备跑通。优先读 vars.METRICS_URL；为空时回退读 KV device:list（多源，阶段3）。
 * 计数器用 BigInt 处理，避免 uint64 绕回 / 精度丢失；boot_time 变化则重置速率基准。
 */
/**
 * 解析 node_exporter 文本格式（Prometheus exposition）关键指标。
 * 内联在 index.js 中，保证 Dashboard「编辑代码」单文件即可部署。
 * - 计数器以字符串/BigInt 保留，避免 uint64(>2^53) 精度丢失与绕回误判。
 * - 只解析所需行，降低解析开销。
 */
const IGNORED_IFACE = /^(lo|veth|docker0|tailscale0)/;
const PSEUDO_FS = /^(tmpfs|devtmpfs|overlay|squashfs|proc|sysfs|cgroup|cgroup2|mqueue|devpts|fuse\.lxcfs|nsfs|autofs|binfmt_misc|rpc_pipefs|9p|ceph|fuse\.overlayfs)/;

function parseVmMetrics(text) {
	const out = {
		hostname: null,
		bootTime: 0,
		cpu: { idle: 0, idleValid: false, total: 0 },
		memTotal: 0, memAvail: 0,
		memPct: null,
		temp: null,
		net: { recv: 0n, sent: 0n },
		fs: { total: 0, avail: 0 },
	};

	const netRaw = {};
	const fsRaw = {};

	for (const line of text.split('\n')) {
		if (!line || line.charCodeAt(0) === 35) continue;

		if (!out.hostname && line.startsWith('node_uname_info')) {
			const m = line.match(/nodename="([^"]+)"/);
			if (m) out.hostname = m[1];
			continue;
		}
		if (out.bootTime === 0 && line.startsWith('node_boot_time_seconds')) {
			out.bootTime = toNumber(line, 0);
			continue;
		}
		if (line.startsWith('node_cpu_seconds_total')) {
			const mode = line.match(/mode="([^"]+)"/);
			const v = toNumber(line, 0);
			out.cpu.total += v;
			if (mode) {
				if (mode[1] === 'idle') { out.cpu.idle += v; out.cpu.idleValid = true; }
			}
			continue;
		}
		if (line.startsWith('node_network_receive_bytes_total') || line.startsWith('node_network_transmit_bytes_total')) {
			const dev = line.match(/device="([^"]+)"/);
			const v = toBig(line, 0n);
			if (dev) {
				const d = dev[1];
				if (!netRaw[d]) netRaw[d] = { recv: 0n, sent: 0n };
				if (line.startsWith('node_network_receive_bytes_total')) netRaw[d].recv = v;
				else netRaw[d].sent = v;
			}
			continue;
		}
		if (line.startsWith('node_memory_MemTotal_bytes')) { out.memTotal = toNumber(line); continue; }
		if (line.startsWith('node_memory_MemAvailable_bytes')) { out.memAvail = toNumber(line); continue; }
		if (out.temp === null && (line.startsWith('node_thermal_zone_temp') || line.startsWith('node_hwmon_temp_input'))) {
			out.temp = toNumber(line);
		}
		if (line.startsWith('node_filesystem_size_bytes') || line.startsWith('node_filesystem_avail_bytes')) {
			const ft = line.match(/fstype="([^"]+)"/);
			if (ft && PSEUDO_FS.test(ft[1])) continue;
			const mp = line.match(/mountpoint="([^"]+)"/);
			if (!mp) continue;
			const mountpoint = mp[1];
			if (!fsRaw[mountpoint]) fsRaw[mountpoint] = { total: 0, avail: 0 };
			if (line.startsWith('node_filesystem_size_bytes')) fsRaw[mountpoint].total = toNumber(line, 0);
			else fsRaw[mountpoint].avail = toNumber(line, 0);
			continue;
		}
	}

	const WAN_IFACE = /^(eth|enp|ens|eno|wl|wlan)\d/;
	const nonIgnored = Object.keys(netRaw).filter(d => !IGNORED_IFACE.test(d));
	const wanSet = nonIgnored.filter(d => WAN_IFACE.test(d));
	for (const d of (wanSet.length ? wanSet : nonIgnored)) {
		out.net.recv += netRaw[d].recv;
		out.net.sent += netRaw[d].sent;
	}

	const rootFs = fsRaw['/'];
	let bestFs = rootFs || null;
	if (!bestFs) {
		for (const mp of Object.keys(fsRaw)) {
			if (!bestFs || fsRaw[mp].total > bestFs.total) bestFs = fsRaw[mp];
		}
	}
	if (bestFs && bestFs.total > 0) {
		out.fs = { total: bestFs.total, avail: bestFs.avail };
	}

	if (out.memTotal > 0) {
		const used = out.memTotal - out.memAvail;
		out.memPct = (100 * used) / out.memTotal;
	}
	return out;
}

function toBig(line, fallback = 0n) {
	const sp = line.lastIndexOf(' ');
	const s = (sp >= 0 ? line.slice(sp + 1) : line).trim();
	if (!s) return fallback;
	try {
		return bigIntFromMetric(s);
	} catch (e) { return fallback; }
}

function bigIntFromMetric(s) {
	let neg = false, exp = 0;
	s = s.trim();
	if (s[0] === '-') { neg = true; s = s.slice(1); }
	else if (s[0] === '+') { s = s.slice(1); }
	const e = s.search(/[eE]/);
	if (e !== -1) { exp = parseInt(s.slice(e + 1), 10) || 0; s = s.slice(0, e); }
	const dot = s.indexOf('.');
	let intPart = s, frac = '';
	if (dot !== -1) { intPart = s.slice(0, dot); frac = s.slice(dot + 1); }
	let digits = intPart + frac;
	const shift = exp - frac.length;
	if (shift >= 0) {
		digits += '0'.repeat(shift);
	} else {
		const cut = -shift;
		if (cut >= digits.length) return 0n;
		digits = digits.slice(0, digits.length - cut);
	}
	const v = BigInt(digits || '0');
	return neg ? -v : v;
}

function toNumber(line, fallback = 0) {
	const sp = line.lastIndexOf(' ');
	const s = sp >= 0 ? line.slice(sp + 1) : line;
	const v = parseFloat(s);
	return Number.isFinite(v) ? v : fallback;
}

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
		// 优先走 Pages probe 取数：NAS 源站/WAF 会拒绝 Worker 出口（HTTP 403）
		const probe = await fetchViaProbe(env);
		if (probe.devices) {
			await Promise.all(
				probe.devices.map(async d => {
					try {
						await ingestMetrics({
							deviceId: d.device_id,
							url: d.url,
							hostname: null,
							bootTime: d.bootTime || 0,
							cpu: {
								idle: Number(d.cpu && d.cpu.idle),
								total: Number(d.cpu && d.cpu.total),
								idleValid: !!(d.cpu && d.cpu.idleValid),
							},
							net: { recv: String((d.net && d.net.recv) ?? '0'), sent: String((d.net && d.net.sent) ?? '0') },
							memPct: d.mem,
							temp: d.temp,
							fs: d.fs || { total: 0, avail: 0 },
						}, env, started);
						results.push({ url: d.url, ok: true, via: 'probe' });
					} catch (e) {
						console.error(`ingest[probe:${d.device_id}]`, e);
						results.push({ url: d.url, ok: false, error: e.message, via: 'probe' });
					}
				})
			);
		} else {
			// 记录 probe 失败原因，便于 /health 定位
			results.push({ url: probe.url, ok: false, error: probe.error, via: 'probe' });
			// 直连兜底（probe 不可用时）
			try {
				const sources = await resolveSources(env);
				await Promise.all(
					sources.map(async url => {
						try {
							await ingestOne(url, env, started);
							results.push({ url, ok: true, via: 'direct' });
						} catch (e) {
							console.error(`ingest[${url}]`, e);
							results.push({ url, ok: false, error: e.message, via: 'direct' });
						}
					})
				);
			} catch (e) {
				console.error('ingest batch failed', e);
			}
		}
		// ④ 状态写入：有错误立即写，无错误时每 6 小时心跳一次（避免每轮无脑写 KV）
		const errors = results.filter(r => !r.ok);
		let shouldWriteStatus = errors.length > 0;
		if (!shouldWriteStatus) {
			try {
				const st = await env.KV.get('ingest:last_status', 'json');
				if (!st || !st.ts || Math.floor(started / 1000) - st.ts >= 6 * 3600) {
					shouldWriteStatus = true;
				}
			} catch { shouldWriteStatus = true; }
		}
		if (shouldWriteStatus) {
			await env.KV.put('ingest:last_status', JSON.stringify({
				ts: Math.floor(started / 1000),
				durationMs: Date.now() - started,
				results,
			}));
		}
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

// 通过 Pages probe 取数：NAS 源站/WAF 会拒绝 Worker 出口（403），Pages 出口可正常访问
async function fetchViaProbe(env) {
	// 兜底硬编码：用 Dashboard「编辑代码」部署时不会带入 wrangler.toml 的 vars
	const probeUrl = env.PROBE_URL || 'https://111daohang.pages.dev/api/nas/probe';
	try {
		const res = await fetch(probeUrl, { headers: { accept: 'application/json' } });
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const data = await res.json();
		const list = (data && Array.isArray(data.devices)) ? data.devices : [];
		if (!list.length) throw new Error('probe 返回空设备列表');
		return { devices: list, url: probeUrl, error: null };
	} catch (e) {
		console.error('probe 取数失败，回退直连', e);
		return { devices: null, url: probeUrl, error: `${e.name}: ${e.message}` };
	}
}

async function resolveSources(env) {
	// 总是合并 device:list 里登记的多源（含前端/断链/新增），再补默认单源，按 url 去重
	const urls = [];
	const seen = new Set();
	const add = u => { if (u && !seen.has(u)) { seen.add(u); urls.push(u); } };

	// KV 不可用（如配额超限 429）时不能让整轮采集中止，退回默认源继续写 D1
	try {
		const raw = await env.KV.get('device:list', { type: 'text', cacheTtl: 60 });
		if (raw) {
			let ids = [];
			try { ids = JSON.parse(raw); } catch (e) { /* 忽略 */ }
			const metas = await Promise.all(ids.map(id => env.KV.get(`dev:meta:${id}`, { type: 'json', cacheTtl: 60 }).catch(() => null)));
			for (const m of metas) if (m && m.url) add(m.url);
		}
	} catch (e) {
		console.error('resolveSources: KV 读取失败，使用默认源', e);
	}
	if (env.METRICS_URL) add(env.METRICS_URL);
	return urls;
}

async function ingestOne(url, env, nowMs) {
	const text = await fetchSource(url);
	const m = parseVmMetrics(text);

	// 设备号：若该 URL 已在寄存器登记过（设置弹窗添加），沿用其 id 保持前后台一致；
	// 否则优先真实主机名，泛化名（node_exporter/docker 容器环境）时改用链接 host 主标签
	const deviceId = await deviceIdForUrl(env, url, m.hostname);

	await ingestMetrics({
		deviceId,
		url,
		hostname: m.hostname,
		bootTime: m.bootTime,
		cpu: m.cpu,
		net: m.net,
		memPct: m.memPct,
		temp: m.temp,
		fs: m.fs,
	}, env, nowMs);
}

// 统一入库逻辑：直连抓取与 Pages probe 取数共用
async function ingestMetrics(d, env, nowMs) {
	const { deviceId, url } = d;
	const nowSec = Math.floor(nowMs / 1000);
	// 节流快照的最小间隔（秒）：Cron 10min × 4 轮 = 40min
	const SNAPSHOT_THROTTLE = 4 * 600;

	// ①② 合并 key：dev:state:${id} 同时存计数器基准 prev + 实时快照 lastSnapshot
	// 读取本次 state（含计数器基准），兼容旧 key 自动迁移；KV 异常时降级为无基准（速率为 0，仍写 D1）
	let state = {};
	try {
		state = (await env.KV.get(`dev:state:${deviceId}`, { type: 'json', cacheTtl: 60 })) || {};
	} catch (e) {
		console.error(`ingest[${deviceId}]: state 读取失败，按首轮处理`, e);
	}
	let prev = state.prev || null;
	if (!prev) {
		try {
			const legacy = await env.KV.get(`dev:prev:${deviceId}`, { type: 'json', cacheTtl: 60 });
			if (legacy) prev = legacy;
		} catch (e) { /* 忽略 */ }
	}

	let upBps = 0, downBps = 0, cpuPct = null;
	const rebooted = prev && d.bootTime > 0 && prev.bootTime > 0 && d.bootTime !== prev.bootTime;

	if (prev && !rebooted) {
		const dtSec = nowSec - prev.ts;
		if (dtSec > 0) {
			downBps = safeRate(d.net.recv, prev.net.recv, dtSec);
			upBps = safeRate(d.net.sent, prev.net.sent, dtSec);
			if (d.cpu.idleValid && prev.cpu.idle > 0 && d.cpu.total > prev.cpu.total) {
				const idleDiff = d.cpu.idle - prev.cpu.idle;
				const totalDiff = d.cpu.total - prev.cpu.total;
				if (totalDiff > 0) cpuPct = Math.max(0, Math.min(100, 100 * (1 - Number(idleDiff) / Number(totalDiff))));
			}
		}
	}
	const memPct = clampPct(d.memPct);
	const tempC = sanitizeTemp(d.temp);

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
		.bind(deviceId, url, d.hostname || null, nowSec, nowSec)
		.run();

	// 登记设备列表 + 元数据（KV，前端 index/realtime 读 device:list 和 dev:meta）
	// KV 写失败（配额/429）不应影响本轮 D1 采集结果
	try {
		await addToDeviceList(env, deviceId, url);
	} catch (e) {
		console.error(`ingest[${deviceId}]: 设备列表写入失败`, e);
	}

	// 保存本次 state（prev 必写；lastSnapshot ③节流：距上次不足 40min 保留旧值，前端实时性由 probe.js 直抓保障）
	const newPrev = {
		ts: nowSec,
		bootTime: d.bootTime || 0,
		net: { recv: String(d.net.recv), sent: String(d.net.sent) },
		cpu: { total: String(d.cpu.total), idle: String(d.cpu.idle) },
	};
	const lastSnap = state.lastSnapshot || { ts: 0 };
	const snapFresh = nowSec - (lastSnap.ts || 0) >= SNAPSHOT_THROTTLE;
	const newSnap = snapFresh ? {
		device_id: deviceId, url, ts: nowSec,
		bootTime: d.bootTime || 0,
		cpu: cpuPct == null ? null : round(cpuPct, 1),
		mem: memPct,
		up: round(upBps), down: round(downBps),
		temp: tempC,
		fs: d.fs && d.fs.total > 0 ? { total: Math.round(d.fs.total), avail: Math.round(d.fs.avail) } : null,
	} : lastSnap;

	// ② 单次写入合并 key：prev + lastSnapshot，原 2 次 KV.put 现在 1 次
	try {
		await env.KV.put(`dev:state:${deviceId}`, JSON.stringify({ prev: newPrev, lastSnapshot: newSnap }));
	} catch (e) {
		console.error(`ingest[${deviceId}]: state 写入失败`, e);
	}

	// 写前兜底滚动删除（与 Cron 双保险；见下方 dailyCleanup）
	await maybeCleanup(env, nowSec);
}

// 生成稳定的设备标识：优先复用寄存器里已登记的 id（保证前后台一致），否则用真实主机名，泛化时用链接 host 主标签
async function deviceIdForUrl(env, url, hostname) {
	// KV 异常时退回纯计算 id，保证 D1 照常写入
	try {
		const raw = await env.KV.get('device:list', { type: 'text', cacheTtl: 60 });
		if (raw) {
			let ids = [];
			try { ids = JSON.parse(raw); } catch (e) {}
			for (const id of ids) {
				if (typeof id !== 'string') continue;
				const m = await env.KV.get(`dev:meta:${id}`, { type: 'json', cacheTtl: 60 });
				if (m && m.url === url) return id;
			}
		}
	} catch (e) {
		console.error('deviceIdForUrl: KV 读取失败，使用计算 id', e);
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