// Pages Function: GET /api/nas/probe
// 按需即时抓取各 metrics 源（前台打开/持续轮询用），返回"原始计数"供前端差分算实时速率/CPU。
// 关键：只读 KV 决定抓哪些源、抓完即返回，**不写 KV / 不写 D1**，避免高频轮询撞穿免费写入额度。
import { parseVmMetrics } from '../../_lib/parse.js';

const FETCH_TIMEOUT_MS = 8000;

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
				mem: m.memPct == null ? null : Math.round(m.memPct * 10) / 10,
				temp: m.temp == null ? null : Math.round(m.temp * 10) / 10,
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