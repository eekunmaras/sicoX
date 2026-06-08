// ==========================================================
// sw.js — SicoX Service Worker (FCMペナルティ対策・超堅牢版)
// ==========================================================

const SW_VERSION = 'v1.3.0'; // 完全クローズ時の通知未着バグ修正

// ----------------------------------------------------------
// ユーザー通知設定の保存・読み込み（CacheStorage 経由）
// ----------------------------------------------------------
const PREFS_CACHE_NAME = 'sicox-notif-prefs-v1';
const PREFS_REQUEST_KEY = 'sicox://notif-prefs';

async function saveNotifPrefs(prefs) {
  try {
    const cache = await caches.open(PREFS_CACHE_NAME);
    const body = JSON.stringify(prefs);
    await cache.put(
      new Request(PREFS_REQUEST_KEY),
      new Response(body, { headers: { 'Content-Type': 'application/json' } })
    );
  } catch (err) {
    console.warn('[SW] failed to save notif prefs:', err);
  }
}

// ----------------------------------------------------------
// インストール & アクティベート
// ----------------------------------------------------------
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k.startsWith('sicox-notif-prefs-') && k !== PREFS_CACHE_NAME)
          .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// ----------------------------------------------------------
// push イベント — バックグラウンド・完全クローズ時にプッシュ通知を受信する
//
// 【修正内容】
//   旧実装では clients.matchAll() でアプリの状態を判定し、
//   「アプリが生きている場合のみ」CacheStorage から設定を読み込んで
//   通知をフィルタリングしていた。
//
//   しかし通知のON/OFFはサーバー側（index.ts）の push_subscriptions テーブルの
//   notify_tweet / notify_dm / notify_comment カラムで既に制御済みのため、
//   SW 側で二重にフィルタする必要はなく、むしろ意図せず通知をブロックする原因になっていた。
//
//   また clients.matchAll() に includeUncontrolled: true がなかったため、
//   コントロール外のウィンドウ（アプリ起動直後など）がカウントされず
//   クライアント数の判定が不正確だった。
//
//   修正後は「常に即座に通知を表示」するシンプルな実装とし、
//   FCM ペナルティリスクをゼロにしつつ、完全クローズ時でも確実に通知が届くようにした。
// ----------------------------------------------------------
self.addEventListener('push', (event) => {
  let data = {
    title: 'SicoX',
    body: '新しい通知があります',
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-72.png',
    tag: 'sicox-default',
    type: 'tweet',
    url: '/',
    showBadge: true,
  };

  if (event.data) {
    try {
      const payload = event.data.json();
      data = { ...data, ...payload };
    } catch (e) {
      data.body = event.data.text() || data.body;
    }
  }

  const options = {
    body: data.body,
    icon: data.icon || '/icons/icon-192.png',
    badge: data.badge || '/icons/badge-72.png',
    tag: data.tag || ('sicox-' + data.type),
    data: {
      url: data.url || '/',
      type: data.type,
    },
    vibrate: [200, 100, 200],
    // 同じタグの通知が連続で来ても毎回バイブ・音・画面点灯させる
    renotify: true,
    requireInteraction: false,
  };

  event.waitUntil(
    (async () => {
      // ✅ 修正：常に即座に通知を表示
      // 通知のON/OFFはサーバー側 push_subscriptions で制御済みのため
      // SW 側でのフィルタは不要。設定読み込みの遅延による
      // FCM ペナルティ・通知未着リスクをゼロにする。
      await self.registration.showNotification(data.title, options);

      // バッジは通知表示後に付与（失敗しても通知には影響しない）
      if (data.showBadge !== false && 'setAppBadge' in self.navigator) {
        try {
          await self.navigator.setAppBadge(data.badgeCount || 1);
        } catch (err) {
          console.warn('[SW] バッジ付与に失敗:', err);
        }
      }
    })()
  );
});

// ----------------------------------------------------------
// notificationclick イベント — 通知タップ時の処理
// ----------------------------------------------------------
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || '/';

  event.waitUntil(
    (async () => {
      // ✅ includeUncontrolled: true で全ウィンドウを確実に検出
      const clients = await self.clients.matchAll({
        type: 'window',
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
  if (event.data?.type === 'CLEAR_BADGE') {
    if ('clearAppBadge' in self.navigator) {
      self.navigator.clearAppBadge().catch(() => {});
    }
  }
  if (event.data?.type === 'SAVE_PREFS' && event.data?.prefs) {
    event.waitUntil(saveNotifPrefs(event.data.prefs));
  }
});
