// Pages Function: /api/nas -> 设备列表（前台《服务监控》下拉/checkbox 用）
export async function onRequestGet(ctx) {
	const env = ctx.env;
	const list = (await env.KV.get('device:list', 'json')) || [];
	return json({ ts: nowSec(), mode: 'index', devices: list });
}

function nowSec() { return Math.floor(Date.now() / 1000); }
function json(obj, status = 200) {
	return new Response(JSON.stringify(obj), {
		status,
		headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
	});
}