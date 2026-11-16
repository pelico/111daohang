// Pages Function: POST /api/nas/unregister -> 停止抓取某个设备（仅移除 KV 注册，不清历史）
export async function onRequestPost(ctx) {
	const env = ctx.env;
	let deviceId;
	try {
		const body = await ctx.request.json();
		deviceId = (body && body.device_id && String(body.device_id).trim()) || '';
	} catch (e) {
		return json({ ok: false, error: 'invalid json' }, 400);
	}
	if (!deviceId) return json({ ok: false, error: 'device_id required' }, 400);

	await env.KV.delete(`dev:meta:${deviceId}`);
	await env.KV.delete(`dev:last:${deviceId}`);
	await env.KV.delete(`dev:prev:${deviceId}`);
	// 合并后的新 key（改版遗漏，不删会残留数据且被 realtime 继续读到）
	await env.KV.delete(`dev:state:${deviceId}`);

	const ids = (await env.KV.get('device:list', 'json')) || [];
	const next = ids.filter(x => x !== deviceId);
	await env.KV.put('device:list', JSON.stringify(next));

	return json({ ok: true, device_id: deviceId, removed: ids.length - next.length });
}

function nowSec() { return Math.floor(Date.now() / 1000); }
function json(obj, status = 200) {
	return new Response(JSON.stringify(obj), {
		status,
		headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
	});
}