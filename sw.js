// ==========================================================
// sw.js — SicoX Service Worker
// /sw.js として配置（index.html と同じディレクトリ）
// ==========================================================

const SW_VERSION = 'v1.1.0';

// ----------------------------------------------------------
// ユーザー通知設定の保存・読み込み（CacheStorage 経由）
// SW は localStorage にアクセスできないため CacheStorage を使用する
// ----------------------------------------------------------
const PREFS_CACHE_NAME = 'sicox-notif-prefs-v1';
const PREFS_REQUEST_KEY = 'sicox://notif-prefs';

/**
 * 通知設定を CacheStorage に保存する
 * @param {Object} prefs - { newPost: bool, dm: bool, badge: bool }
 */
async function saveNotifPrefs(prefs) {
  try {
    const cache = await caches.open(PREFS_CACHE_NAME);
    const body = JSON.stringify(prefs);
    await cache.put(
      new Request(PREFS_REQUEST_KEY),
      new Response(body, { headers: { 'Content-Type': 'application/json' } })
    );
    console.log('[SW] notif prefs saved:', prefs);
  } catch (err) {
    console.warn('[SW] failed to save notif prefs:', err);
  }
}

/**
 * CacheStorage から通知設定を読み込む
 * @returns {{ newPost: bool, dm: bool, badge: bool } | null}
 */
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
// インストール & アクティベート（キャッシュ不使用、通知のみ）
// ----------------------------------------------------------
self.addEventListener('install', (event) => {
  console.log(`[SW ${SW_VERSION}] installed`);
  // 古いSWをすぐに置き換える
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  console.log(`[SW ${SW_VERSION}] activated`);
  // 古いバージョンの設定キャッシュを削除
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
//
// ★ 修正のポイント ★
//   通知の「表示」とアイコン「バッジ付与」を独立して制御する。
//   ユーザー設定は CacheStorage に保存された prefs を参照する。
//
//   prefs.newPost === false → ロック画面通知は出さない
//   prefs.dm      === false → DM通知は出さない
//   prefs.badge   === true  → どちらの場合もバッジは付ける
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
      // ── ユーザー設定を読み込む ──────────────────────────────────
      // 設定が未保存の場合はすべてオン（デフォルト）とみなす
      const prefs = await loadNotifPrefs() ?? {
        newPost: true,
        dm:      true,
        badge:   true,
      };

      const notifType = data.type || 'tweet'; // 'tweet' | 'dm'

      // 通知タイプ別に「ロック画面通知を出すか」を判定
      const shouldShowNotification = (() => {
        if (notifType === 'tweet') return prefs.newPost !== false;
        if (notifType === 'dm')    return prefs.dm      !== false;
        return true; // 未知のタイプはデフォルト表示
      })();

      // バッジを付けるか（ユーザー設定 AND ペイロードの showBadge の両方を確認）
      const shouldSetBadge =
        prefs.badge !== false &&
        data.showBadge !== false;

      // 1. ロック画面通知（設定がオンの場合のみ表示）
      if (shouldShowNotification) {
        await self.registration.showNotification(data.title, options);
      } else {
        console.log(`[SW] notification suppressed by user pref (type: ${notifType})`);
      }

      // 2. アプリアイコンにバッジを付与（App Badging API）
      //    ★ 通知表示とは独立して設定に従って動作する ★
      if (shouldSetBadge && 'setAppBadge' in self.navigator) {
        try {
          // バッジの数は Edge Function から badgeCount が来れば使う、なければ 1
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
  // バッジ消去
  if (event.data?.type === 'CLEAR_BADGE') {
    if ('clearAppBadge' in self.navigator) {
      self.navigator.clearAppBadge().catch(() => {});
    }
  }

  // ★ ユーザー通知設定の同期 ★
  // pwa-push.js または HTML 側から設定変更のたびに送信する
  // 例: navigator.serviceWorker.controller.postMessage({
  //       type: 'SAVE_PREFS',
  //       prefs: { newPost: false, dm: true, badge: true }
  //     });
  if (event.data?.type === 'SAVE_PREFS' && event.data?.prefs) {
    // ★ 修正: event.waitUntil() で非同期書き込みが完了するまで SW を生かす ★
    // waitUntil なしだと CacheStorage への書き込み完了前に SW が終了し、
    // 設定が保存されず次回 push 時にデフォルト（全オン）で動作してしまう。
    event.waitUntil(saveNotifPrefs(event.data.prefs));
  }
});
