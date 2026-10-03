// Pages Function: /api/nas/realtime -> 各设备实时快照（读 KV，零计算）
// 2026-10-03：适配合并 key dev:state:${id}，lastSnapshot 嵌套；兼容旧 device:last:${id} fallback
export async function onRequestGet(ctx) {
	const env = ctx.env;
	const list = (await env.KV.get('device:list', 'json')) || [];
	const snap = await Promise.all(
		list.map(async id => {
			const st = await env.KV.get(`dev:state:${id}`, 'json');
			if (st && st.lastSnapshot) return { id, d: st.lastSnapshot };
			// 兼容旧 key（迁移期 fallback）
			const legacy = await env.KV.get(`device:last:${id}`, 'json');
			return { id, d: legacy };
		})
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
