// ==========================================================
// pwa-push.js — SicoX PWA Push 通知クライアント側実装
//
// 使い方:
//   1. このファイルを / (index.html と同じ階層) に配置
//   2. index.html の </body> 直前に
//      <script src="/pwa-push.js"></script> を追加
//   3. appStart() の中で initPushNotifications() を呼び出す
//
// 【設計方針】
//   通知のカウント管理・上限制御は廃止。LINEと同様に連続通知を許容する。
//   バッジはアプリが前面に来たタイミングでのみリセットする。
//   SW 側は push → showNotification() に専念させ、
//   フロントが生きている時だけバッジ操作を行う。
//
// 【v3.1.0 変更点：二重発火防止】
//   通知タップ時、SW の client.focus() が visibilitychange を発火させ、
//   直後の client.postMessage() による notification_clicked 処理と
//   ほぼ同時に走って二重実行が起きる問題を修正した。
//
//   対策:
//     ① sw.js 側で postMessage() を focus() より先に送るよう変更
//        → メッセージが先に届き、フラグをセットしてから
//          visibilitychange が発火するようになる。
//     ② window.isHandlingNotificationClick フラグを導入
//        → notification_clicked 受信時に true にセット。
//     ③ visibilitychange に 150ms の猶予を設け、
//        フラグが true なら処理をスキップ（重複防止）。
//     ④ clearAppBadge / clearAllNotifications の呼び出し箇所を
//        handleSwMessage に一本化（setupAutoClearing 側では呼ばない）。
//
//   ★ sicox.html 側の対応も必要（下記「sicox.html への追加事項」参照）
// ==========================================================

// ----------------------------------------------------------
// ① VAPID 公開鍵
// ----------------------------------------------------------
const VAPID_PUBLIC_KEY = 'BP5a5eqrkxqo1LxtZYuIdk2ax7zxtU2IbUaQbmzh5s9wUjCkKn95dnwnvJ5P_6k8q7-Ba62kQsZcgpVp2zocUrU';

// ----------------------------------------------------------
// 二重発火防止フラグ
//
// 通知クリック時に SW から notification_clicked メッセージを受信した際、
// handleSwMessage 内で true にセットし、1 秒後に false に戻す。
//
// このフラグが true の間は:
//   - setupAutoClearing の visibilitychange ハンドラがスキップされる
//   - sicox.html 側の visibilitychange / focus ハンドラもスキップすること
//     （sicox.html への追加事項を参照）
// ----------------------------------------------------------
window.isHandlingNotificationClick = false;

// ----------------------------------------------------------
// ユーティリティ: VAPID公開鍵 (Base64URL) → Uint8Array 変換
// ----------------------------------------------------------
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64  = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  return new Uint8Array([...rawData].map((c) => c.charCodeAt(0)));
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
      scope:          '/',
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
//
// 【役割と責務】
//   - isHandlingNotificationClick フラグを true にセットして
//     visibilitychange 側の重複処理を先制的に抑止する。
//   - clearAppBadge / clearAllNotifications をここで一度だけ呼ぶ。
//     setupAutoClearing 側では呼ばない（二重呼び出しを排除）。
//   - DM 遷移・バナー表示は同じ message イベントを受け取る
//     sicox.html 側の addEventListener('message', ...) ハンドラが担当。
//     このファイルはナビゲーションロジックに一切関与しない。
// ----------------------------------------------------------
function handleSwMessage(event) {
  if (event.data?.type === 'notification_clicked') {
    // ① visibilitychange 側の重複処理を抑止するフラグをセット
    window.isHandlingNotificationClick = true;

    // ② バッジ・通知バナーのクリアをここで一度だけ実行
    clearAppBadge();
    clearAllNotifications();

    // ③ visibilitychange の setTimeout（150ms）が完全に終わってから
    //    フラグをリセットする。150ms より十分長い 1000ms を設定。
    setTimeout(() => {
      window.isHandlingNotificationClick = false;
    }, 1000);
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

  const prefs      = getPushPrefs();
  let   permission = Notification.permission;

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

  const reg          = await navigator.serviceWorker.ready;
  let   subscription = await reg.pushManager.getSubscription();

  if (!subscription) {
    try {
      subscription = await reg.pushManager.subscribe({
        userVisibleOnly:      true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      });
      console.log('[PWA] Push 購読を作成しました');
    } catch (err) {
      console.error('[PWA] Push 購読の作成に失敗:', err);
      return;
    }
  }

  await savePushSubscription(subscription, prefs);
}

// ----------------------------------------------------------
// 購読情報を Supabase の push_subscriptions テーブルに UPSERT
// ----------------------------------------------------------
async function savePushSubscription(subscription, prefs = {}) {
  if (!currentUser?.handle || !subscription) return;

  const subJson   = subscription.toJSON();
  const wantBadge = prefs.notifyBadge !== false;

  const record = {
    user_handle:    currentUser.handle,
    endpoint:       subJson.endpoint,
    p256dh:         subJson.keys.p256dh,
    auth:           subJson.keys.auth,
    notify_tweet:   prefs.notifyTweet   !== false,
    notify_dm:      prefs.notifyDm      !== false,
    notify_comment: prefs.notifyComment !== false,
    notify_badge:   wantBadge,
    updated_at:     new Date().toISOString(),
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
  prefs[key]  = value;
  savePushPrefs(prefs);

  const reg          = await navigator.serviceWorker.ready;
  const subscription = await reg.pushManager.getSubscription();

  if (subscription) {
    await savePushSubscription(subscription, prefs);
  } else if (Notification.permission === 'granted') {
    await initPushNotifications();
  }
}

// ----------------------------------------------------------
// ④ App Badging API & 通知クリア
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

// バッジを消去 + SW 側にも通知
async function clearAppBadge() {
  if ('clearAppBadge' in navigator) {
    try {
      await navigator.clearAppBadge();
    } catch (e) {
      console.warn('[PWA] clearAppBadge 失敗:', e);
    }
  }

  // SW が起きていれば CLEAR_BADGE を送る
  if (navigator.serviceWorker?.controller) {
    navigator.serviceWorker.controller.postMessage({ type: 'CLEAR_BADGE' });
  }
}

// 表示されている通知バナーをすべて消去する
async function clearAllNotifications() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const reg           = await navigator.serviceWorker.ready;
    const notifications = await reg.getNotifications();
    notifications.forEach(n => n.close());
  } catch (e) {
    console.warn('[PWA] 通知のクリアに失敗:', e);
  }
}

// ----------------------------------------------------------
// ⑤ アプリが前面に来たときにバッジと通知を消去する
//
// 【設計】
//   - visibilitychange のみ使用（focus との重複イベントを排除）。
//   - 起動直後の即時消去は行わない。
//     タスクキル後のコールドスタートでは visibilitychange が
//     発火しないケースがあるため、代わりに pageshow を使う。
//
// 【v3.1.0 変更点：二重発火防止】
//   clearAppBadge / clearAllNotifications の呼び出しを
//   handleSwMessage に一本化した。
//   visibilitychange と pageshow では isHandlingNotificationClick
//   フラグを確認し、true の場合（= 通知クリックによる復帰）は
//   処理をスキップして重複実行を防ぐ。
//
//   visibilitychange には 150ms の遅延を設ける。
//   理由: sw.js 側で postMessage() を focus() より先に送るよう変更したが、
//   メッセージ到着とフラグセット（handleSwMessage 実行）が
//   visibilitychange より確実に先になるとは限らないため、
//   バッファとして猶予を持たせる。
// ----------------------------------------------------------
function setupAutoClearing() {
  // フラグ確認なしのクリア実行ヘルパー（呼び出し元がフラグを確認済みの場合に使う）
  const _doClear = () => {
    clearAppBadge();
    clearAllNotifications();
  };

  // タブ切り替え・アプリの前面復帰
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      // 150ms 待ってから isHandlingNotificationClick を確認する。
      // これにより、sw.js から先に届いた postMessage が
      // handleSwMessage でフラグを true にセットする猶予を確保できる。
      // フラグが true = 通知クリックによる復帰 → handleSwMessage 側で
      // クリア済みのためここではスキップ。
      setTimeout(() => {
        if (!window.isHandlingNotificationClick) _doClear();
      }, 150);
    }
  });

  // タスクキル後の再起動（BFCache 復帰・コールドスタート）にも対応。
  // コールドスタート時は notification_clicked メッセージは来ないため
  // フラグは false のはず。念のため確認してから実行する。
  window.addEventListener('pageshow', () => {
    if (!window.isHandlingNotificationClick) _doClear();
  });
}

// ----------------------------------------------------------
// ⑥ Push 購読を解除する（通知設定OFFにした時）
// ----------------------------------------------------------
async function unsubscribePush() {
  const reg          = await navigator.serviceWorker.ready;
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

  const prefs      = getPushPrefs();
  const supported  = ('serviceWorker' in navigator) && ('PushManager' in window);
  const permission = supported ? Notification.permission : 'unsupported';

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
            <span style="font-size:14px;color:var(--text);">新規ポスト通知</span>
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
            <span style="font-size:14px;color:var(--text);">DM通知</span>
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
  setupAutoClearing();
  await registerServiceWorker();
})();

// ==========================================================
// ★ sicox.html 側に追加が必要なコード
//
// sicox.html の visibilitychange / focus ハンドラ（画面復帰時の
// 汎用処理）の先頭に以下のガードを追加してください。
// これにより、通知クリックによる復帰時の二重処理を防げます。
//
//   document.addEventListener('visibilitychange', () => {
//     if (document.visibilityState === 'visible') {
//       // ▼ 追加: 通知クリックによる復帰なら汎用処理をスキップ
//       if (window.isHandlingNotificationClick) return;
//       // ↑ 追加ここまで
//
//       // ... 既存の画面復帰処理（pendingNewTweets のポーリング等）...
//     }
//   });
//
// ※ focus イベントで同様の処理をしている場合も同じガードを追加。
// ※ notification_clicked の message ハンドラ（DM 遷移・バナー表示）は
//    このフラグに関係なくそのまま実行されます。変更不要です。
// ==========================================================
