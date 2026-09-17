// Pages Function: GET /api/nas -> 设备列表（含 id + url，前台下拉/checkbox/设置弹窗用）
export async function onRequestGet(ctx) {
	const env = ctx.env;
	const ids = (await env.KV.get('device:list', 'json')) || [];
	const metas = await Promise.all(ids.map(id => env.KV.get(`dev:meta:${id}`, 'json')));
	const devices = ids.map(id => {
		const m = metas.find(x => x && x.id === id);
		return { id, url: m ? m.url : null };
	}).filter(d => d.url);
	return json({ ts: nowSec(), mode: 'index', devices });
}

function nowSec() { return Math.floor(Date.now() / 1000); }
function json(obj, status = 200) {
	return new Response(JSON.stringify(obj), {
		status,
		headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
	});
}