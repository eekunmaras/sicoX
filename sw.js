// ==========================================================
// sw.js — SicoX Service Worker
// /sw.js として配置（index.html と同じディレクトリ）
// ==========================================================

const SW_VERSION = 'v1.2.1';

// ----------------------------------------------------------
// ユーザー通知設定の保存・読み込み（CacheStorage 経由）
// SW は localStorage にアクセスできないため CacheStorage を使用する
// ----------------------------------------------------------
const PREFS_CACHE_NAME = 'sicox-notif-prefs-v1';
const PREFS_REQUEST_KEY = 'sicox://notif-prefs';

/**
 * 通知設定を CacheStorage に保存する
 * @param {Object} prefs - { notifyTweet: bool, notifyDm: bool, notifyBadge: bool, notifyComment: bool }
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
 * @returns {{ notifyTweet: bool, notifyDm: bool, notifyBadge: bool, notifyComment: bool } | null}
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
// type 一覧:
//   'tweet'   — 新規ポスト通知（prefs.notifyTweet で制御）
//   'dm'      — DM通知（prefs.notifyDm で制御）
//   'comment' — コメント/返信通知（prefs.notifyComment で制御）
//
// prefs.notifyBadge が true であれば、通知表示とは独立してバッジを付与する。
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
      // フロント側のプロパティ名（notifyTweet等）に完全統一
      const prefs = await loadNotifPrefs() ?? {
        notifyTweet:   true,
        notifyDm:      true,
        notifyComment: true,
        notifyBadge:   true,
      };

      const notifType = data.type || 'tweet'; // 'tweet' | 'dm' | 'comment'

      // 通知タイプ別に「ロック画面通知を出すか」を判定
      const shouldShowNotification = (() => {
        if (notifType === 'tweet')   return prefs.notifyTweet   !== false;
        if (notifType === 'dm')      return prefs.notifyDm      !== false;
        if (notifType === 'comment') return prefs.notifyComment !== false;
        return true; // 未知のタイプはデフォルト表示
      })();

      // バッジを付けるか（ユーザー設定 AND ペイロードの showBadge の両方を確認）
      const shouldSetBadge =
        prefs.notifyBadge !== false &&
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
  if (event.data?.type === 'SAVE_PREFS' && event.data?.prefs) {
    event.waitUntil(saveNotifPrefs(event.data.prefs));
  }
});
