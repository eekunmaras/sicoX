// ══════════════════════════════════════
// SicoX Hope - 寄付サイト本体ロジック
// SNS本体(sicox.html)と同じSupabaseプロジェクトを参照する
// ══════════════════════════════════════

const SUPABASE_URL = 'https://lbulatinwtsqgudgdhpe.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxidWxhdGlud3RzcWd1ZGdkaHBlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkyNTc3NDgsImV4cCI6MjA5NDgzMzc0OH0.4pNE5vxC2Z3OdXcj6MDUuMZpHhUZMRdyxhSipsZyEUU';
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

const DONATE_REASON = '寄付';

// ── ユーザー色（SNS本体と同じロジック） ──
function userColor(s){
  if(!s) return '#444';
  const c=['#1d9bf0','#f91880','#00ba7c','#ff7747','#794bc4','#ffa500','#00b4d8','#e63946'];
  let h=0; for(let i=0;i<s.length;i++) h=(h*31+s.charCodeAt(i))|0;
  return c[Math.abs(h)%c.length];
}
function esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function initial(name){ return (name||'?').trim().charAt(0).toUpperCase()||'?'; }

// ── ログイン中ユーザー（SNS本体のlocalStorageを共有） ──
let currentUser = null;
function loadUserLS(){
  try{ const r=localStorage.getItem('mn_user'); if(r) currentUser=JSON.parse(r); }catch(e){}
}

let selectedAmount = null;
let isCustomMode = false;
let myAvailablePoints = 0;

// ══════════════════════════════════════
// ポイント残高（SNS本体と同じ計算ロジック）
// ══════════════════════════════════════
async function dbFetchEarnedPointsSimple(handle){
  try{
    const {data,error}=await sb.from('taika_scores').select('score').eq('user_handle',handle);
    if(error||!data) return 0;
    return data.reduce((sum,row)=>sum+(row.score||0),0);
  }catch(e){ return 0; }
}
async function dbFetchPositivePointTransactions(handle){
  try{
    const {data,error}=await sb.from('point_transactions').select('delta').eq('user_handle',handle).gt('delta',0);
    if(error||!data) return 0;
    return data.reduce((sum,row)=>sum+(row.delta||0),0);
  }catch(e){ return 0; }
}
async function dbFetchSpentPoints(handle){
  try{
    const {data,error}=await sb.from('point_transactions').select('delta').eq('user_handle',handle).lt('delta',0);
    if(error||!data) return 0;
    return data.reduce((sum,row)=>sum+Math.abs(row.delta||0),0);
  }catch(e){ return 0; }
}
async function dbFetchAvailablePoints(handle){
  const [scoreP,txP,spent]=await Promise.all([
    dbFetchEarnedPointsSimple(handle),
    dbFetchPositivePointTransactions(handle),
    dbFetchSpentPoints(handle)
  ]);
  return Math.max(0,(scoreP+txP)-spent);
}

// 寄付の実行（point_transactionsにマイナスdeltaを記録）
async function dbApplyDonation(handle,amount){
  const cleanDelta=-Math.abs(Math.round(Number(amount)||0));
  if(cleanDelta===0) return {ok:false,error:'金額が正しくありません'};
  const before=await dbFetchAvailablePoints(handle);
  if(before+cleanDelta<0){
    return {ok:false,error:'保有ポイントが不足しています'};
  }
  const {error}=await sb.from('point_transactions').insert({
    user_handle:handle,
    delta:cleanDelta,
    reason:DONATE_REASON,
    ref_id:'donate-'+Date.now()
  });
  if(error){ console.error('donation error',error); return {ok:false,error:'寄付の記録に失敗しました'}; }
  return {ok:true,balance:Math.max(0,before+cleanDelta)};
}

// ══════════════════════════════════════
// 総寄付額・寄付ログ・ランキング
// ══════════════════════════════════════

// SicoX Hope経由の寄付のみを対象にする（reason = '寄付' のマイナス取引）
async function dbFetchAllDonations(){
  try{
    const {data,error}=await sb.from('point_transactions')
      .select('user_handle,delta,reason,created_at')
      .eq('reason',DONATE_REASON)
      .lt('delta',0)
      .order('created_at',{ascending:false})
      .limit(2000);
    if(error||!data) return [];
    return data;
  }catch(e){ return []; }
}

async function dbFetchProfilesMap(){
  try{
    const {data,error}=await sb.from('profiles').select('handle,name,avatar_url,color');
    if(error||!data) return {};
    const map={};
    for(const p of data) map[p.handle]={name:p.name,avatar_url:p.avatar_url,color:p.color};
    return map;
  }catch(e){ return {}; }
}

// ══════════════════════════════════════
// 画面描画
// ══════════════════════════════════════

function fmtPts(n){ return Math.round(n).toLocaleString('ja-JP'); }

function fmtDateShort(iso){
  try{
    const d=new Date(iso);
    return `${d.getMonth()+1}/${d.getDate()}`;
  }catch(e){ return ''; }
}

function renderUserPill(){
  const slot=document.getElementById('user-pill-slot');
  if(!currentUser||!currentUser.handle){
    slot.innerHTML='';
    return;
  }
  const col=currentUser.color||userColor(currentUser.handle);
  slot.innerHTML=`
    <div class="user-pill">
      <span class="av" style="background:${col};overflow:hidden;">
        ${currentUser.avatarUrl?`<img src="${esc(currentUser.avatarUrl)}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;">`:esc(initial(currentUser.name))}
      </span>
      <span class="user-pill-info">
        <span class="user-pill-name">${esc(currentUser.name||currentUser.handle)}</span>
        <span class="user-pill-pts" id="header-pts-display">— pt</span>
      </span>
    </div>
  `;
}

function renderMyBalance(){
  document.getElementById('my-balance').textContent = fmtPts(myAvailablePoints)+' pt';
  const hdr=document.getElementById('header-pts-display');
  if(hdr) hdr.textContent = fmtPts(myAvailablePoints)+' pt';
}

// ── 段階解放ニュースの表示制御 ──
let currentTotal = 0;
let unlockedCount = 0;
const NEWS_VISIBLE_STEP = 6; // 「もっと見る」で何件ずつ表示するか
let newsRenderLimit = NEWS_VISIBLE_STEP;

function getUnlockedNews(total){
  return NEWS_DATA.filter(n=>n.t<=total);
}

function renderTotalAndGauge(total){
  document.getElementById('total-amount-display').innerHTML = `${fmtPts(total)}<span class="unit">pt</span>`;

  const unlocked = getUnlockedNews(total);
  const nextItem = NEWS_DATA.find(n=>n.t>total);

  document.getElementById('total-sub-display').textContent =
    `これまでに ${unlocked.length} 件の支援レポートが届きました`;

  document.getElementById('gauge-current-label').textContent = fmtPts(total)+' pt';

  if(nextItem){
    const prevThresh = unlocked.length ? unlocked[unlocked.length-1].t : 0;
    const span = nextItem.t - prevThresh;
    const progressed = total - prevThresh;
    const pct = Math.min(100, Math.max(0,(progressed/span)*100));
    document.getElementById('gauge-fill').style.width = pct.toFixed(1)+'%';
    document.getElementById('gauge-next-label').textContent = '次のレポートまで';
    document.getElementById('gauge-next-text').innerHTML =
      `あと <b>${fmtPts(nextItem.t-total)} pt</b> で次の支援となります`;
  }else{
    document.getElementById('gauge-fill').style.width='100%';
    document.getElementById('gauge-next-label').textContent='全レポート解放済み';
    document.getElementById('gauge-next-text').innerHTML = 'すべての支援レポートが届きました。ありがとうございます。';
  }
}

function newsCardHTML(item, idx, isLatest){
  return `
    <div class="news-card${isLatest?' latest':''}">
      <div class="num">${idx+1}</div>
      <div style="flex:1;min-width:0;">
        <div class="news-meta">
          <span class="news-tag">${esc(item.cat)}</span>
          <span class="news-region">${esc(item.region)}</span>
          <span class="news-thresh">累計 ${fmtPts(item.t)}pt 達成</span>
        </div>
        <p class="news-title">${esc(item.title)}</p>
        <p class="news-body">${esc(item.body)}</p>
      </div>
    </div>
  `;
}

function renderNewsFeed(total){
  const unlocked = getUnlockedNews(total).slice().reverse(); // 新しい(しきい値が高い)ものを上に
  const feed=document.getElementById('news-feed');

  if(unlocked.length===0){
    feed.innerHTML = `<div class="news-locked-hint">まだ支援レポートは届いていません。寄付が集まると、最初のレポートが解放されます。</div>`;
    return;
  }

  const visible = unlocked.slice(0, newsRenderLimit);
  let html = visible.map((item,i)=>newsCardHTML(item, unlocked.length-1-i, i===0)).join('');

  if(unlocked.length > newsRenderLimit){
    html += `<button class="news-more-btn" id="news-more-btn">もっと見る（残り${unlocked.length-newsRenderLimit}件）</button>`;
  }
  feed.innerHTML = html;

  const moreBtn=document.getElementById('news-more-btn');
  if(moreBtn){
    moreBtn.addEventListener('click',()=>{
      newsRenderLimit += NEWS_VISIBLE_STEP;
      renderNewsFeed(currentTotal);
    });
  }
}

function renderLog(donations, profilesMap){
  const list=document.getElementById('log-list');
  if(!donations.length){
    list.innerHTML = `<div class="log-empty">まだ寄付の記録がありません</div>`;
    return;
  }
  const oneWeekAgo = Date.now() - 7*24*60*60*1000;
  const recent = donations.filter(d=>{
    const t=new Date(d.created_at).getTime();
    return !isNaN(t) && t>=oneWeekAgo;
  });
  const items = (recent.length?recent:donations.slice(0,20));

  list.innerHTML = items.map(d=>{
    const prof = profilesMap[d.user_handle]||{};
    const name = prof.name || d.user_handle || '匿名';
    const col = prof.color || userColor(d.user_handle||name);
    const amt = Math.abs(d.delta||0);
    const av = prof.avatar_url
      ? `<img src="${esc(prof.avatar_url)}">`
      : esc(initial(name));
    return `
      <div class="log-item">
        <span class="av" style="background:${col};">${av}</span>
        <span class="log-text"><b>${esc(name)}</b>さんが寄付してくれました</span>
        <span class="log-pts">+${fmtPts(amt)}pt</span>
        <span class="log-date">${fmtDateShort(d.created_at)}</span>
      </div>
    `;
  }).join('');
}

function renderRanking(donations, profilesMap){
  const totals={};
  for(const d of donations){
    const h=d.user_handle||'unknown';
    totals[h]=(totals[h]||0)+Math.abs(d.delta||0);
  }
  const ranked = Object.entries(totals).sort((a,b)=>b[1]-a[1]).slice(0,10);
  const grid=document.getElementById('rank-grid');

  if(!ranked.length){
    grid.innerHTML = `<div class="rank-empty">まだ寄付した人がいません。最初の寄付者になりませんか？</div>`;
    return;
  }

  const maxAmt = ranked[0][1];
  grid.innerHTML = ranked.map(([handle,amt],i)=>{
    const prof = profilesMap[handle]||{};
    const name = prof.name || handle;
    const col = prof.color || userColor(handle);
    const av = prof.avatar_url
      ? `<img src="${esc(prof.avatar_url)}">`
      : esc(initial(name));
    const pct = Math.max(4,(amt/maxAmt)*100);
    return `
      <div class="rank-card">
        <div class="rank-no">${i+1}</div>
        <div class="rank-av" style="background:${col};">${av}</div>
        <div class="rank-info">
          <div class="rank-name">${esc(name)}</div>
          <div class="rank-bar-track"><div class="rank-bar-fill" style="width:${pct}%;"></div></div>
        </div>
        <div class="rank-amount">${fmtPts(amt)}pt</div>
      </div>
    `;
  }).join('');
}

// ══════════════════════════════════════
// トースト & モーダル
// ══════════════════════════════════════
function showToast(text){
  const t=document.getElementById('toast');
  document.getElementById('toast-text').textContent=text;
  t.classList.add('show');
  setTimeout(()=>t.classList.remove('show'),3200);
}

function openUnlockModal(item){
  document.getElementById('unlock-eyebrow').textContent = `累計${fmtPts(item.t)}pt 達成`;
  document.getElementById('unlock-title').textContent = item.title;
  document.getElementById('unlock-body').textContent = item.body;
  document.getElementById('unlock-modal').classList.add('show');
}
function closeUnlockModal(){
  document.getElementById('unlock-modal').classList.remove('show');
}

// ══════════════════════════════════════
// 寄付金額選択UI
// ══════════════════════════════════════
function setupAmountUI(){
  const buttons = document.querySelectorAll('.amount-btn');
  const customWrap = document.getElementById('custom-input-wrap');
  const customInput = document.getElementById('custom-amount-input');
  const submitBtn = document.getElementById('donate-submit-btn');

  function updateSubmitLabel(){
    if(!currentUser||!currentUser.handle){
      submitBtn.textContent = 'ログインが必要です';
      submitBtn.disabled = true;
      return;
    }
    if(selectedAmount && selectedAmount>0){
      submitBtn.textContent = `${fmtPts(selectedAmount)}pt 寄付する`;
      submitBtn.disabled = selectedAmount > myAvailablePoints;
      if(selectedAmount > myAvailablePoints){
        submitBtn.textContent = 'ポイントが不足しています';
      }
    }else{
      submitBtn.textContent = '金額を選んでください';
      submitBtn.disabled = true;
    }
  }

  buttons.forEach(btn=>{
    btn.addEventListener('click',()=>{
      buttons.forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      if(btn.dataset.amt==='custom'){
        isCustomMode = true;
        customWrap.style.display='flex';
        customInput.focus();
        selectedAmount = Number(customInput.value)||null;
      }else{
        isCustomMode = false;
        customWrap.style.display='none';
        selectedAmount = Number(btn.dataset.amt);
      }
      updateSubmitLabel();
    });
  });

  customInput.addEventListener('input',()=>{
    selectedAmount = Number(customInput.value)||null;
    updateSubmitLabel();
  });

  submitBtn.addEventListener('click', async ()=>{
    if(!currentUser||!currentUser.handle) return;
    if(!selectedAmount||selectedAmount<=0) return;
    submitBtn.disabled = true;
    submitBtn.textContent = '処理中…';

    const res = await dbApplyDonation(currentUser.handle, selectedAmount);
    if(res.ok){
      myAvailablePoints = res.balance;
      renderMyBalance();
      showToast(`${fmtPts(selectedAmount)}ptを寄付しました。ありがとうございます！`);
      selectedAmount=null;
      buttons.forEach(b=>b.classList.remove('active'));
      customInput.value='';
      customWrap.style.display='none';
      await refreshAllData(true);
    }else{
      showToast(res.error||'寄付に失敗しました');
    }
    updateSubmitLabel();
  });

  window.__updateSubmitLabel = updateSubmitLabel;
}

// ══════════════════════════════════════
// 初期化・データ取得
// ══════════════════════════════════════
async function refreshAllData(checkUnlock){
  const [donations, profilesMap] = await Promise.all([
    dbFetchAllDonations(),
    dbFetchProfilesMap()
  ]);

  const prevTotal = currentTotal;
  const total = donations.reduce((sum,d)=>sum+Math.abs(d.delta||0),0);
  currentTotal = total;

  renderTotalAndGauge(total);
  renderNewsFeed(total);
  renderLog(donations, profilesMap);
  renderRanking(donations, profilesMap);

  if(checkUnlock){
    const newlyUnlocked = NEWS_DATA.filter(n=>n.t>prevTotal && n.t<=total);
    if(newlyUnlocked.length){
      // 一番高いしきい値のレポートを表示
      openUnlockModal(newlyUnlocked[newlyUnlocked.length-1]);
    }
  }
}

async function init(){
  loadUserLS();
  renderUserPill();

  if(!currentUser||!currentUser.handle){
    document.getElementById('no-user-warn').style.display='block';
    document.getElementById('my-balance').textContent='— pt';
  }else{
    myAvailablePoints = await dbFetchAvailablePoints(currentUser.handle);
    renderMyBalance();
    // ヘッダーpt表示を初期値でセット
    const hdr=document.getElementById('header-pts-display');
    if(hdr) hdr.textContent = fmtPts(myAvailablePoints)+' pt';
  }

  setupAmountUI();
  if(window.__updateSubmitLabel) window.__updateSubmitLabel();

  await refreshAllData(false);
}

document.getElementById('unlock-modal').addEventListener('click',(e)=>{
  if(e.target.id==='unlock-modal') closeUnlockModal();
});

init();
