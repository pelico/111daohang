// Pages Function: /api/nas/realtime -> 各设备实时快照（读 KV，零计算）
export async function onRequestGet(ctx) {
	const env = ctx.env;
	const list = (await env.KV.get('device:list', 'json')) || [];
	const snap = await Promise.all(
		list.map(async id => ({ id, d: await env.KV.get(`device:last:${id}`, 'json') }))
	);
	const devices = snap.filter(s => s.d).map(s => s.d);
	return json({ ts: Math.floor(Date.now() / 1000), devices });
}

function json(obj, status = 200) {
	return new Response(JSON.stringify(obj), {
		status,
		headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
	});
}