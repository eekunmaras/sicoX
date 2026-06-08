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
