// Service Worker：处理通知点击，聚焦已打开的页面而非新开
self.addEventListener("install", function (e) { self.skipWaiting(); });
self.addEventListener("activate", function (e) { e.waitUntil(self.clients.claim()); });

self.addEventListener("notificationclick", function (e) {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (clientList) {
      // 找到已打开的同源页面，聚焦它
      for (var i = 0; i < clientList.length; i++) {
        var c = clientList[i];
        if (c.url && c.url.indexOf(self.location.origin) === 0 && "focus" in c) {
          try { c.postMessage({ type: "notif-click" }); } catch (err) {}
          return c.focus();
        }
      }
      // 没有打开的页面才新开
      if (self.clients.openWindow) return self.clients.openWindow("/");
    })
  );
});
