// Pages Function: /api/nas/history -> 某设备(或多设备)降采样历史曲线，读 D1
// 示例：
//   /api/nas/history?device=wkyapi&range=7d
//   /api/nas/history?devices=a,b&range=24h
//   /api/nas/history            -> 设备索引（未指定 device 时）
export async function onRequestGet(ctx) {
	const env = ctx.env;
	const u = new URL(ctx.request.url);
	const device = u.searchParams.get('device');
	const range = u.searchParams.get('range') || '7d';
	const devices = device
		? [device]
		: (u.searchParams.get('devices') || '').split(',').map(s => s.trim()).filter(Boolean);

	const buckets = { '24h': 3600, '7d': 6 * 3600, '30d': 86400 };
	const bucket = buckets[range] || buckets['7d'];
	const nowSec = Math.floor(Date.now() / 1000);
	const start = nowSec - toSec(range);

	if (devices.length > 0) {
		const place = devices.map(() => '?').join(',');
		let rows;
		try {
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
				 WHERE device_id IN (${place}) AND ts >= ? AND ts <= ?
				 GROUP BY device_id, CAST(ts / ? AS INTEGER)
				 ORDER BY ts ASC`
			).bind(...devices, start, nowSec, bucket, bucket).all()).results;
		} catch (e) {
			return json({ ts: nowSec, error: 'db_error', message: (e && e.message) || String(e) }, 500);
		}
		return json({ ts: nowSec, range, bucket, devices, points: rows });
	}

	// 设备索引：最近活跃设备及其采样数
	let list;
	try {
		list = (await env.DB.prepare(
			`SELECT device_id, MAX(ts) AS last_seen, COUNT(*) AS n
			 FROM samples WHERE ts >= ? GROUP BY device_id`
		).bind(start).all()).results;
	} catch (e) {
		return json({ ts: nowSec, error: 'db_error', message: (e && e.message) || String(e) }, 500);
	}
	return json({ ts: nowSec, range, mode: 'index', devices: list });
}

function toSec(range) {
	switch (range) {
		case '24h': return 86400;
		case '7d': return 7 * 86400;
		case '30d': return 30 * 86400;
		default: return 7 * 86400;
	}
}

function json(obj, status = 200) {
	return new Response(JSON.stringify(obj), {
		status,
		headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
	});
}