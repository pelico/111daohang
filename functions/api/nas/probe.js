// Pages Function: GET /api/nas/probe
// 按需即时抓取各 metrics 源（前台打开/持续轮询用），返回"原始计数"供前端差分算实时速率/CPU。
// 关键：只读 KV 决定抓哪些源、抓完即返回，**不写 KV / 不写 D1**，避免高频轮询撞穿免费写入额度。
import { parseVmMetrics } from '../../_lib/parse.js';

const FETCH_TIMEOUT_MS = 8000;
// 物理合理性上限（与 ingest 一致）：温度合理范围
const TEMP_MIN = -20, TEMP_MAX = 120;

// 百分比 clamp 到 [0,100]；非法返回 null
function clampPct(v) {
	if (v == null || !Number.isFinite(v)) return null;
	return Math.round(Math.max(0, Math.min(100, v)) * 10) / 10;
}

// 温度校验：先按摄氏度；超出可能为毫摄氏度，÷1000 后若合理则采纳；否则视为异常
function sanitizeTemp(v) {
	if (v == null || !Number.isFinite(v)) return null;
	if (v >= TEMP_MIN && v <= TEMP_MAX) return Math.round(v * 10) / 10;
	const c = v / 1000;
	if (c >= TEMP_MIN && c <= TEMP_MAX) return Math.round(c * 10) / 10;
	return null;
}

export async function onRequestGet(ctx) {
	const env = ctx.env;
	const ids = (await env.KV.get('device:list', 'json')) || [];
	const metas = await Promise.all(ids.map(id => env.KV.get(`dev:meta:${id}`, 'json')));
	const sources = ids
		.map((id, i) => ({ id, url: metas[i] && metas[i].url }))
		.filter(s => s.url);

	const nowMs = Date.now();
	const devices = await Promise.all(sources.map(async s => {
		try {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
			let text;
			try {
				const res = await fetch(s.url, { signal: controller.signal, headers: { accept: 'text/plain' } });
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				text = await res.text();
			} finally {
				clearTimeout(timer);
			}
			const m = parseVmMetrics(text);
			return {
				device_id: s.id,
				url: s.url,
				ts: Math.floor(nowMs / 1000),
				bootTime: m.bootTime || 0,
				cpu: { idle: m.cpu.idle, total: m.cpu.total, idleValid: !!(m.cpu.idleValid && m.cpu.total > 0) },
				net: { recv: String(m.net.recv), sent: String(m.net.sent) },
				mem: clampPct(m.memPct),
				memTotal: m.memTotal || 0,
				temp: sanitizeTemp(m.temp),
				fs: m.fs.total > 0 ? { total: Math.round(m.fs.total), avail: Math.round(m.fs.avail) } : null,
			};
		} catch (e) {
			return null;
		}
	}));

	return json({ ts: Math.floor(nowMs / 1000), mode: 'probe', devices: devices.filter(Boolean) });
}

function json(obj, status = 200) {
	return new Response(JSON.stringify(obj), {
		status,
		headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
	});
}