// ==========================================================
// sw.js — SicoX Service Worker (FCMペナルティ対策・超堅牢版)
// ==========================================================

const SW_VERSION = 'v1.2.2'; // キャッシュ強制更新のためにバージョンアップ

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

async function loadNotifPrefs() {
  try {
    const cache = await caches.open(PREFS_CACHE_NAME);
    const res = await cache.match(new Request(PREFS_REQUEST_KEY));
    if (!res) return null;
    return await res.json();
  } catch (err) {
    console.warn('[SW] failed to load notif prefs:', err);
    return null;
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
// push イベント — バックグラウンドでプッシュ通知を受信する
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

  // 通知オプションの設定
  const options = {
    body: data.body,
    icon: data.icon || '/icons/icon-192.png',
    badge: data.badge || '/icons/badge-72.png',
    tag: data.tag || ('sicox-' + data.type), // 同じタグは上書き
    data: {
      url: data.url || '/',
      type: data.type,
    },
    vibrate: [200, 100, 200],
    
    // ★ 罠1対策：true にすることで、同じタグの通知が連続で来ても
    // 古い通知を上書きしつつ「毎回必ず音とバイブを鳴らし、画面を点灯」させる
    renotify: true, 
    requireInteraction: false,
  };

  event.waitUntil(
    (async () => {
      // 現在開いているウィンドウ（クライアント）の数をチェック
      const clients = await self.clients.matchAll({ type: 'window' });
      const isAppCompletelyClosed = clients.length === 0;

      let shouldShowNotification = true;
      let shouldSetBadge = data.showBadge !== false;

      // ★ 罠2対策：アプリが完全に閉じられている（タスクキル）状態の場合、
      // 不安定なCacheStorageの非同期読み込みを待つと、ミリ秒単位の遅延でFCMから
      // 「通知未表示ペナルティ（次回以降のプッシュ遮断）」を喰らうリスクが極めて高くなります。
      // そのため、完全に閉じている時は設定の読み込みを完全にパスして【最速・無条件】で通知を出します。
      if (isAppCompletelyClosed) {
        console.log('[SW] アプリが完全に閉じられているため、FCMペナルティ回避モード（最速通知表示）で実行します');
      } else {
        // アプリがバックグラウンド等で生きている場合は、安全にユーザー設定を読み込む
        try {
          // コールドスタート時の保険として300msのタイムアウト付きで読み込み
          const prefs = await Promise.race([
            loadNotifPrefs(),
            new Promise(resolve => setTimeout(() => resolve(null), 300))
          ]) ?? {
            notifyTweet:   true,
            notifyDm:      true,
            notifyComment: true,
            notifyBadge:   true,
          };

          const notifType = data.type || 'tweet';
          if (notifType === 'tweet')   shouldShowNotification = prefs.notifyTweet   !== false;
          if (notifType === 'dm')      shouldShowNotification = prefs.notifyDm      !== false;
          if (notifType === 'comment') shouldShowNotification = prefs.notifyComment !== false;
          
          shouldSetBadge = prefs.notifyBadge !== false && data.showBadge !== false;
        } catch (e) {
          console.warn('[SW] 設定の読み込みに失敗したため、安全のため通知を表示します', e);
        }
      }

      // 1. ロック画面通知を表示（最優先で await させる）
      if (shouldShowNotification) {
        await self.registration.showNotification(data.title, options);
      }

      // 2. アプリアイコンへのバッジ付与（通知を出した後に安全に実行）
      if (shouldSetBadge && 'setAppBadge' in self.navigator) {
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
