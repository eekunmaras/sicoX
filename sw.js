// ==========================================================
// sw.js — SicoX Service Worker
//
// 【設計方針】
//   push ハンドラは showNotification() の呼び出しのみに専念する。
//   CacheStorage への I/O・カウント管理は一切行わない。
//   これにより、タスクキル後のコールドスタート時でも
//   userVisibleOnly: true の契約を確実に果たせる。
//
//   バッジ・カウント管理はフロントエンド側 (pwa-push.js) に委譲する。
// ==========================================================

const SW_VERSION = 'v3.0.0';

// ----------------------------------------------------------
// インストール & アクティベート
// ----------------------------------------------------------
self.addEventListener('install', () => {
  // 新しい SW をすぐに有効化する
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    // 旧バージョンのキャッシュ（カウント管理用）を全削除
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k =>
            k.startsWith('sicox-notif-prefs-') ||
            k.startsWith('sicox-notif-count-')
          )
          .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// ----------------------------------------------------------
// push イベント — 通知の受信
//
// 【重要】このハンドラは showNotification() を必ず呼ぶこと。
//   userVisibleOnly: true の契約上、呼ばない場合はブラウザが
//   以後の push をブロックする可能性がある。
//   そのため、CacheStorage I/O などの重い処理は一切行わない。
// ----------------------------------------------------------
self.addEventListener('push', (event) => {
  // デフォルト値
  let title = 'SicoX';
  let body  = '新しい通知があります';
  let icon  = '/icons/icon-192.png';
  let badge = '/icons/badge-72.png';
  let type  = 'tweet';
  let url   = '/';

  // ペイロードのパース（失敗しても必ず通知を出す）
  if (event.data) {
    try {
      const d = event.data.json();
      title = d.title || title;
      body  = d.body  || body;
      icon  = d.icon  || icon;
      badge = d.badge || badge;
      type  = d.type  || type;
      url   = d.url   || url;
    } catch {
      // JSON パース失敗時はデフォルト値で通知
    }
  }

  // ユニークなタグ（Date.now）で通知を積み重ねる
  const tag = `sicox-${type}-${Date.now()}`;

  const options = {
    body,
    icon,
    badge,
    tag,
    renotify:           false,
    requireInteraction: false,
    vibrate:            [200, 100, 200],
    data: { url, type },
  };

  // showNotification() を必ず呼ぶ — 他の非同期処理は挟まない
  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

// ----------------------------------------------------------
// notificationclick イベント — 通知タップ時
// ----------------------------------------------------------
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || '/';

  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({
        type:                'window',
        includeUncontrolled: true,
      });

      for (const client of clients) {
        if (new URL(client.url).origin === self.location.origin) {
          await client.focus();
          client.postMessage({ type: 'notification_clicked', url: targetUrl });
          return;
        }
      }
      await self.clients.openWindow(targetUrl);
    })()
  );
});

// ----------------------------------------------------------
// message イベント — フロントエンドからの指示受け取り
// ----------------------------------------------------------
self.addEventListener('message', (event) => {
  // アプリが表示された → バッジ消去
  if (event.data?.type === 'CLEAR_BADGE') {
    if ('clearAppBadge' in self.navigator) {
      self.navigator.clearAppBadge().catch(() => {});
    }
  }
});
