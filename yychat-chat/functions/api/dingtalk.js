// Cloudflare Pages Function: 钉钉 webhook 代理（服务端全局去重）
// 去重策略：
// L1: 本实例内存 Map（同实例内 1us 级命中）
// L2: Cache API（同边缘节点共享，跨实例但同区域）
// L3: 入口随机延迟 50-400ms（打散跨边缘节点并发到达，给 L2 写入留窗口）
// L4: CAS 原子锁（cache.put 写入 pending 标记 → 再读一次验证确实是自己写的 → 才推钉钉）

const CACHE_TTL = 3 * 60; // 秒
const L1_MAX = 200;
let _l1 = new Map();

function l1Hit(key) {
  const now = Date.now();
  if (_l1.size > L1_MAX) {
    for (const [k, v] of _l1) {
      if (v < now) _l1.delete(k);
      if (_l1.size <= L1_MAX * 0.6) break;
    }
  }
  if (_l1.has(key)) {
    if (_l1.get(key) >= now) return true;
    _l1.delete(key);
  }
  _l1.set(key, now + CACHE_TTL * 1000);
  return false;
}

function sleep(ms) {
  return new Promise(res => setTimeout(res, ms));
}

export async function onRequestPost(context) {
  // Webhook URL 只通过 Cloudflare Pages 环境变量注入，不在代码中硬编码
  // 后台设置路径：Pages → 项目 → Settings → Environment variables → Production → Add
  //   Name: DINGTALK_WEBHOOK
  //   Value: https://oapi.dingtalk.com/robot/send?access_token=你的token
  const WEBHOOK = context.env && context.env.DINGTALK_WEBHOOK;
  if (!WEBHOOK) {
    return new Response(JSON.stringify({ errcode: -3, errmsg: "DINGTALK_WEBHOOK 环境变量未配置，请在 Cloudflare Pages 后台设置" }), {
      status: 500,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
    });
  }
  try {
    const request = context.request;
    const { title, content, tag } = await request.json();
    const text = content || "";
    const dedupKey = tag || ("h" + hashStr(text));

    // L3：入口随机延迟 50-400ms，打散跨边缘节点并发
    // 同一消息的两次请求从不同浏览器/设备到达 Cloudflare，到达时间已经不同，
    // 再加随机延迟后先到达的有足够时间写入 L2 Cache，后到达的会命中去重
    const entryDelay = 50 + Math.floor(Math.random() * 351);
    await sleep(entryDelay);

    // L1
    if (l1Hit(dedupKey)) {
      return new Response(JSON.stringify({ errcode: 0, errmsg: "ok", deduplicated: true, via: "l1", d: entryDelay }), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }

    // L2
    const cache = caches.default;
    const cacheURL = "https://ding-dedup.local/" + encodeURIComponent(dedupKey);
    const cacheKey = new Request(cacheURL, { method: "GET" });
    let cachedResp = null;
    try { cachedResp = await cache.match(cacheKey); } catch (e) {}
    if (cachedResp) {
      _l1.set(dedupKey, Date.now() + CACHE_TTL * 1000);
      return new Response(JSON.stringify({ errcode: 0, errmsg: "ok", deduplicated: true, via: "l2", d: entryDelay }), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }

    // L4 CAS 原子锁：先写 "pending" 标记 → 再读验证是自己写的 → 才推钉钉
    const lockToken = Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
    const lockResp = new Response(lockToken, {
      headers: { "Cache-Control": `public, max-age=${CACHE_TTL}`, "Content-Type": "text/plain" }
    });
    await cache.put(cacheKey, lockResp);
    // 等 2ms 让网络上的 in-flight cache.write 完成
    await sleep(2);
    // 验证写入内容是不是自己的 token
    let recheck = null;
    try { recheck = await cache.match(cacheKey); } catch (e) {}
    let wrote = false;
    if (recheck) {
      let t = "";
      try { t = await recheck.text(); } catch (e) {}
      wrote = (t === lockToken);
    }
    if (!wrote) {
      // 不是自己写的 → 并发请求抢了先 → 去重
      _l1.set(dedupKey, Date.now() + CACHE_TTL * 1000);
      return new Response(JSON.stringify({ errcode: 0, errmsg: "ok", deduplicated: true, via: "l4", d: entryDelay }), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }

    // 真正推钉钉
    let data;
    try {
      const resp = await fetch(WEBHOOK, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ msgtype: "text", text: { title: title || "消息", content: text } })
      });
      data = await resp.json();
    } catch (e) {
      data = { errcode: -2, errmsg: "fetch error: " + String(e) };
    }

    if (data && data.errcode !== 0) {
      _l1.delete(dedupKey);
      try { context.waitUntil(cache.delete(cacheKey)); } catch (e) {}
    }

    return new Response(JSON.stringify(data), {
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
    });
  } catch (e) {
    return new Response(JSON.stringify({ errcode: -1, errmsg: String(e) }), {
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
    });
  }
}

export async function onRequestGet(context) {
  return new Response(JSON.stringify({ ok: true, msg: "dingtalk proxy ready", l1_size: _l1.size }), {
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
  });
}

function hashStr(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}
