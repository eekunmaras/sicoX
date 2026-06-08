// ==========================================================
// sw.js — SicoX Service Worker
// /sw.js として配置（index.html と同じディレクトリ）
// ==========================================================

const SW_VERSION = 'v1.0.0';

// ----------------------------------------------------------
// インストール & アクティベート（キャッシュ不使用、通知のみ）
// ----------------------------------------------------------
self.addEventListener('install', (event) => {
  console.log(`[SW ${SW_VERSION}] installed`);
  // 古いSWをすぐに置き換える
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  console.log(`[SW ${SW_VERSION}] activated`);
  event.waitUntil(self.clients.claim());
});


// ----------------------------------------------------------
// push イベント — バックグラウンドでプッシュ通知を受信する
// ----------------------------------------------------------
self.addEventListener('push', (event) => {
  // データが来ない場合のフォールバック
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

  // Edge Function から送られてくる JSON を解析
  if (event.data) {
    try {
      const payload = event.data.json();
      data = { ...data, ...payload };
    } catch (e) {
      data.body = event.data.text() || data.body;
    }
  }

  // 通知オプション
  const options = {
    body: data.body,
    icon: data.icon || '/icons/icon-192.png',
    badge: data.badge || '/icons/badge-72.png',  // モノクロ 72px アイコン（バッジ用）
    tag: data.tag || ('sicox-' + data.type),      // 同一 tag は上書き（スタック防止）
    data: {
      url: data.url || '/',
      type: data.type,
    },
    // Android: アクション通知のバイブパターン
    vibrate: [200, 100, 200],
    // iOS: silent では通知が出ない場合があるため renotify は false
    renotify: false,
    // 通知をずっと残す（ユーザーが閉じるまで）
    requireInteraction: false,
  };

  event.waitUntil(
    (async () => {
      // 1. 通知を表示
      await self.registration.showNotification(data.title, options);

      // 2. アプリアイコンにバッジを付与（App Badging API）
      //    showBadge フラグが true の場合のみ付与
      if (data.showBadge !== false && 'setAppBadge' in self.navigator) {
        try {
          // バッジの数は Edge Function から count が来れば使う、なければ 1
          await self.navigator.setAppBadge(data.badgeCount || 1);
        } catch (err) {
          // setAppBadge は iOS 16.4+ Safari、Android Chrome で対応
          // 対応外のブラウザではエラーになるため無視する
          console.warn('[SW] setAppBadge not supported:', err);
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
      // 既に SicoX のウィンドウが開いていればそちらにフォーカス
      const clients = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });

      for (const client of clients) {
        // 同一オリジンのウィンドウがあればフォーカス
        if (new URL(client.url).origin === self.location.origin) {
          await client.focus();
          // メッセージを送ってフロントのバッジを消去させる
          client.postMessage({ type: 'notification_clicked', url: targetUrl });
          return;
        }
      }

      // ウィンドウがなければ新規タブを開く
      await self.clients.openWindow(targetUrl);
    })()
  );
});


// ----------------------------------------------------------
// notificationclose イベント — 通知を閉じた時（任意）
// ----------------------------------------------------------
self.addEventListener('notificationclose', (event) => {
  // 分析用のログなどを送る場合はここに記述（今回は何もしない）
  console.log('[SW] Notification closed:', event.notification.tag);
});


// ----------------------------------------------------------
// message イベント — フロントエンドからの指示受け取り
// ----------------------------------------------------------
self.addEventListener('message', (event) => {
  if (event.data?.type === 'CLEAR_BADGE') {
    // フロントエンドからバッジ消去を指示された場合
    if ('clearAppBadge' in self.navigator) {
      self.navigator.clearAppBadge().catch(() => {});
    }
  }
});
