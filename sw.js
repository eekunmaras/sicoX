// ==========================================================
// sw.js — SicoX Service Worker
//
// 【通知スタック仕様】
//   ・未読通知を最大 MAX_NOTIF_COUNT 件（デフォルト5件）まで表示
//   ・上限に達した場合は新規通知を表示せずドロップ
//   ・ユーザーが通知をタップ（既読）するか、アプリを開くと
//     スタックがリセットされ、また新規通知が届くようになる
//   ・バッジ数は未読件数に連動
// ==========================================================

const SW_VERSION = 'v2.0.0';

// 未読通知の上限件数
const MAX_NOTIF_COUNT = 5;

// 未読通知カウントの保存先（CacheStorage）
const COUNT_CACHE_NAME  = 'sicox-notif-count-v1';
const COUNT_REQUEST_KEY = 'sicox://notif-count';

// ----------------------------------------------------------
// 未読カウントの読み込み・保存
// ----------------------------------------------------------
async function getNotifCount() {
  try {
    const cache = await caches.open(COUNT_CACHE_NAME);
    const res   = await cache.match(new Request(COUNT_REQUEST_KEY));
    if (!res) return 0;
    const body = await res.json();
    return typeof body.count === 'number' ? body.count : 0;
  } catch {
    return 0;
  }
}

async function setNotifCount(count) {
  try {
    const cache = await caches.open(COUNT_CACHE_NAME);
    await cache.put(
      new Request(COUNT_REQUEST_KEY),
      new Response(JSON.stringify({ count }), {
        headers: { 'Content-Type': 'application/json' },
      })
    );
  } catch (err) {
    console.warn('[SW] カウント保存失敗:', err);
  }
}

// ----------------------------------------------------------
// インストール & アクティベート
// ----------------------------------------------------------
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    // 旧バージョンのキャッシュを削除
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k =>
            (k.startsWith('sicox-notif-prefs-') || k.startsWith('sicox-notif-count-'))
            && k !== COUNT_CACHE_NAME
          )
          .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// ----------------------------------------------------------
// push イベント
//
// 【スタック上限ロジック】
//   1. 現在の未読カウントを取得
//   2. MAX_NOTIF_COUNT 以上なら通知を表示せずスキップ
//   3. 未満なら通知を表示し、カウントを +1
//   4. タグはユニーク（タイムスタンプ付き）にして毎回確実に届ける
// ----------------------------------------------------------
self.addEventListener('push', (event) => {
  let data = {
    title:     'SicoX',
    body:      '新しい通知があります',
    icon:      '/icons/icon-192.png',
    badge:     '/icons/badge-72.png',
    type:      'tweet',
    url:       '/',
    showBadge: true,
  };

  if (event.data) {
    try {
      data = { ...data, ...event.data.json() };
    } catch {
      data.body = event.data.text() || data.body;
    }
  }

  event.waitUntil(
    (async () => {
      const currentCount = await getNotifCount();

      // 上限チェック：5件溜まっていたら新規通知をスキップ
      if (currentCount >= MAX_NOTIF_COUNT) {
        console.log(`[SW] 未読通知が上限(${MAX_NOTIF_COUNT}件)に達しているためスキップ`);
        return;
      }

      // ユニークなタグで毎回確実に通知を表示
      const uniqueTag = `sicox-${data.type}-${Date.now()}`;
      const newCount  = currentCount + 1;

      const options = {
        body:               data.body,
        icon:               data.icon  || '/icons/icon-192.png',
        badge:              data.badge || '/icons/badge-72.png',
        tag:                uniqueTag,
        renotify:           false,          // タグがユニークなので renotify 不要
        requireInteraction: false,
        vibrate:            [200, 100, 200],
        data: {
          url:   data.url  || '/',
          type:  data.type,
          count: newCount,
        },
      };

      // 通知を表示
      await self.registration.showNotification(data.title, options);

      // カウントを更新
      await setNotifCount(newCount);

      // バッジを未読件数に合わせて更新
      if (data.showBadge !== false && 'setAppBadge' in self.navigator) {
        try {
          await self.navigator.setAppBadge(newCount);
        } catch (err) {
          console.warn('[SW] バッジ付与に失敗:', err);
        }
      }

      console.log(`[SW] 通知表示 (${newCount}/${MAX_NOTIF_COUNT}件)`);
    })()
  );
});

// ----------------------------------------------------------
// notificationclick イベント — 通知タップ時
//
// 【既読処理】
//   タップされた通知を閉じ、未読カウントを 0 にリセット。
//   これにより次の push からまた通知が届くようになる。
// ----------------------------------------------------------
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || '/';

  event.waitUntil(
    (async () => {
      // 未読カウントをリセット（既読扱い）
      await setNotifCount(0);

      // バッジも消去
      if ('clearAppBadge' in self.navigator) {
        self.navigator.clearAppBadge().catch(() => {});
      }

      // アプリウィンドウにフォーカス or 新規オープン
      const clients = await self.clients.matchAll({
        type:               'window',
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
//
// CLEAR_BADGE  : アプリ起動・フォーカス時にバッジ＆カウントをリセット
// SAVE_PREFS   : 通知設定の保存（後方互換のため残置）
// ----------------------------------------------------------
self.addEventListener('message', (event) => {
  // アプリが表示された → バッジとカウントを消去（既読扱い）
  if (event.data?.type === 'CLEAR_BADGE') {
    event.waitUntil(
      (async () => {
        await setNotifCount(0);
        if ('clearAppBadge' in self.navigator) {
          self.navigator.clearAppBadge().catch(() => {});
        }
      })()
    );
  }
});
