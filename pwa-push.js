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
//    ※ 後述の「VAPIDキー発行方法」で生成した PUBLIC KEY を貼り付ける
// ----------------------------------------------------------
const VAPID_PUBLIC_KEY = 'BP5a5eqrkxqo1LxtZYuIdk2ax7zxtU2IbUaQbmzh5s9wUjCkKn95dnwnvJ5P_6k8q7-Ba62kQsZcgpVp2zocUrU';
// 例: 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U'


// ----------------------------------------------------------
// ユーティリティ: VAPID公開鍵 (Base64URL) → Uint8Array 変換
// ----------------------------------------------------------
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  return new Uint8Array([...rawData].map((c) => c.charCodeAt(0)));
}


// ----------------------------------------------------------
// ユーザー設定を Service Worker の CacheStorage に同期する
//
// 【なぜ必要か】
//   SW は localStorage にアクセスできないため、設定変更を知る手段がない。
//   postMessage で CacheStorage に書き込んでもらうことで、
//   SW がプッシュ受信時に「通知表示」と「バッジ付与」を
//   独立して判断できるようになる。
// ----------------------------------------------------------
function syncPrefsToSW(prefs) {
  if (!('serviceWorker' in navigator)) return;

  // pwa-push.js のキー名 → sw.js のキー名に変換して送信
  const swPrefs = {
    newPost: prefs.notifyTweet   !== false,
    dm:      prefs.notifyDm      !== false,
    comment: prefs.notifyComment !== false, // ★ コメント通知設定を追加
    badge:   prefs.notifyBadge   !== false,
  };

  const send = (controller) => {
    controller.postMessage({ type: 'SAVE_PREFS', prefs: swPrefs });
  };

  if (navigator.serviceWorker.controller) {
    send(navigator.serviceWorker.controller);
  } else {
    // SW がまだアクティブでない場合は ready 後に送信
    navigator.serviceWorker.ready.then(reg => {
      if (reg.active) send(reg.active);
    }).catch(() => {});
  }
}


// ----------------------------------------------------------
// ② Service Worker の登録
//    - appStart() より前に呼んでおくと良い（ページロード直後）
// ----------------------------------------------------------
async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) {
    console.warn('[PWA] Service Worker はこのブラウザでサポートされていません');
    return null;
  }

  try {
    const reg = await navigator.serviceWorker.register('/sw.js', {
      scope: '/',
      // updateViaCache: 'none' にすると常に最新の sw.js を取得
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
    // 通知タップでアプリがフォーカスされた → バッジを消去
    clearAppBadge();
  }
}


// ----------------------------------------------------------
// ③ 通知許可を求め、購読情報を Supabase に保存する
//    saveProfile() の後など、ユーザー情報が確定したタイミングで呼ぶ
// ----------------------------------------------------------
async function initPushNotifications() {
  // Service Worker が使えない環境はスキップ
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    console.warn('[PWA] Push 通知はこのブラウザでサポートされていません');
    return;
  }

  // ユーザー情報が必要
  if (!currentUser?.handle) return;

  // ユーザーの通知設定を確認
  const prefs = getPushPrefs();

  // 通知許可を確認（まだ許可していない場合はダイアログを出す）
  let permission = Notification.permission;

  if (permission === 'denied') {
    // ユーザーが明示的にブロックしている → 何もしない
    console.log('[PWA] 通知はブロックされています');
    return;
  }

  if (permission === 'default') {
    // 許可ダイアログを表示
    permission = await Notification.requestPermission();
  }

  if (permission !== 'granted') {
    console.log('[PWA] 通知が許可されませんでした');
    return;
  }

  // SW の登録を取得（既に登録済みのはず）
  const reg = await navigator.serviceWorker.ready;

  // 既存の購読を確認
  let subscription = await reg.pushManager.getSubscription();

  if (!subscription) {
    // 新規購読を作成
    try {
      subscription = await reg.pushManager.subscribe({
        userVisibleOnly: true, // 必須: falseにするとChrome で拒否される
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      });
      console.log('[PWA] Push 購読を作成しました');
    } catch (err) {
      console.error('[PWA] Push 購読の作成に失敗:', err);
      return;
    }
  }

  // Supabase に購読情報を保存（UPSERT: endpoint が同じなら更新）
  await savePushSubscription(subscription, prefs);

  // ★ SW の CacheStorage に現在の設定を同期する
  //   initPushNotifications() は SW 登録後に呼ばれるため、ここで一度同期しておく
  syncPrefsToSW(prefs);
}


// ----------------------------------------------------------
// 購読情報を Supabase の push_subscriptions テーブルに UPSERT
// ----------------------------------------------------------
async function savePushSubscription(subscription, prefs = {}) {
  if (!currentUser?.handle || !subscription) return;

  const subJson = subscription.toJSON();

  // ★ 修正ポイント ★
  //
  // 「通知オフ・バッジオン」の場合の問題:
  //   notify_tweet: false をDBに保存すると Edge Function がツイートのpushを
  //   送らなくなり、SW側でバッジを付ける機会すらなくなる。
  //
  // 解決策:
  //   バッジが必要（notifyBadge: true）ならば、通知タイプも true として保存し
  //   Edge Function に push を届けさせる。
  //   SW 側は CacheStorage にキャッシュした設定を参照して
  //   「通知表示」と「バッジ付与」を独立して制御する（sw.js 参照）。
  //
  //   つまり DB の notify_tweet/dm は「push を受け取るか」を示し、
  //   実際の「通知を表示するか」は SW の CacheStorage が決定する。
  const wantBadge = prefs.notifyBadge !== false;

  const record = {
    user_handle:  currentUser.handle,
    endpoint:     subJson.endpoint,
    p256dh:       subJson.keys.p256dh,
    auth:         subJson.keys.auth,
    // バッジが必要なら通知タイプをオンにして push を届けさせる
    notify_tweet:   prefs.notifyTweet   !== false || wantBadge,
    notify_dm:      prefs.notifyDm      !== false || wantBadge,
    notify_comment: prefs.notifyComment !== false || wantBadge, // ★ コメント通知
    notify_badge:   wantBadge,
    updated_at:   new Date().toISOString(),
  };

  // endpoint UNIQUE 制約を利用して UPSERT
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

// 設定変更時に呼ぶ（プロフィール画面の toggleなどから）
async function updatePushPref(key, value) {
  const prefs = getPushPrefs();
  prefs[key] = value;
  savePushPrefs(prefs);

  // ★ SW の CacheStorage にも設定を同期する
  //   これにより SW は次回 push 受信時に最新の設定を参照できる
  syncPrefsToSW(prefs);

  // DB の設定も更新する
  const reg = await navigator.serviceWorker.ready;
  const subscription = await reg.pushManager.getSubscription();
  if (subscription) {
    await savePushSubscription(subscription, prefs);
  }
}


// ----------------------------------------------------------
// ④ App Badging API — アプリアイコンのバッジ操作
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

  // SW 側にも通知（念のため）
  if (navigator.serviceWorker.controller) {
    navigator.serviceWorker.controller.postMessage({ type: 'CLEAR_BADGE' });
  }
}


// ----------------------------------------------------------
// ⑤ アプリ起動・フォーカス時に自動でバッジを消去する
//    index.html の appStart() または DOMContentLoaded で呼ぶ
// ----------------------------------------------------------
function setupBadgeAutoClearing() {
  // ページ表示時（通常起動 or タブ切り替えで戻ってきた時）
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      clearAppBadge();
    }
  });

  // ページ読み込み完了時（初回起動）
  if (document.visibilityState === 'visible') {
    clearAppBadge();
  }

  // ウィンドウがフォーカスを得た時（PC ブラウザ対応）
  window.addEventListener('focus', () => {
    clearAppBadge();
  });
}


// ----------------------------------------------------------
// ⑥ Push 購読を解除する（通知設定OFFにした時）
// ----------------------------------------------------------
async function unsubscribePush() {
  const reg = await navigator.serviceWorker.ready;
  const subscription = await reg.pushManager.getSubscription();

  if (!subscription) return;

  // ブラウザの購読を解除
  const unsubscribed = await subscription.unsubscribe();

  if (unsubscribed && currentUser?.handle) {
    // DB からも削除
    await sb
      .from('push_subscriptions')
      .delete()
      .eq('endpoint', subscription.endpoint);
    console.log('[PWA] Push 購読を解除しました');
  }
}


// ----------------------------------------------------------
// プロフィール設定画面に通知設定UIを追加するヘルパー
// index.html の openProfileModal() の後あたりで呼ぶ
// ----------------------------------------------------------
function renderPushSettingsUI(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;

  const prefs = getPushPrefs();
  const supported = ('serviceWorker' in navigator) && ('PushManager' in window);
  const permission = supported ? Notification.permission : 'unsupported';

  // ★ 画面を開くたびに SW へ現在の設定を同期する
  //   （ページリロードや別端末からの変更に備える）
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

// チェックボックス変更時のハンドラ
async function onPushPrefChange(key, value) {
  await updatePushPref(key, value);
  showToast(value ? '設定を有効にしました' : '設定を無効にしました');
}


// ----------------------------------------------------------
// 初期化 — DOM 読み込み完了後に SW を登録 & バッジ消去設定
// ----------------------------------------------------------
(async function pwaPushInit() {
  // ★ バッジ消去ハンドラを最優先で登録（SW 登録の await より前）★
  // await registerServiceWorker() で処理が中断されても
  // visibilitychange・focus リスナーは確実に設定される
  setupBadgeAutoClearing();

  // Service Worker の登録（バックグラウンドで行う）
  await registerServiceWorker();

  // ★ SW 登録直後に現在の設定を同期する
  //   ページリロード時など initPushNotifications() が呼ばれる前でも
  //   SW が正しい設定で動くようにする
  const prefs = getPushPrefs();
  syncPrefsToSW(prefs);
})();
