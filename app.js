// まちアリーナ — フロントエンド
import { CONFIG } from './config.js';

/* ============================================================
 * 定数・状態
 * ============================================================ */
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const dbg = (...a) => { if (CONFIG.DEBUG_MODE) console.log('[まちアリーナ]', ...a); };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const MODE_LABEL = { onigokko: 'リアル鬼ごっこ', kakurenbo: 'リアルかくれんぼ', territory: 'リアル陣取り合戦', board: 'リアルすごろく' };
const TEAM_LABEL = { red: '赤チーム', blue: '青チーム' };
const ROLE_LABEL = { oni: '鬼', runner: '逃走者' };
const COLOR = { oni: '#ffb020', runner: '#4be3d0', red: '#ff4d6d', blue: '#3da5ff', neutral: '#5a6b8c', safe: '#2bb8a6', board: '#7a5cff', target: '#ffb020', caught: '#777' };
const MODE_DEFAULTS = {
  onigokko: { hideSeconds: 30, revealInterval: 180, radarRange: 300 },
  kakurenbo: { hideSeconds: 120, revealInterval: 300, radarRange: 150 },
  territory: { radarRange: 300 },
  board: {}
};
const isTagMode = (m) => m === 'onigokko' || m === 'kakurenbo';

const S = {
  token: null, user: null, screen: null,
  roomId: null, state: null, prevStatus: null, serverOffset: 0,
  lastEventTs: 0, firstSync: true, feedIds: new Set(), unread: 0,
  pos: null, watchId: null, geoWarned: false,
  pollTimer: null, tickTimer: null, syncing: false,
  map: null, spotLayer: null, playerMarkers: new Map(), meMarker: null, accCircle: null,
  waitMap: null, waitLayer: null, waitMe: null, pickMode: false,
  sig: {}, view: 'map', radarRAF: null,
  media: null, audioCtx: null, ttsQueue: [], speaking: false,
  soundOn: localStorage.getItem('machiArena.sound') !== 'off',
  wakeLock: null, marks: new Set(), lastAlertAt: 0, cinemaTimer: null, busy: false
};

/* ============================================================
 * 起動
 * ============================================================ */
init();

function init() {
  $('#app-version').textContent = CONFIG.APP_VERSION;
  bindPasswordToggles();
  bindAuth();
  bindLobby();
  bindRoom();
  bindGame();
  bindHelp();
  unlockAudioOnFirstTap();
  updateSoundButton();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      if (S.screen === 'game') requestWakeLock();
      if (S.roomId) syncRoom();
    }
  });
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch((e) => dbg('sw', e));
  if (!CONFIG.GAS_API_URL || CONFIG.GAS_API_URL.includes('XXXX')) {
    toast('config.js の GAS_API_URL を設定してください', true);
  }
  restoreSession();
}

/* ============================================================
 * API
 * ============================================================ */
async function api(action, data = {}) {
  const payload = { action, token: S.token, ...data };
  dbg('→', action, data);
  let res;
  try {
    res = await fetch(CONFIG.GAS_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload),
      redirect: 'follow'
    });
  } catch (e) {
    const err = new Error('通信できませんでした。電波の良い場所で再試行してください');
    err.code = 'NETWORK';
    throw err;
  }
  const json = await res.json().catch(() => ({ ok: false, error: 'BAD_RESPONSE', message: 'サーバーの応答を読み取れませんでした' }));
  dbg('←', action, json);
  if (!json.ok) {
    if (json.error === 'AUTH_REQUIRED') { clearSession(); stopRoomLoop(); show('auth'); }
    if (json.error === 'MUST_CHANGE_PASSWORD') show('change');
    const err = new Error(json.message || json.error);
    err.code = json.error;
    throw err;
  }
  return json;
}

function safe(fn) {
  return async (...args) => {
    if (S.busy) return;
    S.busy = true;
    $('#loading').classList.remove('hidden');
    try { await fn(...args); }
    catch (e) { toast(e.message || String(e), true); dbg(e); }
    finally { S.busy = false; $('#loading').classList.add('hidden'); }
  };
}

/* ============================================================
 * 画面・共通UI
 * ============================================================ */
function show(name) {
  S.screen = name;
  $$('.screen').forEach((s) => s.classList.toggle('active', s.id === 'screen-' + name));
  const loggedIn = !!S.token && name !== 'auth';
  $('#hdr-user').classList.toggle('hidden', !loggedIn);
  $('#btn-logout').classList.toggle('hidden', !loggedIn);
  if (S.user) $('#hdr-user').textContent = S.user.nickname;
  if (name === 'game') setTimeout(() => S.map && S.map.invalidateSize(), 60);
  if (name === 'room') setTimeout(() => S.waitMap && S.waitMap.invalidateSize(), 60);
  if (name !== 'game') { releaseWakeLock(); setView('map'); }
  window.scrollTo(0, 0);
}

let toastTimer = null;
function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('error', isError);
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), isError ? 4500 : 3000);
}

function bindPasswordToggles() {
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.pw-toggle');
    if (!btn) return;
    const input = document.getElementById(btn.dataset.target);
    const showing = input.type === 'text';
    input.type = showing ? 'password' : 'text';
    btn.textContent = showing ? '👁' : '👁‍🗨';
    btn.setAttribute('aria-label', showing ? 'パスワードを表示' : 'パスワードを隠す');
  });
}

/* ============================================================
 * セッション・認証
 * ============================================================ */
function saveSession() {
  localStorage.setItem(CONFIG.STORAGE_KEY, JSON.stringify({ token: S.token, user: S.user }));
}
function clearSession() {
  S.token = null; S.user = null;
  localStorage.removeItem(CONFIG.STORAGE_KEY);
  localStorage.removeItem(CONFIG.ROOM_KEY);
}
function setUser(user) {
  S.user = user;
  saveSession();
  $('#hdr-user').textContent = user.nickname;
}

async function restoreSession() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(CONFIG.STORAGE_KEY) || 'null'); } catch (e) { /* noop */ }
  if (!saved || !saved.token) { show('auth'); return; }
  S.token = saved.token;
  S.user = saved.user;
  try {
    const r = await api('me');
    setUser(r.user);
    routeAfterLogin();
  } catch (e) {
    if (e.code !== 'AUTH_REQUIRED') { show('auth'); toast(e.message, true); }
  }
}

function routeAfterLogin() {
  if (S.user.isFirstLogin) { show('change'); return; }
  loadMedia();
  const roomId = localStorage.getItem(CONFIG.ROOM_KEY);
  if (roomId) enterRoom(roomId);
  else gotoLobby();
}

function switchTab(tab) {
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
  $$('.auth-form[data-pane]').forEach((f) => f.classList.toggle('hidden', f.dataset.pane !== tab));
  $('#temp-result').classList.add('hidden');
}

function bindAuth() {
  $$('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));

  $('#form-login').addEventListener('submit', safe(async (e) => {
    e.preventDefault();
    const email = $('#login-email').value.trim();
    const password = $('#login-password').value;
    const r = await api('login', { email, password });
    S.token = r.token;
    setUser(r.user);
    $('#login-password').value = '';
    if (r.user.isFirstLogin) {
      $('#chg-current').value = password;
      show('change');
      toast('仮パスワードでログインしました。本パスワードを設定してください');
    } else {
      toast(`ようこそ、${r.user.nickname} さん`);
      routeAfterLogin();
    }
  }));

  $('#form-register').addEventListener('submit', safe(async (e) => {
    e.preventDefault();
    const email = $('#reg-email').value.trim();
    const nickname = $('#reg-nickname').value.trim();
    const r = await api('register', { email, nickname });
    $('#form-register').classList.add('hidden');
    $('#temp-password').value = r.tempPassword;
    $('#temp-password').type = 'password';
    $('#temp-mail-note').textContent = r.mailed
      ? `${email} にも仮パスワードを送信しました。`
      : 'メール送信はできませんでした。この画面の仮パスワードを控えてください。';
    $('#temp-result').classList.remove('hidden');
    $('#temp-result').dataset.email = email;
  }));

  $('#btn-copy-temp').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('#temp-password').value); toast('仮パスワードをコピーしました'); }
    catch (e) { toast('コピーできませんでした。表示して書き写してください', true); }
  });

  $('#btn-go-login').addEventListener('click', () => {
    const email = $('#temp-result').dataset.email || '';
    const pw = $('#temp-password').value;
    switchTab('login');
    $('#login-email').value = email;
    $('#login-password').value = pw;
  });

  $('#form-forgot').addEventListener('submit', safe(async (e) => {
    e.preventDefault();
    const email = $('#forgot-email').value.trim();
    const r = await api('forgotPassword', { email });
    toast(r.message);
    switchTab('login');
    $('#login-email').value = email;
  }));

  $('#form-change').addEventListener('submit', safe(async (e) => {
    e.preventDefault();
    const currentPassword = $('#chg-current').value;
    const newPassword = $('#chg-new').value;
    if (newPassword !== $('#chg-confirm').value) throw new Error('確認用のパスワードが一致しません');
    if (newPassword.length < 8 || !/[A-Za-z]/.test(newPassword) || !/[0-9]/.test(newPassword)) {
      throw new Error('パスワードは英字と数字を含む8文字以上にしてください');
    }
    const r = await api('changePassword', { currentPassword, newPassword });
    setUser(r.user);
    $('#form-change').reset();
    toast('パスワードを設定しました');
    routeAfterLogin();
  }));

  $('#btn-logout').addEventListener('click', async () => {
    if (!confirm('ログアウトしますか？')) return;
    try { await api('logout'); } catch (e) { /* noop */ }
    stopRoomLoop();
    clearSession();
    S.roomId = null;
    show('auth');
  });
}

/* ============================================================
 * 使い方
 * ============================================================ */
function openHelp(section) {
  $('#help').classList.remove('hidden');
  if (!section) {
    section = { auth: 'start', change: 'start', lobby: 'room', room: 'room', game: 'screen', result: 'modes' }[S.screen] || 'start';
  }
  jumpHelp(section);
}

function jumpHelp(section) {
  $$('.help-nav button').forEach((b) => b.classList.toggle('current', b.dataset.help === section));
  const target = document.getElementById('help-' + section);
  if (target) target.scrollIntoView({ block: 'start' });
}

function closeHelp() {
  $('#help').classList.add('hidden');
}

function bindHelp() {
  $('#btn-help').addEventListener('click', () => openHelp());
  $('#btn-help-close').addEventListener('click', closeHelp);
  $('#help').addEventListener('click', (e) => { if (e.target.id === 'help') closeHelp(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeHelp(); });
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-help]');
    if (!b) return;
    if (b.closest('.help-nav')) jumpHelp(b.dataset.help);
    else openHelp(b.dataset.help);
  });
}

/* ============================================================
 * 位置情報
 * ============================================================ */
function startGeo() {
  if (!navigator.geolocation) { setGps('off'); toast('この端末では位置情報が使えません', true); return; }
  if (S.watchId != null) return;
  S.watchId = navigator.geolocation.watchPosition((p) => {
    S.pos = { lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy, ts: Date.now() };
    setGps(p.coords.accuracy <= 30 ? 'ok' : 'weak', p.coords.accuracy);
    updateMeMarkers();
  }, (err) => {
    setGps('off');
    if (!S.geoWarned) {
      S.geoWarned = true;
      const msg = err.code === 1 ? '位置情報の利用が許可されていません。ブラウザの設定で許可してください'
        : '位置情報を取得できません。屋外で再試行してください';
      toast(msg, true);
    }
  }, { enableHighAccuracy: true, maximumAge: 3000, timeout: 20000 });
}

function setGps(state, acc) {
  const el = $('#gps-indicator');
  el.className = 'gps ' + state;
  el.textContent = state === 'off' ? 'GPS ×' : `GPS ±${Math.round(acc)}m`;
}

function waitForPos(ms = 6000) {
  if (S.pos) return Promise.resolve(S.pos);
  return new Promise((resolve) => {
    const start = Date.now();
    const iv = setInterval(() => {
      if (S.pos || Date.now() - start > ms) { clearInterval(iv); resolve(S.pos); }
    }, 300);
  });
}

function distM(lat1, lng1, lat2, lng2) {
  const R = 6371000, r = Math.PI / 180;
  const dLat = (lat2 - lat1) * r, dLng = (lng2 - lng1) * r;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
function bearingDeg(lat1, lng1, lat2, lng2) {
  const r = Math.PI / 180;
  const y = Math.sin((lng2 - lng1) * r) * Math.cos(lat2 * r);
  const x = Math.cos(lat1 * r) * Math.sin(lat2 * r) - Math.sin(lat1 * r) * Math.cos(lat2 * r) * Math.cos((lng2 - lng1) * r);
  return (Math.atan2(y, x) / r + 360) % 360;
}
const earthUrl = (lat, lng) => `https://earth.google.com/web/@${lat},${lng},40a,600d,35y,0h,60t,0r`;

/* ============================================================
 * ロビー
 * ============================================================ */
function gotoLobby() {
  stopRoomLoop();
  S.roomId = null;
  S.state = null;
  localStorage.removeItem(CONFIG.ROOM_KEY);
  show('lobby');
  $('#lobby-hello').textContent = `${S.user.nickname} さん、どのゲームで遊びますか？`;
  startGeo();
  loadRooms();
  if (!localStorage.getItem('machiArena.helpSeen')) {
    localStorage.setItem('machiArena.helpSeen', '1');
    openHelp('room');
  }
}

async function loadRooms() {
  const list = $('#room-list');
  try {
    await waitForPos(2500);
    const r = await api('listRooms', { lat: S.pos?.lat, lng: S.pos?.lng });
    if (!r.rooms.length) {
      list.innerHTML = '<li class="empty">近くに募集中のルームはありません。上のモードを選んでルームを作りましょう。</li>';
      return;
    }
    list.innerHTML = r.rooms.map((rm) => `
      <li class="room-item ${rm.joined ? 'joined' : ''}">
        <div class="ri-main">
          <div class="ri-name">${esc(rm.name)}</div>
          <div class="ri-meta">${esc(rm.modeLabel)}／${rm.players}人／${rm.status === 'playing' ? 'ゲーム中' : '募集中'}${rm.distance != null ? `／約${rm.distance >= 1000 ? (rm.distance / 1000).toFixed(1) + 'km' : rm.distance + 'm'}` : ''}</div>
        </div>
        <button type="button" class="btn small ${rm.joined ? 'primary' : ''}" data-room="${esc(rm.roomId)}" data-code="${esc(rm.code)}" data-joined="${rm.joined}">${rm.joined ? '戻る' : '参加'}</button>
      </li>`).join('');
  } catch (e) {
    list.innerHTML = `<li class="empty">${esc(e.message)}</li>`;
  }
}

function openCreatePanel(mode) {
  $$('.mode-card').forEach((c) => c.classList.toggle('selected', c.dataset.mode === mode));
  $('#create-mode').value = mode;
  $('#create-mode-label').textContent = MODE_LABEL[mode] + 'のルームを作成';
  const form = $('#form-create');
  form.querySelectorAll('[data-modes]').forEach((el) => {
    el.classList.toggle('hidden', !el.dataset.modes.split(' ').includes(mode));
  });
  Object.entries(MODE_DEFAULTS[mode]).forEach(([k, v]) => { if (form.elements[k]) form.elements[k].value = v; });
  $('#create-panel').classList.remove('hidden');
  $('#create-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function bindLobby() {
  $$('.mode-card').forEach((c) => c.addEventListener('click', () => openCreatePanel(c.dataset.mode)));
  $('#btn-create-cancel').addEventListener('click', () => {
    $('#create-panel').classList.add('hidden');
    $$('.mode-card').forEach((c) => c.classList.remove('selected'));
  });

  $('#form-create').addEventListener('submit', safe(async (e) => {
    e.preventDefault();
    const form = e.target;
    const mode = $('#create-mode').value;
    const settings = {};
    ['durationMin', 'catchRadius', 'hideSeconds', 'revealInterval', 'radarRange', 'alertRadius', 'oniCount', 'checkinRadius', 'captureCooldownSec']
      .forEach((k) => { if (form.elements[k]) settings[k] = Number(form.elements[k].value); });
    settings.infect = form.elements.infect.checked;
    settings.aiAnnounce = form.elements.aiAnnounce.checked;
    const pos = await waitForPos(4000);
    const r = await api('createRoom', { mode, name: $('#create-name').value.trim(), settings, lat: pos?.lat, lng: pos?.lng });
    $('#create-panel').classList.add('hidden');
    toast(`ルームを作成しました（コード ${r.code}）`);
    await enterRoom(r.roomId);
  }));

  const join = safe(async (code) => {
    code = String(code || '').trim().toUpperCase();
    if (code.length !== 6) throw new Error('ルームコードは6文字です');
    const r = await api('joinRoom', { code });
    $('#join-code').value = '';
    await enterRoom(r.roomId);
  });
  $('#btn-join').addEventListener('click', () => join($('#join-code').value));
  $('#join-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') join(e.target.value); });
  $('#btn-refresh-rooms').addEventListener('click', loadRooms);

  $('#room-list').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-room]');
    if (!b) return;
    if (b.dataset.joined === 'true') enterRoom(b.dataset.room);
    else join(b.dataset.code);
  });
}

/* ============================================================
 * ルーム同期ループ
 * ============================================================ */
async function enterRoom(roomId) {
  stopRoomLoop();
  S.roomId = roomId;
  S.state = null;
  S.prevStatus = null;
  S.lastEventTs = 0;
  S.firstSync = true;
  S.feedIds = new Set();
  S.unread = 0;
  S.sig = {};
  S.marks = new Set();
  S.pickMode = false;
  $('#feed-list').innerHTML = '';
  updateFeedBadge();
  localStorage.setItem(CONFIG.ROOM_KEY, roomId);
  startGeo();
  await syncRoom();
  if (!S.state) { localStorage.removeItem(CONFIG.ROOM_KEY); if (S.user) gotoLobby(); return; }
  if (S.state.room.status !== 'finished') startRoomLoop();
}

function startRoomLoop() {
  clearInterval(S.pollTimer);
  clearInterval(S.tickTimer);
  S.pollTimer = setInterval(syncRoom, CONFIG.POLL_INTERVAL_MS);
  S.tickTimer = setInterval(tick, 500);
}
function stopRoomLoop() {
  clearInterval(S.pollTimer);
  clearInterval(S.tickTimer);
  S.pollTimer = S.tickTimer = null;
  releaseWakeLock();
}

async function syncRoom() {
  if (!S.roomId || S.syncing || !S.token) return;
  S.syncing = true;
  try {
    const p = S.pos && Date.now() - S.pos.ts < 30000 ? S.pos : null;
    const r = await api('syncRoom', {
      roomId: S.roomId, sinceTs: S.lastEventTs,
      lat: p?.lat, lng: p?.lng, accuracy: p?.acc
    });
    applyState(r.state);
    handleEvents(r.events);
  } catch (e) {
    dbg('sync error', e);
    if (['ROOM_NOT_FOUND', 'NOT_IN_ROOM'].includes(e.code)) { toast(e.message, true); gotoLobby(); }
  } finally {
    S.syncing = false;
  }
}

function applyState(st) {
  S.state = st;
  S.serverOffset = st.serverNow - Date.now();
  const status = st.room.status;
  S.prevStatus = status;
  if (status === 'waiting') {
    if (S.screen !== 'room') show('room');
    renderWaiting(st);
  } else if (status === 'playing') {
    if (S.screen !== 'game') {
      show('game');
      initGameMap();
      requestWakeLock();
    }
    renderGame(st);
  } else {
    if (S.screen !== 'result') {
      renderResult(st);
      show('result');
      stopRoomLoop();
      localStorage.removeItem(CONFIG.ROOM_KEY);
    }
  }
}

function handleEvents(events) {
  (events || []).forEach((ev) => {
    S.lastEventTs = Math.max(S.lastEventTs, ev.createdAt);
    if (S.feedIds.has(ev.id)) return;
    S.feedIds.add(ev.id);
    addFeed(ev);
    if (S.firstSync || ev.type === 'system' || ev.type === 'order') return;
    if (ev.type === 'start') playCinema('start', ev.message);
    if (ev.type === 'finish') playCinema('win', ev.message);
    speak(ev.message);
  });
  S.firstSync = false;
}

/* ============================================================
 * 待機室
 * ============================================================ */
function renderWaiting(st) {
  const { room, players, spots } = st;
  $('#room-name').textContent = room.name;
  $('#room-mode').textContent = room.modeLabel;
  $('#room-code').textContent = room.code;

  const spotTitle = isTagMode(room.mode) ? 'セーフティゾーン（中にいる間は捕まりません）'
    : room.mode === 'territory' ? '陣地スポット（チェックインで占領）' : 'すごろくのマス（番号順に進みます）';
  $('#spot-title').textContent = spotTitle;
  $('#spot-tools').classList.toggle('hidden', !room.isHost);

  const spotSig = JSON.stringify([spots, room.isHost]);
  if (S.sig.waitSpots !== spotSig) {
    S.sig.waitSpots = spotSig;
    $('#spot-list').innerHTML = spots.length ? spots.map((s) => `
      <li>
        <span class="mk-spot" style="--c:${spotColor(s, room)};width:26px;height:26px;font-size:12px">${room.mode === 'board' ? s.orderNo : room.mode === 'territory' ? '⚑' : '✚'}</span>
        <span class="sp-name">${esc(s.name)}<br><span class="sp-meta">半径${s.radius}m</span></span>
        <a class="btn small" href="${earthUrl(s.lat, s.lng)}" target="_blank" rel="noopener" aria-label="Google Earthで見る">🌍</a>
        ${room.isHost ? `<button type="button" class="btn small" data-del="${esc(s.spotId)}" aria-label="削除">✕</button>` : ''}
      </li>`).join('')
      : `<li class="sp-meta">${room.isHost ? 'まだありません。現在地や地図から追加してください' : 'ホストがスポットを準備中です'}</li>`;
  }

  const playerSig = JSON.stringify([players.map((p) => [p.userId, p.role, p.team, p.isHost]), room.isHost]);
  if (S.sig.waitPlayers !== playerSig) {
    S.sig.waitPlayers = playerSig;
    $('#player-list').innerHTML = players.map((p) => {
      let ctrl = '';
      if (isTagMode(room.mode)) {
        ctrl = room.isHost
          ? `<select data-uid="${esc(p.userId)}" data-field="role">
               <option value="" ${!p.role ? 'selected' : ''}>自動</option>
               <option value="oni" ${p.role === 'oni' ? 'selected' : ''}>鬼</option>
               <option value="runner" ${p.role === 'runner' ? 'selected' : ''}>逃走者</option>
             </select>`
          : `<span class="sp-meta">${p.role ? ROLE_LABEL[p.role] : '役割は自動'}</span>`;
      } else if (room.mode === 'territory') {
        ctrl = room.isHost
          ? `<select data-uid="${esc(p.userId)}" data-field="team">
               <option value="" ${!p.team ? 'selected' : ''}>自動</option>
               <option value="red" ${p.team === 'red' ? 'selected' : ''}>赤</option>
               <option value="blue" ${p.team === 'blue' ? 'selected' : ''}>青</option>
             </select>`
          : `<span class="sp-meta">${p.team ? TEAM_LABEL[p.team] : 'チームは自動'}</span>`;
      }
      return `<li><span class="pl-name">${esc(p.nickname)}${p.isMe ? '（あなた）' : ''}</span>${p.isHost ? '<span class="host-mark">ホスト</span>' : ''}${ctrl}</li>`;
    }).join('');
  }

  renderSettingsSummary(room);

  const startBtn = $('#btn-start');
  startBtn.classList.toggle('hidden', !room.isHost);
  let hint = '';
  if (!room.isHost) hint = 'ホストがゲームを開始するまでお待ちください';
  else if (room.mode !== 'board' && players.length < 2) hint = 'ルームコードを伝えて、2人以上集まったら開始できます';
  else if (room.mode === 'territory' && spots.length < 1) hint = '陣地スポットを1つ以上追加してください';
  else if (room.mode === 'board' && spots.length < 2) hint = 'マスを2つ以上追加してください';
  else hint = '準備ができたら開始してください';
  $('#wait-hint').textContent = hint;
  startBtn.disabled = room.isHost && hint !== '準備ができたら開始してください';

  updateWaitMap(st);
}

function renderSettingsSummary(room) {
  const s = room.settings;
  const items = [['制限時間', `${s.durationMin}分`]];
  if (isTagMode(room.mode)) {
    items.push(['捕獲距離', `${s.catchRadius}m以内`],
      [room.mode === 'kakurenbo' ? '隠れ時間' : '逃げ時間', `${s.hideSeconds}秒`],
      ['位置公開', s.revealInterval > 0 ? `${s.revealInterval}秒ごとに20秒間` : 'なし'],
      ['レーダー範囲', `${s.radarRange}m`],
      ['接近アラート', `${s.alertRadius}m`],
      ['増え鬼', s.infect ? 'あり' : 'なし']);
  } else if (room.mode === 'territory') {
    items.push(['チェックイン半径', `${s.checkinRadius}m（スポットごとに設定可）`], ['奪還までの待ち', `${s.captureCooldownSec}秒`], ['勝敗', '終了時の占領数']);
  } else {
    items.push(['進み方', 'ダイス→マスまで歩く→到着チェックイン→ミッション'], ['勝敗', '最後のマスに最初に到着']);
  }
  items.push(['AI実況', s.aiAnnounce ? 'あり' : 'なし']);
  $('#settings-summary').innerHTML = items.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
}

function ensureWaitMap(center) {
  if (S.waitMap) return;
  S.waitMap = L.map('wait-map', { zoomControl: false }).setView(center, CONFIG.DEFAULT_ZOOM);
  L.tileLayer(CONFIG.MAP_TILE_URL, { attribution: CONFIG.MAP_ATTRIBUTION, maxZoom: 19 }).addTo(S.waitMap);
  S.waitLayer = L.layerGroup().addTo(S.waitMap);
  S.waitMap.on('click', (e) => { if (S.pickMode) addSpotAt(e.latlng.lat, e.latlng.lng); });
}

function updateWaitMap(st) {
  const center = S.pos ? [S.pos.lat, S.pos.lng] : (st.room.center || CONFIG.DEFAULT_CENTER);
  const fresh = !S.waitMap;
  ensureWaitMap(center);
  const sig = JSON.stringify([st.spots, st.players.map((p) => [p.userId, p.lat, p.lng])]);
  if (S.sig.waitMap === sig) return;
  S.sig.waitMap = sig;
  S.waitLayer.clearLayers();
  st.spots.forEach((s) => drawSpot(S.waitLayer, s, st.room));
  st.players.forEach((p) => {
    if (p.isMe || p.lat == null) return;
    L.marker([p.lat, p.lng], { icon: dotIcon(COLOR.neutral, p.nickname) }).addTo(S.waitLayer);
  });
  updateMeMarkers();
  if (fresh) setTimeout(() => S.waitMap.invalidateSize(), 80);
}

const addSpotAt = safe(async (lat, lng) => {
  await api('addSpot', {
    roomId: S.roomId, lat, lng,
    name: $('#spot-name').value.trim(),
    radius: Number($('#spot-radius').value) || undefined
  });
  $('#spot-name').value = '';
  setPickMode(false);
  toast('スポットを追加しました');
  S.sig.waitSpots = null;
  await syncRoom();
});

function setPickMode(on) {
  S.pickMode = on;
  $('#pick-hint').classList.toggle('hidden', !on);
  $('#btn-spot-pick').textContent = on ? '選ぶのをやめる' : '地図で選ぶ';
}

function bindRoom() {
  $('#btn-spot-here').addEventListener('click', () => {
    if (!S.pos) { toast('現在地を取得中です。少し待ってから押してください', true); return; }
    addSpotAt(S.pos.lat, S.pos.lng);
  });
  $('#btn-spot-pick').addEventListener('click', () => setPickMode(!S.pickMode));

  $('#spot-list').addEventListener('click', safe(async (e) => {
    const b = e.target.closest('[data-del]');
    if (!b) return;
    if (!confirm('このスポットを削除しますか？')) return;
    await api('deleteSpot', { roomId: S.roomId, spotId: b.dataset.del });
    await syncRoom();
  }));

  $('#player-list').addEventListener('change', safe(async (e) => {
    const sel = e.target.closest('select[data-uid]');
    if (!sel) return;
    await api('setPlayer', { roomId: S.roomId, targetUserId: sel.dataset.uid, [sel.dataset.field]: sel.value });
    S.sig.waitPlayers = null;
    await syncRoom();
  }));

  $('#btn-start').addEventListener('click', safe(async () => {
    if (!confirm('ゲームを開始しますか？参加者全員の画面が切り替わります')) return;
    await api('startGame', { roomId: S.roomId });
    await syncRoom();
  }));

  $('#btn-leave').addEventListener('click', safe(async () => {
    if (!confirm('ルームから退出しますか？')) return;
    await api('leaveRoom', { roomId: S.roomId });
    gotoLobby();
  }));

  $('#btn-share-code').addEventListener('click', async () => {
    const code = $('#room-code').textContent;
    const text = `まちアリーナで遊ぼう！ルームコード：${code}`;
    try {
      if (navigator.share) await navigator.share({ title: CONFIG.APP_NAME, text, url: location.origin + location.pathname });
      else { await navigator.clipboard.writeText(text); toast('ルームコードをコピーしました'); }
    } catch (e) { /* キャンセル */ }
  });
}

/* ============================================================
 * 地図描画（共通）
 * ============================================================ */
function dotIcon(color, label, cls = '') {
  return L.divIcon({
    className: 'mk ' + cls,
    html: `<span class="mk-dot" style="--c:${color}"></span>${label ? `<span class="mk-label">${esc(label)}</span>` : ''}`,
    iconSize: [90, 36], iconAnchor: [45, 10]
  });
}

function spotColor(s, room, me) {
  if (s.type === 'safe') return COLOR.safe;
  if (s.type === 'territory') return s.ownerTeam ? COLOR[s.ownerTeam] : COLOR.neutral;
  if (me && me.target === s.orderNo) return COLOR.target;
  return COLOR.board;
}

function drawSpot(layer, s, room, me) {
  const color = spotColor(s, room, me);
  L.circle([s.lat, s.lng], { radius: s.radius, color, weight: 2, fillColor: color, fillOpacity: 0.18 }).addTo(layer);
  const label = room.mode === 'board' ? s.orderNo : room.mode === 'territory' ? '⚑' : '✚';
  const owner = s.type === 'territory' ? (s.ownerTeam ? `${TEAM_LABEL[s.ownerTeam]}が占領中` : '未占領') : '';
  L.marker([s.lat, s.lng], {
    icon: L.divIcon({ className: 'mk', html: `<span class="mk-spot" style="--c:${color}">${label}</span>`, iconSize: [30, 30], iconAnchor: [15, 15] })
  }).bindPopup(`<b>${esc(s.name)}</b><br>半径${s.radius}m ${esc(owner)}<br><a href="${earthUrl(s.lat, s.lng)}" target="_blank" rel="noopener">Google Earthで見る</a>`)
    .addTo(layer);
}

function updateMeMarkers() {
  if (!S.pos) return;
  const ll = [S.pos.lat, S.pos.lng];
  if (S.waitMap) {
    if (!S.waitMe) S.waitMe = L.marker(ll, { icon: dotIcon('#fff', 'あなた', 'mk-me'), zIndexOffset: 1000 }).addTo(S.waitMap);
    else S.waitMe.setLatLng(ll);
  }
  if (S.map) {
    if (!S.meMarker) {
      S.accCircle = L.circle(ll, { radius: S.pos.acc, color: '#4be3d0', weight: 1, fillOpacity: 0.08 }).addTo(S.map);
      S.meMarker = L.marker(ll, { icon: dotIcon('#fff', 'あなた', 'mk-me'), zIndexOffset: 1000 }).addTo(S.map);
    } else {
      S.meMarker.setLatLng(ll);
      S.accCircle.setLatLng(ll).setRadius(S.pos.acc);
    }
  }
}

/* ============================================================
 * ゲーム画面
 * ============================================================ */
function initGameMap() {
  if (S.map) { setTimeout(() => S.map.invalidateSize(), 60); return; }
  const center = S.pos ? [S.pos.lat, S.pos.lng] : (S.state?.room.center || CONFIG.DEFAULT_CENTER);
  S.map = L.map('game-map', { zoomControl: false }).setView(center, CONFIG.DEFAULT_ZOOM);
  L.tileLayer(CONFIG.MAP_TILE_URL, { attribution: CONFIG.MAP_ATTRIBUTION, maxZoom: 19 }).addTo(S.map);
  S.spotLayer = L.layerGroup().addTo(S.map);
  S.playerMarkers = new Map();
  updateMeMarkers();
}

function playerColor(p, mode) {
  if (p.status === 'caught') return COLOR.caught;
  if (isTagMode(mode)) return COLOR[p.role] || COLOR.neutral;
  if (mode === 'territory') return COLOR[p.team] || COLOR.neutral;
  return COLOR.board;
}

function renderGame(st) {
  const { room, me, players, spots } = st;
  // HUD
  const badge = $('#hud-role');
  if (me) {
    let label = '', cls = '';
    if (isTagMode(room.mode)) { label = me.status === 'caught' ? '確保済み' : ROLE_LABEL[me.role]; cls = me.status === 'caught' ? 'caught' : me.role; }
    else if (room.mode === 'territory') { label = TEAM_LABEL[me.team]; cls = me.team; }
    else { label = `${me.position}/${spots.length}マス`; }
    badge.textContent = label;
    badge.className = 'role-badge ' + cls;
  }
  let score = '';
  if (isTagMode(room.mode)) {
    const left = players.filter((p) => p.role === 'runner' && p.status === 'active').length;
    score = me?.role === 'oni' ? `確保 ${me.score}人／残り${left}人` : `逃走者 残り${left}人`;
  } else if (room.mode === 'territory') {
    const c = { red: 0, blue: 0 };
    spots.forEach((s) => { if (c[s.ownerTeam] != null) c[s.ownerTeam]++; });
    score = `赤 ${c.red} : 青 ${c.blue}`;
  } else {
    score = `クリア ${me?.score ?? 0}`;
  }
  $('#hud-score').textContent = score;

  // ミッション
  const mission = room.mode === 'board' && me?.mission;
  $('#mission-card').classList.toggle('hidden', !mission);
  if (mission) $('#mission-text').textContent = me.mission;

  $('#btn-end').classList.toggle('hidden', !room.isHost);

  renderActions(st);
  renderGameMap(st);
  checkProximity(st);
}

function renderGameMap(st) {
  if (!S.map) return;
  const { room, me, players, spots } = st;
  const spotSig = JSON.stringify([spots, me?.target]);
  if (S.sig.gameSpots !== spotSig) {
    S.sig.gameSpots = spotSig;
    S.spotLayer.clearLayers();
    spots.forEach((s) => drawSpot(S.spotLayer, s, room, me));
  }
  const seen = new Set();
  players.forEach((p) => {
    if (p.isMe || p.lat == null) return;
    seen.add(p.userId);
    const icon = dotIcon(playerColor(p, room.mode), p.nickname + (p.stale ? '（圏外）' : ''));
    const m = S.playerMarkers.get(p.userId);
    if (m) { m.setLatLng([p.lat, p.lng]); m.setIcon(icon); }
    else S.playerMarkers.set(p.userId, L.marker([p.lat, p.lng], { icon }).addTo(S.map));
  });
  for (const [uid, m] of S.playerMarkers) {
    if (!seen.has(uid)) { S.map.removeLayer(m); S.playerMarkers.delete(uid); }
  }
}

function renderActions(st) {
  const { room, me } = st;
  if (!me) return;
  let html = '';
  if (isTagMode(room.mode)) {
    if (me.status === 'caught') html = '<div class="status-line">確保されました。観戦中です</div>';
    else if (me.role === 'oni') html = '<button type="button" class="btn oni" data-act="catch">確保する</button>';
    else html = '<div id="runner-status" class="status-line">逃げ切れ！</div>';
  } else if (room.mode === 'territory') {
    html = '<button type="button" class="btn primary" data-act="checkin" id="btn-checkin">陣地にチェックイン</button>';
  } else if (me.target == null) {
    html = '<button type="button" class="btn primary" data-act="dice">🎲 ダイスを振る</button>';
  } else if (!me.mission) {
    html = '<button type="button" class="btn primary" data-act="checkin" id="btn-checkin">到着をチェックイン</button>';
  } else {
    html = '<button type="button" class="btn primary" data-act="complete">ミッション完了</button>';
  }
  if (S.sig.actions !== html) { S.sig.actions = html; $('#actions').innerHTML = html; }
}

/** 0.5秒ごと：タイマー・フェーズ表示・ローカル判定 */
function tick() {
  const st = S.state;
  if (!st || st.room.status !== 'playing') return;
  const { room, me, spots, players } = st;
  const now = Date.now() + S.serverOffset;
  const remain = Math.max(0, Math.floor((room.endsAt - now) / 1000));
  const timer = $('#hud-timer');
  timer.textContent = `${String(Math.floor(remain / 60)).padStart(2, '0')}:${String(remain % 60).padStart(2, '0')}`;
  timer.classList.toggle('urgent', remain <= 60);

  [[300, '残り5分'], [60, '残り1分'], [30, '残り30秒'], [10, '10秒前']].forEach(([sec, text]) => {
    if (remain <= sec && remain > sec - 3 && !S.marks.has(sec)) { S.marks.add(sec); speak(text, { ai: false }); }
  });
  if (remain === 0 && !S.marks.has('end')) { S.marks.add('end'); syncRoom(); }

  // フェーズ表示
  let sub = '';
  if (isTagMode(room.mode)) {
    const hideLeft = Math.ceil((room.startedAt + room.settings.hideSeconds * 1000 - now) / 1000);
    if (hideLeft > 0) sub = `${room.mode === 'kakurenbo' ? '隠れ時間' : '逃げ時間'}：あと${hideLeft}秒（鬼は確保できません）`;
    else {
      if (!S.marks.has('hideEnd')) { S.marks.add('hideEnd'); speak('鬼が動き出した！', { ai: false }); vibrate([300, 100, 300]); }
      if (room.reveal) sub = '位置公開中！全員の位置が地図に出ています';
      else if (room.nextRevealIn != null) sub = `次の位置公開まで約${room.nextRevealIn}秒`;
    }
  }
  $('#hud-sub').textContent = sub;

  // 逃走者のステータス
  const rs = $('#runner-status');
  if (rs && S.pos) {
    const inSafe = spots.some((s) => s.type === 'safe' && distM(S.pos.lat, S.pos.lng, s.lat, s.lng) <= s.radius);
    const onis = players.filter((p) => p.role === 'oni' && p.distance != null);
    const nearest = onis.length ? Math.min(...onis.map((p) => p.distance)) : null;
    if (inSafe) { rs.className = 'status-line safe'; rs.textContent = 'セーフティゾーン内（捕まりません）'; }
    else if (nearest != null && nearest <= room.settings.alertRadius) { rs.className = 'status-line danger'; rs.textContent = `鬼が接近中！約${nearest}m`; }
    else { rs.className = 'status-line'; rs.textContent = nearest != null ? `一番近い鬼まで約${nearest}m` : '近くに鬼の反応なし'; }
  }

  // チェックインボタンのラベル
  const cb = $('#btn-checkin');
  if (cb && S.pos) {
    const spot = pickCheckinSpot(st);
    if (spot) {
      const d = Math.round(distM(S.pos.lat, S.pos.lng, spot.lat, spot.lng));
      const inRange = d <= spot.radius + Math.min(S.pos.acc, 20);
      cb.textContent = `${room.mode === 'board' ? '到着' : 'チェックイン'}：${spot.name}（${inRange ? '範囲内' : 'あと' + Math.max(0, d - spot.radius) + 'm'}）`;
      cb.classList.toggle('primary', inRange);
    }
  }
}

function pickCheckinSpot(st) {
  const { room, me, spots } = st;
  if (!S.pos) return null;
  if (room.mode === 'board') return spots.find((s) => s.orderNo === me.target) || null;
  const cand = spots.filter((s) => s.type === 'territory')
    .map((s) => ({ s, d: distM(S.pos.lat, S.pos.lng, s.lat, s.lng) }))
    .sort((a, b) => (a.s.ownerTeam === me.team) - (b.s.ownerTeam === me.team) || a.d - b.d);
  const inRange = cand.find((c) => c.d <= c.s.radius + Math.min(S.pos.acc, 20) && c.s.ownerTeam !== me.team);
  return (inRange || cand.sort((a, b) => a.d - b.d)[0] || {}).s || null;
}

function checkProximity(st) {
  const { room, me, players } = st;
  if (!isTagMode(room.mode) || !me || me.role !== 'runner' || me.status !== 'active') return;
  const near = players.filter((p) => p.role === 'oni' && p.distance != null && p.distance <= room.settings.alertRadius);
  if (!near.length) return;
  const now = Date.now();
  if (now - S.lastAlertAt < 20000) return;
  S.lastAlertAt = now;
  const d = Math.min(...near.map((p) => p.distance));
  vibrate([200, 100, 200, 100, 200]);
  speak(`警告。鬼が接近中。およそ${d}メートル`, { ai: false });
}

/* ---------- アクション ---------- */
const doCatch = safe(async () => {
  vibrate(60);
  const r = await api('tryCatch', { roomId: S.roomId });
  if (r.caught) { playCinema('catch', r.message); vibrate([100, 50, 300]); }
  else toast(r.message);
  await syncRoom();
});

const doCheckin = safe(async () => {
  const spot = pickCheckinSpot(S.state);
  if (!spot) throw new Error('チェックインできるスポットがありません');
  if (!S.pos) throw new Error('現在地を取得中です');
  const r = await api('checkin', { roomId: S.roomId, spotId: spot.spotId });
  if (r.captured) playCinema('capture', r.message);
  else toast(r.message);
  await syncRoom();
});

const doDice = safe(async () => {
  const r = await api('rollDice', { roomId: S.roomId });
  toast(`🎲 ${r.dice}！ ${r.message}`);
  vibrate(120);
  if (S.map && r.spot) S.map.flyTo([r.spot.lat, r.spot.lng], CONFIG.DEFAULT_ZOOM);
  await syncRoom();
});

const doComplete = safe(async () => {
  if (!confirm('ミッションを達成しましたか？（自己申告です）')) return;
  const r = await api('completeMission', { roomId: S.roomId });
  toast(r.message);
  await syncRoom();
});

const doGmOrder = safe(async () => {
  const r = await api('gmOrder', { roomId: S.roomId });
  toast('📡 ' + r.order);
  speak(r.order);
  await syncRoom();
});

function bindGame() {
  $('#actions').addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    ({ catch: doCatch, checkin: doCheckin, dice: doDice, complete: doComplete })[b.dataset.act]?.();
  });
  $('#btn-view-toggle').addEventListener('click', () => setView(S.view === 'map' ? 'radar' : 'map'));
  $('#btn-center').addEventListener('click', () => {
    setView('map');
    if (S.map && S.pos) S.map.flyTo([S.pos.lat, S.pos.lng], CONFIG.DEFAULT_ZOOM);
  });
  $('#btn-gm').addEventListener('click', doGmOrder);
  $('#btn-sound').addEventListener('click', () => {
    S.soundOn = !S.soundOn;
    localStorage.setItem('machiArena.sound', S.soundOn ? 'on' : 'off');
    if (!S.soundOn) { S.ttsQueue = []; if ('speechSynthesis' in window) speechSynthesis.cancel(); }
    updateSoundButton();
    toast(S.soundOn ? '音声をオンにしました' : '音声をオフにしました');
  });
  $('#btn-feed').addEventListener('click', () => {
    $('#feed').classList.toggle('hidden');
    S.unread = 0;
    updateFeedBadge();
  });
  $('#btn-feed-close').addEventListener('click', () => $('#feed').classList.add('hidden'));
  $('#btn-end').addEventListener('click', safe(async () => {
    if (!confirm('ゲームを終了して結果を確定しますか？')) return;
    await api('endGame', { roomId: S.roomId });
    await syncRoom();
  }));
  $('#btn-back-lobby').addEventListener('click', () => gotoLobby());
  $('#btn-cinema-close').addEventListener('click', closeCinema);
}

function updateSoundButton() {
  const b = $('#btn-sound');
  b.textContent = S.soundOn ? '🔊' : '🔇';
  b.classList.toggle('on', S.soundOn);
}

function vibrate(p) { try { navigator.vibrate && navigator.vibrate(p); } catch (e) { /* noop */ } }

/* ---------- 実況ログ ---------- */
function addFeed(ev) {
  const li = document.createElement('li');
  li.className = ev.type;
  const t = new Date(ev.createdAt);
  li.innerHTML = `<time>${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}</time>${esc(ev.message)}`;
  $('#feed-list').prepend(li);
  while ($('#feed-list').children.length > 80) $('#feed-list').lastChild.remove();
  if (!S.firstSync && $('#feed').classList.contains('hidden')) { S.unread++; updateFeedBadge(); }
}
function updateFeedBadge() {
  const b = $('#feed-badge');
  b.textContent = S.unread > 9 ? '9+' : S.unread;
  b.classList.toggle('hidden', S.unread === 0);
}

/* ============================================================
 * レーダー
 * ============================================================ */
function setView(v) {
  S.view = v;
  $('#radar-wrap').classList.toggle('hidden', v !== 'radar');
  $('#btn-view-toggle').textContent = v === 'radar' ? '🗺' : '📡';
  $('#btn-view-toggle').setAttribute('aria-label', v === 'radar' ? '地図表示' : 'レーダー表示');
  if (v === 'radar' && !S.radarRAF) S.radarRAF = requestAnimationFrame(drawRadar);
  if (v === 'map' && S.map) setTimeout(() => S.map.invalidateSize(), 30);
}

function radarTargets() {
  const st = S.state;
  if (!st) return { blips: [], bands: [], spots: [] };
  const blips = [], bands = [], spots = [];
  st.players.forEach((p) => {
    if (p.isMe) return;
    let d = p.distance, b = p.bearing;
    if ((d == null || b == null) && p.lat != null && S.pos) {
      d = distM(S.pos.lat, S.pos.lng, p.lat, p.lng);
      b = bearingDeg(S.pos.lat, S.pos.lng, p.lat, p.lng);
    }
    if (d != null && b != null) blips.push({ d, b, color: playerColor(p, st.room.mode), label: p.nickname });
    else if (p.heat) bands.push({ heat: p.heat, color: COLOR.oni });
  });
  if (S.pos) {
    st.spots.forEach((s) => {
      spots.push({ d: distM(S.pos.lat, S.pos.lng, s.lat, s.lng), b: bearingDeg(S.pos.lat, S.pos.lng, s.lat, s.lng), color: spotColor(s, st.room, st.me) });
    });
  }
  return { blips, bands, spots };
}

function drawRadar(t) {
  if (S.view !== 'radar' || S.screen !== 'game') { S.radarRAF = null; return; }
  const canvas = $('#radar');
  const size = canvas.clientWidth;
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(size * dpr)) { canvas.width = canvas.height = Math.round(size * dpr); }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const cx = size / 2, cy = size / 2, R = size / 2 - 8;
  const range = S.state?.room.settings.radarRange || 300;
  const sweep = ((t / 1000) * 1.3) % (Math.PI * 2);
  const toXY = (d, bDeg) => {
    const r = Math.min(d / range, 1) * R, a = bDeg * Math.PI / 180;
    return [cx + r * Math.sin(a), cy - r * Math.cos(a)];
  };

  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = 'rgba(8, 26, 52, .95)';
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fill();

  // 熱感知バンド（かくれんぼの鬼用）
  const { blips, bands, spots } = radarTargets();
  bands.forEach((bd) => {
    const [r0, r1] = bd.heat === 'hot' ? [0, 1 / 3] : bd.heat === 'warm' ? [1 / 3, 2 / 3] : [2 / 3, 1];
    ctx.fillStyle = `rgba(255, 176, 32, ${0.12 + 0.08 * Math.sin(t / 300)})`;
    ctx.beginPath(); ctx.arc(cx, cy, R * r1, 0, Math.PI * 2); ctx.arc(cx, cy, R * r0, 0, Math.PI * 2, true); ctx.fill();
  });

  // 目盛り
  ctx.strokeStyle = 'rgba(75, 227, 208, .35)';
  ctx.lineWidth = 1;
  ctx.fillStyle = 'rgba(142, 163, 200, .9)';
  ctx.font = '11px sans-serif';
  for (let i = 1; i <= 3; i++) {
    ctx.beginPath(); ctx.arc(cx, cy, (R * i) / 3, 0, Math.PI * 2); ctx.stroke();
    ctx.fillText(`${Math.round((range * i) / 3)}m`, cx + 4, cy - (R * i) / 3 + 12);
  }
  ctx.beginPath(); ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy); ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R); ctx.stroke();
  ctx.fillStyle = '#4be3d0';
  ctx.font = 'bold 14px sans-serif';
  ctx.fillText('N', cx - 5, cy - R + 16);

  // スイープ
  const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
  grad.addColorStop(0, 'rgba(75, 227, 208, .35)');
  grad.addColorStop(1, 'rgba(75, 227, 208, .05)');
  ctx.fillStyle = grad;
  ctx.beginPath(); ctx.moveTo(cx, cy);
  ctx.arc(cx, cy, R, sweep - Math.PI / 2 - 0.5, sweep - Math.PI / 2);
  ctx.closePath(); ctx.fill();

  // スポット
  spots.forEach((s) => {
    if (s.d > range) return;
    const [x, y] = toXY(s.d, s.b);
    ctx.fillStyle = s.color;
    ctx.fillRect(x - 5, y - 5, 10, 10);
  });

  // プレイヤー
  blips.forEach((b) => {
    const [x, y] = toXY(b.d, b.b);
    const a = b.b * Math.PI / 180;
    const since = ((sweep - a) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
    const alpha = 0.35 + 0.65 * (1 - since / (Math.PI * 2));
    ctx.globalAlpha = alpha;
    ctx.fillStyle = b.color;
    ctx.beginPath(); ctx.arc(x, y, b.d > range ? 4 : 7, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#e8f0ff';
    ctx.font = '12px sans-serif';
    ctx.fillText(`${b.label} ${Math.round(b.d)}m`, x + 9, y + 4);
    ctx.globalAlpha = 1;
  });

  // 自分
  ctx.fillStyle = '#ffffff';
  ctx.beginPath(); ctx.arc(cx, cy, 5, 0, Math.PI * 2); ctx.fill();

  const cap = bands.length ? '鬼のレーダーは距離帯だけ。光っている輪に逃走者がいます'
    : `北が上。範囲${range}m。範囲外の相手は外周に表示されます`;
  if ($('#radar-caption').textContent !== cap) $('#radar-caption').textContent = cap;
  S.radarRAF = requestAnimationFrame(drawRadar);
}

/* ============================================================
 * 結果
 * ============================================================ */
function renderResult(st) {
  const { room, me } = st;
  const res = room.result || {};
  let title = 'ゲーム終了';
  if (me && res.winner) {
    let win = null;
    if (isTagMode(room.mode)) win = res.winner === me.role;
    else if (room.mode === 'territory') win = res.winner === 'draw' ? null : res.winner === me.team;
    else win = res.winner === S.user.userId;
    title = win === null ? '引き分け' : win ? '勝利！' : '敗北';
  }
  $('#result-mode').textContent = room.modeLabel;
  $('#result-title').textContent = title;
  $('#result-text').textContent = res.text || '';
  $('#result-ranking').innerHTML = (res.ranking || []).map((p) => {
    const tag = isTagMode(room.mode) ? `${ROLE_LABEL[p.role] || ''}${p.status === 'caught' ? '・確保' : ''}`
      : room.mode === 'territory' ? (TEAM_LABEL[p.team] || '') : `${p.position}マス`;
    return `<li>${esc(p.nickname)}（${esc(tag)}） スコア ${p.score}</li>`;
  }).join('');
}

/* ============================================================
 * 音声（Gemini TTS / 端末読み上げ）
 * ============================================================ */
function unlockAudioOnFirstTap() {
  const unlock = () => {
    try {
      S.audioCtx = S.audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      S.audioCtx.resume();
      if ('speechSynthesis' in window) speechSynthesis.speak(new SpeechSynthesisUtterance(''));
    } catch (e) { /* noop */ }
  };
  document.addEventListener('pointerdown', unlock, { once: true });
}

function speak(text, { ai = true } = {}) {
  if (!text || CONFIG.TTS_ENGINE === 'off' || !S.soundOn) return;
  S.ttsQueue.push({ text, ai });
  if (S.ttsQueue.length > 4) S.ttsQueue.shift();
  if (!S.speaking) drainTts();
}

async function drainTts() {
  S.speaking = true;
  while (S.ttsQueue.length) {
    const { text, ai } = S.ttsQueue.shift();
    try {
      if (ai && CONFIG.TTS_ENGINE === 'gemini') {
        const r = await api('tts', { text });
        await playAudio(r.audio, r.mimeType);
      } else {
        await browserSpeak(text);
      }
    } catch (e) {
      dbg('tts fallback', e);
      await browserSpeak(text);
    }
  }
  S.speaking = false;
}

function playAudio(b64, mime = '') {
  if (!/L16|pcm/i.test(mime)) {
    return new Promise((resolve) => {
      const a = new Audio(`data:${mime};base64,${b64}`);
      a.onended = resolve; a.onerror = resolve;
      a.play().catch(resolve);
    });
  }
  S.audioCtx = S.audioCtx || new (window.AudioContext || window.webkitAudioContext)();
  const rate = Number((/rate=(\d+)/.exec(mime) || [])[1] || 24000);
  const bin = atob(b64);
  const len = Math.floor(bin.length / 2);
  const buf = S.audioCtx.createBuffer(1, len, rate);
  const ch = buf.getChannelData(0);
  for (let i = 0; i < len; i++) {
    let v = bin.charCodeAt(i * 2) | (bin.charCodeAt(i * 2 + 1) << 8);
    if (v >= 32768) v -= 65536;
    ch[i] = v / 32768;
  }
  return new Promise((resolve) => {
    const src = S.audioCtx.createBufferSource();
    src.buffer = buf;
    src.connect(S.audioCtx.destination);
    src.onended = resolve;
    src.start();
  });
}

function browserSpeak(text) {
  return new Promise((resolve) => {
    if (!('speechSynthesis' in window)) { resolve(); return; }
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'ja-JP';
    u.rate = 1.1;
    u.onend = resolve; u.onerror = resolve;
    speechSynthesis.speak(u);
    setTimeout(resolve, Math.min(20000, 600 + text.length * 180));
  });
}

/* ============================================================
 * 演出（Google Earth Studio 素材 via Drive）
 * ============================================================ */
async function loadMedia() {
  if (S.media) return;
  try { S.media = (await api('getMedia')).media || {}; }
  catch (e) { S.media = {}; dbg('media', e); }
}

function playCinema(key, caption) {
  const box = $('#cinema');
  const holder = $('#cinema-media');
  holder.innerHTML = '';
  holder.className = 'cinema-media';
  $('#cinema-caption').textContent = caption || '';
  clearTimeout(S.cinemaTimer);
  const m = S.media && S.media[key];
  let duration = 5000;
  if (m && m.type === 'image') {
    const img = new Image();
    img.src = m.url;
    img.alt = '';
    img.onerror = () => holder.classList.add('placeholder');
    holder.appendChild(img);
  } else if (m) {
    duration = 12000;
    const v = document.createElement('video');
    Object.assign(v, { src: m.url, autoplay: true, muted: true, playsInline: true });
    v.setAttribute('playsinline', '');
    v.onended = closeCinema;
    v.onerror = () => {
      if (m.preview) holder.innerHTML = `<iframe src="${esc(m.preview)}" allow="autoplay" title="演出映像"></iframe>`;
      else holder.classList.add('placeholder');
    };
    holder.appendChild(v);
    v.play().catch(() => { /* onerror 側で処理 */ });
  } else {
    holder.classList.add('placeholder');
  }
  box.classList.remove('hidden');
  S.cinemaTimer = setTimeout(closeCinema, duration);
}

function closeCinema() {
  clearTimeout(S.cinemaTimer);
  $('#cinema').classList.add('hidden');
  $('#cinema-media').innerHTML = '';
}

/* ============================================================
 * 画面スリープ防止
 * ============================================================ */
async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator && !S.wakeLock) {
      S.wakeLock = await navigator.wakeLock.request('screen');
      S.wakeLock.addEventListener('release', () => { S.wakeLock = null; });
    }
  } catch (e) { dbg('wakeLock', e); }
}
function releaseWakeLock() {
  if (S.wakeLock) { S.wakeLock.release().catch(() => {}); S.wakeLock = null; }
}
