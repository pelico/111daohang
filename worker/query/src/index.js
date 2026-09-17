/**
 * nas-query
 * 统一只读出口。前端所有"读 NAS"请求都走这里（零计算，廉价 KV/D1 查询）。
 *
 * GET /nas/realtime                    -> 各设备实时快照（读 KV）
 * GET /nas/history?device=X&range=7d  -> 某设备降采样历史曲线（读 D1，SQL GROUP BY）
 * GET /health                          -> 存活
 */
export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		const cors = corsHeaders(request);
		if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

		try {
			let res;
			if (url.pathname === '/health') {
				res = json({ ok: true, service: 'nas-query' });
			} else if (url.pathname === '/nas/realtime') {
				res = await realtime(env);
			} else if (url.pathname === '/nas/history') {
				res = await history(env, url.searchParams);
			} else {
				res = json({ error: 'not found' }, 404);
			}
			return applyCors(res, cors);
		} catch (e) {
			console.error('query error', e);
			return applyCors(json({ error: e.message || 'internal' }, 500), cors);
		}
	},
};

async function realtime(env) {
	const dlist = await env.KV.get('device:list', 'text');
	let list = [];
	try { if (dlist) list = JSON.parse(dlist); } catch (e) {}
	const arr = await Promise.all(
		list.map(async id => env.KV.get(`device:last:${id}`, 'json'))
	);
	return json({ ts: Math.floor(Date.now() / 1000), devices: arr.filter(Boolean) });
}

async function history(env, params) {
	const device = params.get('device');
	const range = params.get('range') || '7d';
	const devices = device ? [device] : (params.get('devices') || '').split(',').filter(Boolean);

	// 桶策略：24h->1h(30点内)，7d->6h(28点)，30d->日(30点)。保证返回有限、前端轻
	const buckets = { '24h': 3600, '7d': 6 * 3600, '30d': 86400 };
	const bucket = buckets[range] || buckets['7d'];
	const nowSec = Math.floor(Date.now() / 1000);
	const start = nowSec - toSec(range);

	let rows;
	if (devices.length > 0 && devices.length <= 1) {
		rows = (await env.DB.prepare(
			`SELECT device_id,
			        CAST(ts / ? AS INTEGER) AS bucket,
			        MIN(ts) AS ts,
			        ROUND(AVG(cpu),1) cpu,
			        ROUND(AVG(mem),1) mem,
			        ROUND(AVG(up_bps)) up,
			        ROUND(AVG(down_bps)) down,
			        ROUND(AVG(temp),1) temp
			 FROM samples
			 WHERE device_id = ? AND ts >= ? AND ts <= ?
			 GROUP BY device_id, CAST(ts / ? AS INTEGER)
			 ORDER BY ts ASC`
		).bind(bucket, device, start, nowSec, bucket).all()).results;
	} else if (devices.length > 1) {
		rows = (await env.DB.prepare(
			`SELECT device_id,
			        CAST(ts / ? AS INTEGER) AS bucket,
			        MIN(ts) AS ts,
			        ROUND(AVG(cpu),1) cpu,
			        ROUND(AVG(mem),1) mem,
			        ROUND(AVG(up_bps)) up,
			        ROUND(AVG(down_bps)) down,
			        ROUND(AVG(temp),1) temp
			 FROM samples
			 WHERE device_id IN (${devices.map(() => '?').join(',')}) AND ts >= ? AND ts <= ?
			 GROUP BY device_id, CAST(ts / ? AS INTEGER)
			 ORDER BY ts ASC`
		).bind(...devices, start, nowSec, bucket).all()).results;
	} else {
		// 未指定设备：返回设备列表及总量（供前端下拉/checkbox）
		const list = (await env.DB.prepare(
			`SELECT device_id, MAX(ts) AS last_seen, COUNT(*) AS n
			 FROM samples WHERE ts >= ? GROUP BY device_id`
		).bind(start).all()).results;
		return json({ ts: nowSec, range, mode: 'index', devices: list });
	}
	return json({ ts: nowSec, range, bucket, device: devices, points: rows });
}

function toSec(range) {
	switch (range) {
		case '24h': return 86400;
		case '7d': return 7 * 86400;
		case '30d': return 30 * 86400;
		default: return 7 * 86400;
	}
}

function corsHeaders(req) {
	const origin = req.headers.get('Origin') || '*';
	return {
		'Access-Control-Allow-Origin': origin,
		'Access-Control-Allow-Methods': 'GET, OPTIONS',
		'Access-Control-Allow-Headers': 'Content-Type',
		'Vary': 'Origin',
	};
}
function applyCors(res, h) {
	const merged = new Headers(res.headers);
	for (const k in h) merged.set(k, h[k]);
	return new Response(res.body, { status: res.status, statusText: res.statusText, headers: merged });
}
function json(obj, status = 200) {
	return new Response(JSON.stringify(obj), {
		status,
		headers: { 'Content-Type': 'application/json; charset=utf-8' },
	});
}