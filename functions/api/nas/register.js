// Pages Function: POST /api/nas/register -> 把新增的 metrics 链接登记进 KV，
// 供 ingest Worker 抓取（与 ingest/src/deviceIdFor 保持一致的设备命名）。
// 同源调用，无需 CORS。
export async function onRequestPost(ctx) {
	const env = ctx.env;
	let url;
	try {
		const body = await ctx.request.json();
		url = (body && body.url && String(body.url).trim()) || '';
	} catch (e) {
		return json({ ok: false, error: 'invalid json' }, 400);
	}

	let parsed;
	try {
		parsed = new URL(url);
	} catch (e) {
		return json({ ok: false, error: 'invalid url' }, 400);
	}
	if (!/^https?:$/.test(parsed.protocol)) {
		return json({ ok: false, error: 'only http/https allowed' }, 400);
	}

	const deviceId = deviceIdFor(url, null);
	await env.KV.put(`dev:meta:${deviceId}`, JSON.stringify({ id: deviceId, url, added: nowSec() }));

	const raw = (await env.KV.get('device:list', 'json')) || [];
	if (!raw.includes(deviceId)) {
		raw.push(deviceId);
		await env.KV.put('device:list', JSON.stringify(raw));
	}

	return json({ ok: true, device_id: deviceId, url });
}

// 与 ingest/src/index.js#deviceIdFor 同规则；此处拿不到 hostname，退化为链接 host 主标签
function deviceIdFor(url, _hostname) {
	const sanitize = s => s.toLowerCase().replace(/[^a-z0-9_.-]/g, '_');
	const h = sanitize(new URL(url).hostname);
	return h.split('.')[0] || h;
}

function nowSec() { return Math.floor(Date.now() / 1000); }
function json(obj, status = 200) {
	return new Response(JSON.stringify(obj), {
		status,
		headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
	});
}