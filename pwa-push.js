// ==========================================================
// pwa-push.js — SicoX PWA Push 通知クライアント側実装
//
// 使い方:
//   1. このファイルを / (index.html と同じ階層) に配置
//   2. index.html の </body> 直前に
//      <script src="/pwa-push.js"></script> を追加
//   3. appStart() の中で initPushNotifications() を呼び出す
// ==========================================================

// ----------------------------------------------------------
// ① VAPID 公開鍵（.env や Supabase secrets から取得した値）
// ----------------------------------------------------------
const VAPID_PUBLIC_KEY = 'BP5a5eqrkxqo1LxtZYuIdk2ax7zxtU2IbUaQbmzh5s9wUjCkKn95dnwnvJ5P_6k8q7-Ba62kQsZcgpVp2zocUrU';

// ----------------------------------------------------------
// ユーティリティ: VAPID公開鍵 (Base64URL) → Uint8Array 変換
// ----------------------------------------------------------
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  return new Uint8Array([...rawData].map((c) => c.charCodeAt(0)));
}

const NOTIF_PREFS_CACHE_NAME = 'sicox-notif-prefs-v1';
const NOTIF_PREFS_REQUEST_KEY = 'sicox://notif-prefs';

function toSwNotifPrefs(prefs = {}) {
  // SW側の構造と1対1で完全に一致させる
  return {
    notifyTweet:   prefs.notifyTweet   !== false,
    notifyDm:      prefs.notifyDm      !== false,
    notifyComment: prefs.notifyComment !== false,
    notifyBadge:   prefs.notifyBadge   !== false,
  };
}

async function savePrefsToCacheStorage(swPrefs) {
  if (!('caches' in window)) return;

  try {
    const cache = await caches.open(NOTIF_PREFS_CACHE_NAME);
    await cache.put(
      new Request(NOTIF_PREFS_REQUEST_KEY),
      new Response(JSON.stringify(swPrefs), {
        headers: { 'Content-Type': 'application/json' },
      })
    );
  } catch (err) {
    console.warn('[PWA] 通知設定キャッシュの保存に失敗:', err);
  }
}

// ----------------------------------------------------------
// ユーザー設定を Service Worker の CacheStorage に同期する
// ----------------------------------------------------------
function syncPrefsToSW(prefs) {
  const swPrefs = toSwNotifPrefs(prefs);
  savePrefsToCacheStorage(swPrefs);

  if (!('serviceWorker' in navigator)) return;

  const send = (controller) => {
    controller.postMessage({ type: 'SAVE_PREFS', prefs: swPrefs });
  };

  if (navigator.serviceWorker.controller) {
    send(navigator.serviceWorker.controller);
  } else {
    navigator.serviceWorker.ready.then(reg => {
      if (reg.active) send(reg.active);
    }).catch(() => {});
  }
}

// ----------------------------------------------------------
// ② Service Worker の登録
// ----------------------------------------------------------
async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) {
    console.warn('[PWA] Service Worker はこのブラウザでサポートされていません');
    return null;
  }

  try {
    const reg = await navigator.serviceWorker.register('/sw.js', {
      scope: '/',
      updateViaCache: 'none',
    });

    console.log('[PWA] Service Worker 登録成功:', reg.scope);

    // SW からのメッセージを受け取る（通知タップ時の処理）
    navigator.serviceWorker.addEventListener('message', handleSwMessage);

    return reg;
  } catch (err) {
    console.error('[PWA] Service Worker 登録失敗:', err);
    return null;
  }
}

// ----------------------------------------------------------
// SW からのメッセージ処理
// ----------------------------------------------------------
function handleSwMessage(event) {
  if (event.data?.type === 'notification_clicked') {
    // 通知タップでアプリがフォーカスされた → バッジと通知を消去
    clearAppBadge();
    clearAllNotifications();
  }
}

// ----------------------------------------------------------
// ③ 通知許可を求め、購読情報を Supabase に保存する
// ----------------------------------------------------------
async function initPushNotifications() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    console.warn('[PWA] Push 通知はこのブラウザでサポートされていません');
    return;
  }

  if (!currentUser?.handle) return;

  const prefs = getPushPrefs();
  let permission = Notification.permission;

  if (permission === 'denied') {
    console.log('[PWA] 通知はブロックされています');
    return;
  }

  if (permission === 'default') {
    permission = await Notification.requestPermission();
  }

  if (permission !== 'granted') {
    console.log('[PWA] 通知が許可されませんでした');
    return;
  }

  const reg = await navigator.serviceWorker.ready;
  let subscription = await reg.pushManager.getSubscription();

  if (!subscription) {
    try {
      subscription = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      });
      console.log('[PWA] Push 購読を作成しました');
    } catch (err) {
      console.error('[PWA] Push 購読の作成に失敗:', err);
      return;
    }
  }

  await savePushSubscription(subscription, prefs);
  syncPrefsToSW(prefs);
}

// ----------------------------------------------------------
// 購読情報を Supabase の push_subscriptions テーブルに UPSERT
// ----------------------------------------------------------
async function savePushSubscription(subscription, prefs = {}) {
  if (!currentUser?.handle || !subscription) return;

  const subJson = subscription.toJSON();
  const wantBadge = prefs.notifyBadge !== false;
  const shouldDeliverPush = (bannerPref) => bannerPref !== false || wantBadge;

  const record = {
    user_handle:    currentUser.handle,
    endpoint:      subJson.endpoint,
    p256dh:        subJson.keys.p256dh,
    auth:          subJson.keys.auth,
    notify_tweet:   shouldDeliverPush(prefs.notifyTweet),
    notify_dm:      shouldDeliverPush(prefs.notifyDm),
    notify_comment: shouldDeliverPush(prefs.notifyComment),
    notify_badge:   wantBadge,
    updated_at:   new Date().toISOString(),
  };

  const { error } = await sb.from('push_subscriptions').upsert(record, {
    onConflict: 'endpoint',
  });

  if (error) {
    console.error('[PWA] push_subscriptions の保存に失敗:', error);
  } else {
    console.log('[PWA] push_subscriptions を保存しました');
  }
}

// ----------------------------------------------------------
// ユーザーの Push 通知設定を localStorage に保存・取得
// ----------------------------------------------------------
const PUSH_PREFS_KEY = 'mn_push_prefs';

function getPushPrefs() {
  try {
    return JSON.parse(localStorage.getItem(PUSH_PREFS_KEY) || '{}');
  } catch {
    return {};
  }
}

function savePushPrefs(prefs) {
  localStorage.setItem(PUSH_PREFS_KEY, JSON.stringify(prefs));
}

async function updatePushPref(key, value) {
  const prefs = getPushPrefs();
  prefs[key] = value;
  savePushPrefs(prefs);

  syncPrefsToSW(prefs);

  const reg = await navigator.serviceWorker.ready;
  const subscription = await reg.pushManager.getSubscription();
  if (subscription) {
    await savePushSubscription(subscription, prefs);
  } else if (Notification.permission === 'granted') {
    await initPushNotifications();
  }
}

// ----------------------------------------------------------
// ④ App Badging API & 通知クリア — アプリアイコンのバッジと通知操作
// ----------------------------------------------------------

// バッジを付与（数値）
async function setAppBadge(count = 1) {
  if ('setAppBadge' in navigator) {
    try {
      await navigator.setAppBadge(count);
    } catch (e) {
      console.warn('[PWA] setAppBadge 失敗:', e);
    }
  }
}

// バッジを消去
async function clearAppBadge() {
  if ('clearAppBadge' in navigator) {
    try {
      await navigator.clearAppBadge();
    } catch (e) {
      console.warn('[PWA] clearAppBadge 失敗:', e);
    }
  }

  // SW 側にも通知
  if (navigator.serviceWorker.controller) {
    navigator.serviceWorker.controller.postMessage({ type: 'CLEAR_BADGE' });
  }
}

// 表示されている通知バナーをすべて消去する
async function clearAllNotifications() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const notifications = await reg.getNotifications();
    notifications.forEach(notification => {
      notification.close();
    });
  } catch (e) {
    console.warn('[PWA] 通知のクリアに失敗:', e);
  }
}

// ----------------------------------------------------------
// ⑤ アプリ起動・フォーカス時に自動でバッジと通知を消去する
//   index.html の appStart() または DOMContentLoaded で呼ぶ
// ----------------------------------------------------------
function setupAutoClearing() {
  // バッジと通知の両方を消す関数
  const clearAll = () => {
    clearAppBadge();
    clearAllNotifications();
  };

  // ページ表示時（通常起動 or タブ切り替えで戻ってきた時）
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      clearAll();
    }
  });

  // ページ読み込み完了時（初回起動）
  if (document.visibilityState === 'visible') {
    clearAll();
  }

  // ウィンドウがフォーカスを得た時（PC ブラウザ対応）
  window.addEventListener('focus', () => {
    clearAll();
  });
}

// ----------------------------------------------------------
// ⑥ Push 購読を解除する（通知設定OFFにした時）
// ----------------------------------------------------------
async function unsubscribePush() {
  const reg = await navigator.serviceWorker.ready;
  const subscription = await reg.pushManager.getSubscription();

  if (!subscription) return;

  const unsubscribed = await subscription.unsubscribe();

  if (unsubscribed && currentUser?.handle) {
    await sb
      .from('push_subscriptions')
      .delete()
      .eq('endpoint', subscription.endpoint);
    console.log('[PWA] Push 購読を解除しました');
  }
}

// ----------------------------------------------------------
// プロフィール設定画面に通知設定UIを追加するヘルパー
// ----------------------------------------------------------
function renderPushSettingsUI(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;

  const prefs = getPushPrefs();
  const supported = ('serviceWorker' in navigator) && ('PushManager' in window);
  const permission = supported ? Notification.permission : 'unsupported';

  if (supported) syncPrefsToSW(prefs);

  container.innerHTML = `
    <div style="padding:16px 0;border-top:1px solid var(--border);margin-top:12px;">
      <div style="font-size:15px;font-weight:700;color:var(--text);margin-bottom:12px;">
        🔔 プッシュ通知設定
      </div>

      ${!supported ? `
        <div style="font-size:13px;color:var(--text2);">
          このブラウザはプッシュ通知に対応していません。<br>
          iOSの場合はSafariでホーム画面に追加してください。
        </div>
      ` : permission === 'denied' ? `
        <div style="font-size:13px;color:#f47067;">
          通知がブロックされています。<br>
          ブラウザの設定から通知を許可してください。
        </div>
      ` : `
        <div style="display:flex;flex-direction:column;gap:12px;">

          <label style="display:flex;align-items:center;justify-content:space-between;cursor:pointer;">
            <span style="font-size:14px;color:var(--text);">
              新規ポスト通知
            </span>
            <input type="checkbox" id="pref-notify-tweet"
              ${prefs.notifyTweet !== false ? 'checked' : ''}
              onchange="onPushPrefChange('notifyTweet', this.checked)"
              style="width:18px;height:18px;cursor:pointer;">
          </label>

          <label style="display:flex;align-items:center;justify-content:space-between;cursor:pointer;">
            <span style="font-size:14px;color:var(--text);">
              コメント通知
              <span style="font-size:11px;color:var(--text2);display:block;">
                自分の投稿・参加スレッドへの返信
              </span>
            </span>
            <input type="checkbox" id="pref-notify-comment"
              ${prefs.notifyComment !== false ? 'checked' : ''}
              onchange="onPushPrefChange('notifyComment', this.checked)"
              style="width:18px;height:18px;cursor:pointer;">
          </label>

          <label style="display:flex;align-items:center;justify-content:space-between;cursor:pointer;">
            <span style="font-size:14px;color:var(--text);">
              DM通知
            </span>
            <input type="checkbox" id="pref-notify-dm"
              ${prefs.notifyDm !== false ? 'checked' : ''}
              onchange="onPushPrefChange('notifyDm', this.checked)"
              style="width:18px;height:18px;cursor:pointer;">
          </label>

          <label style="display:flex;align-items:center;justify-content:space-between;cursor:pointer;">
            <span style="font-size:14px;color:var(--text);">
              アイコンバッジ
              <span style="font-size:11px;color:var(--text2);display:block;">
                アプリアイコンに赤い通知マークを表示
              </span>
            </span>
            <input type="checkbox" id="pref-notify-badge"
              ${prefs.notifyBadge !== false ? 'checked' : ''}
              onchange="onPushPrefChange('notifyBadge', this.checked)"
              style="width:18px;height:18px;cursor:pointer;">
          </label>

          ${permission === 'default' ? `
            <button onclick="initPushNotifications()"
              style="background:var(--accent);color:#fff;border:none;border-radius:9999px;
                     padding:8px 20px;font-size:14px;font-weight:700;cursor:pointer;
                     font-family:var(--font);margin-top:4px;">
              通知を有効にする
            </button>
          ` : `
            <div style="font-size:12px;color:#00ba7c;">✓ 通知は有効です</div>
          `}
        </div>
      `}
    </div>
  `;
}

async function onPushPrefChange(key, value) {
  await updatePushPref(key, value);
  showToast(value ? '設定を有効にしました' : '設定を無効にしました');
}

// ----------------------------------------------------------
// 初期化 — DOM 読み込み完了後に SW を登録 & バッジ・通知消去設定
// ----------------------------------------------------------
(async function pwaPushInit() {
  // バッジと通知の消去ハンドラを最優先で登録
  setupAutoClearing();

  const registration = await registerServiceWorker();
  const prefs = getPushPrefs();

  if (registration) {
    // インストール・待機・アクティブ状態を判定して安全に状態監視
    const sw = registration.installing || registration.waiting || registration.active;
    if (sw) {
      if (sw.state === 'activated') {
        syncPrefsToSW(prefs);
      } else {
        sw.addEventListener('statechange', (e) => {
          if (e.target.state === 'activated') {
            console.log('[PWA] SW がアクティブになったため、遅延同期を実行します');
            syncPrefsToSW(prefs);
          }
        });
      }
    }
  }

  // 既にcontrollerが存在しているセッション（リロード等）用
  if (navigator.serviceWorker.controller) {
    syncPrefsToSW(prefs);
  }
})();
