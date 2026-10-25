/**
 * まちアリーナ～リアルに遊ぶ (MACHI ARENA) — GAS バックエンド
 * スプレッドシートにバインドしたスクリプトとして使用します。
 *
 * スクリプトプロパティ（プロジェクトの設定 → スクリプト プロパティ）
 *   GEMINI_API_KEY     : Gemini API キー（必須：AI実況・指令・TTS）
 *   GEMINI_TEXT_MODEL  : 省略時 gemini-2.5-flash
 *   GEMINI_TTS_MODEL   : 省略時 gemini-2.5-flash-preview-tts
 *   GEMINI_TTS_VOICE   : 省略時 Kore
 *   SPREADSHEET_ID     : 省略時はバインド先スプレッドシート
 *
 * 初回は setup() を一度実行してシートを作成してください。
 */

const APP = {
  NAME: 'まちアリーナ～リアルに遊ぶ',
  VERSION: 'v1.0.3',
  SESSION_DAYS: 14,
  MAX_FAIL: 5,
  LOCK_MIN: 15,
  FRESH_SEC: 30,          // 位置情報の有効期限（秒）
  REVEAL_WINDOW_SEC: 20,  // 位置公開タイムの長さ（秒）
  HASH_ROUNDS: 300,
  AI_PER_MIN: 8           // 1ユーザーあたりの AI 呼び出し上限/分
};

const MODES = ['onigokko', 'kakurenbo', 'territory', 'board'];
const MODE_LABEL = { onigokko: 'リアル鬼ごっこ', kakurenbo: 'リアルかくれんぼ', territory: 'リアル陣取り合戦', board: 'リアルすごろく' };
const TEAM_LABEL = { red: '赤チーム', blue: '青チーム' };

const SHEETS = {
  Users:    ['userId', 'email', 'nickname', 'passwordHash', 'salt', 'isFirstLogin', 'failCount', 'lockedUntil', 'createdAt', 'updatedAt'],
  Sessions: ['token', 'userId', 'expiresAt', 'createdAt'],
  Rooms:    ['roomId', 'code', 'name', 'mode', 'hostId', 'status', 'settingsJson', 'centerLat', 'centerLng', 'startedAt', 'endsAt', 'resultJson', 'createdAt'],
  Players:  ['roomId', 'userId', 'nickname', 'role', 'team', 'lat', 'lng', 'accuracy', 'locUpdatedAt', 'status', 'score', 'position', 'target', 'mission', 'joinedAt'],
  Spots:    ['spotId', 'roomId', 'name', 'lat', 'lng', 'radius', 'type', 'orderNo', 'ownerTeam', 'ownerUserId', 'capturedAt', 'createdAt'],
  Events:   ['eventId', 'roomId', 'type', 'message', 'userId', 'visibility', 'createdAt'],
  Media:    ['key', 'driveFileId', 'directUrl', 'mediaType', 'note']
};

// 文字列として扱いたい列（数値・指数表記への自動変換を防ぐ）
const TEXT_COLUMNS = {
  Users: ['userId', 'email', 'passwordHash', 'salt'],
  Sessions: ['token', 'userId'],
  Rooms: ['roomId', 'code', 'hostId'],
  Players: ['roomId', 'userId'],
  Spots: ['spotId', 'roomId', 'ownerUserId'],
  Events: ['eventId', 'roomId', 'userId'],
  Media: ['key', 'driveFileId']
};

const DEFAULT_SETTINGS = {
  durationMin: 30,
  catchRadius: 15,
  hideSeconds: 60,
  revealInterval: 180,
  radarRange: 300,
  alertRadius: 60,
  infect: false,
  oniCount: 0,
  checkinRadius: 30,
  captureCooldownSec: 60,
  maxAccuracy: 50,
  aiAnnounce: true
};

/* ============================================================
 * 初期セットアップ / メンテナンス
 * ============================================================ */
function setup() {
  const ss = ss_();
  Object.keys(SHEETS).forEach(name => {
    let sh = ss.getSheetByName(name);
    if (!sh) sh = ss.insertSheet(name);
    const h = SHEETS[name];
    sh.getRange(1, 1, 1, h.length).setValues([h]).setFontWeight('bold').setBackground('#1d2b4a').setFontColor('#ffffff');
    sh.setFrozenRows(1);
    (TEXT_COLUMNS[name] || []).forEach(col => {
      const idx = h.indexOf(col) + 1;
      if (idx > 0) sh.getRange(2, idx, sh.getMaxRows() - 1, 1).setNumberFormat('@');
    });
  });
  const media = ss.getSheetByName('Media');
  if (media.getLastRow() < 2) {
    media.getRange(2, 1, 5, 5).setValues([
      ['start', '', '', 'video', 'ゲーム開始演出（街の俯瞰ズームイン）'],
      ['capture', '', '', 'video', '陣地占領演出'],
      ['catch', '', '', 'video', '捕獲演出'],
      ['win', '', '', 'video', '勝利・終了演出'],
      ['board', '', '', 'image', 'すごろく背景']
    ]);
  }
  const def = ss.getSheetByName('シート1') || ss.getSheetByName('Sheet1');
  if (def && ss.getSheets().length > 1) ss.deleteSheet(def);
  Logger.log('セットアップ完了');
}

/** 時間主導トリガー（1日1回推奨）：古いデータを掃除 */
function cleanup() {
  const now = Date.now();
  const weekAgo = now - 7 * 86400000;
  withLock_(() => {
    deleteWhere_('Sessions', r => Number(r.expiresAt) < now);
    const oldRooms = rows_('Rooms').filter(r => Number(r.createdAt) < weekAgo).map(r => String(r.roomId));
    deleteWhere_('Events', r => Number(r.createdAt) < weekAgo || oldRooms.indexOf(String(r.roomId)) >= 0);
    deleteWhere_('Players', r => oldRooms.indexOf(String(r.roomId)) >= 0);
    deleteWhere_('Spots', r => oldRooms.indexOf(String(r.roomId)) >= 0);
    deleteWhere_('Rooms', r => oldRooms.indexOf(String(r.roomId)) >= 0);
  });
}

/* ============================================================
 * エントリーポイント
 * ============================================================ */
function doGet() {
  return json_({ ok: true, app: APP.NAME, version: APP.VERSION, time: Date.now() });
}

const PUBLIC_ACTIONS = {
  ping: () => ({ version: APP.VERSION, time: Date.now() }),
  register: register_,
  login: login_,
  forgotPassword: forgotPassword_
};

const PRIVATE_ACTIONS = {
  me: (req, user) => ({ user: publicUser_(user) }),
  logout: logout_,
  changePassword: changePassword_,
  listRooms: listRooms_,
  createRoom: createRoom_,
  joinRoom: joinRoom_,
  leaveRoom: leaveRoom_,
  setPlayer: setPlayer_,
  addSpot: addSpot_,
  deleteSpot: deleteSpot_,
  startGame: startGame_,
  endGame: endGame_,
  syncRoom: syncRoom_,
  tryCatch: tryCatch_,
  checkin: checkin_,
  rollDice: rollDice_,
  completeMission: completeMission_,
  gmOrder: gmOrder_,
  tts: tts_,
  getMedia: getMedia_
};

const ALLOWED_WHEN_FIRST_LOGIN = ['me', 'logout', 'changePassword'];

function doPost(e) {
  let req = {};
  try {
    req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json_({ ok: false, error: 'BAD_JSON', message: 'リクエストの形式が正しくありません' });
  }
  try {
    const action = String(req.action || '');
    if (PUBLIC_ACTIONS[action]) return json_(Object.assign({ ok: true }, PUBLIC_ACTIONS[action](req)));
    const fn = PRIVATE_ACTIONS[action];
    if (!fn) throw err_('UNKNOWN_ACTION', '不明な操作です: ' + action);
    const user = auth_(req.token);
    if (bool_(user.isFirstLogin) && ALLOWED_WHEN_FIRST_LOGIN.indexOf(action) < 0) {
      throw err_('MUST_CHANGE_PASSWORD', '本パスワードを設定してください');
    }
    return json_(Object.assign({ ok: true }, fn(req, user)));
  } catch (err) {
    console.error(err && err.stack ? err.stack : err);
    return json_({ ok: false, error: err.code || 'SERVER_ERROR', message: err.message || String(err) });
  }
}

/* ============================================================
 * 認証
 * ============================================================ */
function register_(req) {
  const email = normEmail_(req.email);
  const nickname = String(req.nickname || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw err_('INVALID_EMAIL', 'メールアドレスの形式が正しくありません');
  if (nickname.length < 1 || nickname.length > 20) throw err_('INVALID_NICKNAME', 'ニックネームは1〜20文字で入力してください');
  return withLock_(() => {
    if (rows_('Users').some(u => String(u.email) === email)) throw err_('EMAIL_EXISTS', 'このメールアドレスは登録済みです。パスワードを忘れた場合は再発行してください');
    const tempPassword = randomStr_(10);
    const salt = 's' + randomStr_(16);
    const now = Date.now();
    insert_('Users', {
      userId: 'u_' + Utilities.getUuid(), email, nickname,
      passwordHash: hash_(tempPassword, salt), salt,
      isFirstLogin: true, failCount: 0, lockedUntil: 0, createdAt: now, updatedAt: now
    });
    let mailed = false;
    try {
      MailApp.sendEmail({
        to: email,
        subject: '【' + APP.NAME + '】仮パスワードのお知らせ',
        body: nickname + ' さん\n\n' + APP.NAME + ' への登録ありがとうございます。\n\n仮パスワード: ' + tempPassword +
          '\n\n初回ログイン後に本パスワードへ変更してください。\n'
      });
      mailed = true;
    } catch (e) { console.warn('mail failed', e); }
    return { tempPassword, mailed, message: '登録しました。仮パスワードでログインしてください' };
  });
}

function login_(req) {
  const email = normEmail_(req.email);
  const password = String(req.password || '');
  return withLock_(() => {
    const user = rows_('Users').find(u => String(u.email) === email);
    if (!user) throw err_('LOGIN_FAILED', 'メールアドレスまたはパスワードが違います');
    const now = Date.now();
    if (Number(user.lockedUntil) > now) {
      const min = Math.ceil((Number(user.lockedUntil) - now) / 60000);
      throw err_('LOCKED', 'ログインに' + APP.MAX_FAIL + '回失敗したためロック中です。約' + min + '分後に再試行してください');
    }
    if (hash_(password, String(user.salt)) !== String(user.passwordHash)) {
      const fail = Number(user.failCount || 0) + 1;
      if (fail >= APP.MAX_FAIL) {
        update_('Users', user, { failCount: 0, lockedUntil: now + APP.LOCK_MIN * 60000, updatedAt: now });
        throw err_('LOCKED', 'ログインに' + APP.MAX_FAIL + '回失敗したため' + APP.LOCK_MIN + '分間ロックしました');
      }
      update_('Users', user, { failCount: fail, updatedAt: now });
      throw err_('LOGIN_FAILED', 'メールアドレスまたはパスワードが違います（残り' + (APP.MAX_FAIL - fail) + '回）');
    }
    update_('Users', user, { failCount: 0, lockedUntil: 0, updatedAt: now });
    const token = 't_' + Utilities.getUuid() + '_' + randomStr_(12);
    insert_('Sessions', { token, userId: user.userId, expiresAt: now + APP.SESSION_DAYS * 86400000, createdAt: now });
    return { token, user: publicUser_(user) };
  });
}

function forgotPassword_(req) {
  const email = normEmail_(req.email);
  const msg = '登録済みのメールアドレスであれば、新しい仮パスワードを送信しました';
  withLock_(() => {
    const user = rows_('Users').find(u => String(u.email) === email);
    if (!user) return;
    const tempPassword = randomStr_(10);
    const salt = 's' + randomStr_(16);
    update_('Users', user, {
      passwordHash: hash_(tempPassword, salt), salt, isFirstLogin: true,
      failCount: 0, lockedUntil: 0, updatedAt: Date.now()
    });
    deleteWhere_('Sessions', s => String(s.userId) === String(user.userId));
    MailApp.sendEmail({
      to: email,
      subject: '【' + APP.NAME + '】仮パスワード再発行',
      body: user.nickname + ' さん\n\n新しい仮パスワード: ' + tempPassword +
        '\n\nログイン後に本パスワードへの変更が必要です。\n心当たりがない場合はこのメールを破棄してください。\n'
    });
  });
  return { message: msg };
}

function changePassword_(req, user) {
  const current = String(req.currentPassword || '');
  const next = String(req.newPassword || '');
  if (hash_(current, String(user.salt)) !== String(user.passwordHash)) throw err_('WRONG_PASSWORD', '現在のパスワードが違います');
  if (next.length < 8 || !/[A-Za-z]/.test(next) || !/[0-9]/.test(next)) throw err_('WEAK_PASSWORD', 'パスワードは英字と数字を含む8文字以上にしてください');
  if (next === current) throw err_('SAME_PASSWORD', '仮パスワードと異なるパスワードを設定してください');
  return withLock_(() => {
    const u = rows_('Users').find(x => String(x.userId) === String(user.userId));
    const salt = 's' + randomStr_(16);
    update_('Users', u, { passwordHash: hash_(next, salt), salt, isFirstLogin: false, updatedAt: Date.now() });
    return { user: publicUser_(u), message: 'パスワードを変更しました' };
  });
}

function logout_(req) {
  withLock_(() => deleteWhere_('Sessions', s => String(s.token) === String(req.token)));
  CacheService.getScriptCache().remove(cacheKey_(req.token));
  return { message: 'ログアウトしました' };
}

function auth_(token) {
  if (!token) throw err_('AUTH_REQUIRED', 'ログインしてください');
  const cache = CacheService.getScriptCache();
  let userId = cache.get(cacheKey_(token));
  if (!userId) {
    const s = rows_('Sessions').find(x => String(x.token) === String(token));
    if (!s || Number(s.expiresAt) < Date.now()) throw err_('AUTH_REQUIRED', 'セッションの有効期限が切れました。再ログインしてください');
    userId = String(s.userId);
    cache.put(cacheKey_(token), userId, 600);
  }
  const user = rows_('Users').find(u => String(u.userId) === userId);
  if (!user) throw err_('AUTH_REQUIRED', 'ユーザーが見つかりません');
  return user;
}

function publicUser_(u) {
  return { userId: String(u.userId), email: String(u.email), nickname: String(u.nickname), isFirstLogin: bool_(u.isFirstLogin) };
}

/* ============================================================
 * ルーム
 * ============================================================ */
function listRooms_(req, user) {
  const lat = num_(req.lat), lng = num_(req.lng);
  const now = Date.now();
  const myRoomIds = rows_('Players').filter(p => String(p.userId) === String(user.userId)).map(p => String(p.roomId));
  const counts = {};
  rows_('Players').forEach(p => { counts[p.roomId] = (counts[p.roomId] || 0) + 1; });
  const rooms = rows_('Rooms')
    .filter(r => {
      const mine = myRoomIds.indexOf(String(r.roomId)) >= 0;
      if (mine) return r.status !== 'finished';
      return r.status === 'waiting' && now - Number(r.createdAt) < 86400000;
    })
    .map(r => {
      const d = (lat != null && lng != null && r.centerLat !== '') ? dist_(lat, lng, Number(r.centerLat), Number(r.centerLng)) : null;
      return {
        roomId: String(r.roomId), code: String(r.code), name: String(r.name), mode: r.mode, modeLabel: MODE_LABEL[r.mode],
        status: r.status, players: counts[r.roomId] || 0, distance: d == null ? null : Math.round(d),
        joined: myRoomIds.indexOf(String(r.roomId)) >= 0
      };
    })
    .filter(r => r.joined || r.distance == null || r.distance <= 5000)
    .sort((a, b) => (b.joined - a.joined) || ((a.distance || 0) - (b.distance || 0)))
    .slice(0, 30);
  return { rooms };
}

function createRoom_(req, user) {
  const mode = String(req.mode || '');
  if (MODES.indexOf(mode) < 0) throw err_('INVALID_MODE', 'ゲームモードが不正です');
  const name = String(req.name || '').trim().slice(0, 30) || (user.nickname + 'の' + MODE_LABEL[mode]);
  const settings = sanitizeSettings_(req.settings || {}, mode);
  return withLock_(() => {
    const roomId = 'r_' + Utilities.getUuid();
    let code;
    do { code = randomStr_(6, 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'); }
    while (rows_('Rooms').some(r => String(r.code) === code && r.status !== 'finished'));
    const now = Date.now();
    insert_('Rooms', {
      roomId, code, name, mode, hostId: user.userId, status: 'waiting', settingsJson: JSON.stringify(settings),
      centerLat: num_(req.lat) == null ? '' : num_(req.lat), centerLng: num_(req.lng) == null ? '' : num_(req.lng),
      startedAt: '', endsAt: '', resultJson: '', createdAt: now
    });
    addPlayer_(roomId, user);
    addEvent_(roomId, 'system', user.nickname + ' さんが「' + name + '」を作成しました', user.userId);
    return { roomId, code };
  });
}

function joinRoom_(req, user) {
  const code = String(req.code || '').trim().toUpperCase();
  return withLock_(() => {
    const room = rows_('Rooms').find(r => String(r.code) === code && r.status !== 'finished');
    if (!room) throw err_('ROOM_NOT_FOUND', 'ルームコード「' + code + '」のルームが見つかりません');
    const exists = rows_('Players').some(p => String(p.roomId) === String(room.roomId) && String(p.userId) === String(user.userId));
    if (!exists) {
      if (room.status !== 'waiting') throw err_('ROOM_STARTED', 'このルームは既にゲーム中です');
      addPlayer_(String(room.roomId), user);
      addEvent_(String(room.roomId), 'system', user.nickname + ' さんが参加しました', user.userId);
    }
    return { roomId: String(room.roomId), code };
  });
}

function leaveRoom_(req, user) {
  return withLock_(() => {
    const room = getRoom_(req.roomId);
    const me = getPlayer_(room.roomId, user.userId);
    if (me) delete_('Players', me);
    addEvent_(room.roomId, 'system', user.nickname + ' さんが退出しました', user.userId);
    const rest = rows_('Players').filter(p => String(p.roomId) === String(room.roomId));
    if (rest.length === 0) {
      update_('Rooms', room, { status: 'finished', resultJson: JSON.stringify({ text: '参加者がいなくなりました' }) });
    } else if (String(room.hostId) === String(user.userId)) {
      update_('Rooms', room, { hostId: rest[0].userId });
      addEvent_(room.roomId, 'system', rest[0].nickname + ' さんがホストになりました', '');
    }
    return { message: '退出しました' };
  });
}

function setPlayer_(req, user) {
  return withLock_(() => {
    const room = getRoom_(req.roomId);
    requireHost_(room, user);
    if (room.status !== 'waiting') throw err_('NOT_WAITING', 'ゲーム開始後は変更できません');
    const p = getPlayer_(room.roomId, req.targetUserId);
    if (!p) throw err_('PLAYER_NOT_FOUND', 'プレイヤーが見つかりません');
    const patch = {};
    if (req.role !== undefined) patch.role = ['oni', 'runner', ''].indexOf(req.role) >= 0 ? req.role : '';
    if (req.team !== undefined) patch.team = ['red', 'blue', ''].indexOf(req.team) >= 0 ? req.team : '';
    update_('Players', p, patch);
    return { message: '更新しました' };
  });
}

function addSpot_(req, user) {
  const lat = num_(req.lat), lng = num_(req.lng);
  if (lat == null || lng == null) throw err_('INVALID_POSITION', '位置が指定されていません');
  return withLock_(() => {
    const room = getRoom_(req.roomId);
    requireHost_(room, user);
    if (room.status !== 'waiting') throw err_('NOT_WAITING', 'ゲーム開始後は追加できません');
    const settings = JSON.parse(room.settingsJson || '{}');
    const type = room.mode === 'territory' ? 'territory' : room.mode === 'board' ? 'board' : 'safe';
    const spots = rows_('Spots').filter(s => String(s.roomId) === String(room.roomId));
    const radius = clamp_(num_(req.radius) || settings.checkinRadius || 30, 10, 200);
    const name = String(req.name || '').trim().slice(0, 30) ||
      (type === 'safe' ? 'セーフティゾーン' : type === 'board' ? 'マス' : 'スポット') + (spots.length + 1);
    const spotId = 'sp_' + Utilities.getUuid();
    insert_('Spots', {
      spotId, roomId: room.roomId, name, lat, lng, radius, type, orderNo: spots.length + 1,
      ownerTeam: '', ownerUserId: '', capturedAt: '', createdAt: Date.now()
    });
    if (room.centerLat === '') update_('Rooms', room, { centerLat: lat, centerLng: lng });
    return { spotId };
  });
}

function deleteSpot_(req, user) {
  return withLock_(() => {
    const room = getRoom_(req.roomId);
    requireHost_(room, user);
    if (room.status !== 'waiting') throw err_('NOT_WAITING', 'ゲーム開始後は削除できません');
    deleteWhere_('Spots', s => String(s.spotId) === String(req.spotId) && String(s.roomId) === String(room.roomId));
    rows_('Spots').filter(s => String(s.roomId) === String(room.roomId))
      .sort((a, b) => Number(a.orderNo) - Number(b.orderNo))
      .forEach((s, i) => { if (Number(s.orderNo) !== i + 1) update_('Spots', s, { orderNo: i + 1 }); });
    return { message: '削除しました' };
  });
}

/* ============================================================
 * ゲーム進行
 * ============================================================ */
function startGame_(req, user) {
  return withLock_(() => {
    const room = getRoom_(req.roomId);
    requireHost_(room, user);
    if (room.status !== 'waiting') throw err_('NOT_WAITING', '既に開始しています');
    const settings = JSON.parse(room.settingsJson || '{}');
    const players = roomPlayers_(room.roomId);
    const spots = roomSpots_(room.roomId);
    if (players.length < 2 && room.mode !== 'board') throw err_('NOT_ENOUGH_PLAYERS', '2人以上で開始できます');
    if (room.mode === 'territory' && spots.length < 1) throw err_('NO_SPOTS', '陣地スポットを1つ以上追加してください');
    if (room.mode === 'board' && spots.length < 2) throw err_('NO_SPOTS', 'マス（スポット）を2つ以上追加してください');

    if (room.mode === 'onigokko' || room.mode === 'kakurenbo') {
      let onis = players.filter(p => p.role === 'oni');
      if (onis.length === 0) {
        const n = settings.oniCount > 0 ? Math.min(settings.oniCount, players.length - 1) : Math.max(1, Math.ceil(players.length / 4));
        shuffle_(players.slice()).slice(0, n).forEach(p => { p.role = 'oni'; });
      }
      players.forEach(p => update_('Players', p, { role: p.role === 'oni' ? 'oni' : 'runner', team: '', status: 'active', score: 0 }));
    } else if (room.mode === 'territory') {
      let red = players.filter(p => p.team === 'red').length;
      let blue = players.filter(p => p.team === 'blue').length;
      shuffle_(players.filter(p => p.team !== 'red' && p.team !== 'blue')).forEach(p => {
        if (red <= blue) { p.team = 'red'; red++; } else { p.team = 'blue'; blue++; }
      });
      players.forEach(p => update_('Players', p, { team: p.team, role: '', status: 'active', score: 0 }));
      spots.forEach(s => update_('Spots', s, { ownerTeam: '', ownerUserId: '', capturedAt: '' }));
    } else {
      players.forEach(p => update_('Players', p, { role: '', team: '', status: 'active', score: 0, position: 0, target: '', mission: '' }));
    }
    const now = Date.now();
    update_('Rooms', room, { status: 'playing', startedAt: now, endsAt: now + settings.durationMin * 60000 });

    const ctx = describeRoom_(room, players, spots, settings);
    const fallback = MODE_LABEL[room.mode] + '、スタート！制限時間は' + settings.durationMin + '分。健闘を祈る！';
    announce_(room, 'start', fallback, '次のゲームの開始を宣言する実況を2文で。' + ctx, '');
    return { message: '開始しました' };
  });
}

function endGame_(req, user) {
  return withLock_(() => {
    const room = getRoom_(req.roomId);
    requireHost_(room, user);
    if (room.status !== 'playing') throw err_('NOT_PLAYING', 'ゲーム中ではありません');
    finishGame_(room, 'host');
    return { message: '終了しました' };
  });
}

function syncRoom_(req, user) {
  const lat = num_(req.lat), lng = num_(req.lng), acc = num_(req.accuracy);
  return withLock_(() => {
    const room = getRoom_(req.roomId);
    const me = getPlayer_(room.roomId, user.userId);
    if (!me) throw err_('NOT_IN_ROOM', 'このルームに参加していません');
    const now = Date.now();
    if (lat != null && lng != null) {
      update_('Players', me, { lat, lng, accuracy: acc == null ? '' : Math.round(acc), locUpdatedAt: now });
    }
    if (room.status === 'playing' && now >= Number(room.endsAt)) finishGame_(room, 'timeup');
    return { state: buildState_(room, user, now), events: eventsSince_(room.roomId, user.userId, num_(req.sinceTs) || 0) };
  });
}

function tryCatch_(req, user) {
  return withLock_(() => {
    const room = getRoom_(req.roomId);
    requirePlaying_(room);
    if (room.mode !== 'onigokko' && room.mode !== 'kakurenbo') throw err_('INVALID_MODE', 'このモードでは捕獲できません');
    const settings = JSON.parse(room.settingsJson);
    const now = Date.now();
    const me = getPlayer_(room.roomId, user.userId);
    if (!me || me.role !== 'oni' || me.status !== 'active') throw err_('NOT_ONI', '鬼だけが捕獲できます');
    if (now < Number(room.startedAt) + settings.hideSeconds * 1000) {
      const s = Math.ceil((Number(room.startedAt) + settings.hideSeconds * 1000 - now) / 1000);
      throw err_('HIDE_TIME', (room.mode === 'kakurenbo' ? '隠れ時間' : '逃げ時間') + 'です。あと' + s + '秒待ってください');
    }
    requireFresh_(me, settings, now);
    const safes = roomSpots_(room.roomId).filter(s => s.type === 'safe');
    let best = null, nearest = Infinity;
    roomPlayers_(room.roomId).forEach(p => {
      if (p.role !== 'runner' || p.status !== 'active' || !isFresh_(p, now)) return;
      const d = dist_(Number(me.lat), Number(me.lng), Number(p.lat), Number(p.lng));
      nearest = Math.min(nearest, d);
      const inSafe = safes.some(s => dist_(Number(p.lat), Number(p.lng), Number(s.lat), Number(s.lng)) <= Number(s.radius));
      if (!inSafe && d <= settings.catchRadius && (!best || d < best.d)) best = { p, d };
    });
    if (!best) {
      const hint = nearest === Infinity ? '近くに逃走者の反応はありません' :
        nearest <= settings.catchRadius ? '相手はセーフティゾーンの中です' : '射程外です（' + settings.catchRadius + 'm以内に近づいてください）';
      return { caught: false, message: hint };
    }
    const target = best.p;
    if (settings.infect) update_('Players', target, { role: 'oni', status: 'active' });
    else update_('Players', target, { status: 'caught' });
    update_('Players', me, { score: Number(me.score || 0) + 1 });
    const fallback = me.nickname + ' が ' + target.nickname + ' を確保！' + (settings.infect ? target.nickname + ' は鬼になった！' : '');
    announce_(room, 'catch', fallback,
      '鬼「' + me.nickname + '」が逃走者「' + target.nickname + '」を捕まえた瞬間の実況を1〜2文で。' + (settings.infect ? '捕まった人は新たな鬼になる。' : ''), user.userId);
    const left = roomPlayers_(room.roomId).filter(p => p.role === 'runner' && p.status === 'active').length;
    if (left === 0) finishGame_(room, 'allcaught');
    return { caught: true, target: target.nickname, media: 'catch', message: target.nickname + ' を確保しました！' };
  });
}

function checkin_(req, user) {
  return withLock_(() => {
    const room = getRoom_(req.roomId);
    requirePlaying_(room);
    const settings = JSON.parse(room.settingsJson);
    const now = Date.now();
    const me = getPlayer_(room.roomId, user.userId);
    if (!me) throw err_('NOT_IN_ROOM', 'このルームに参加していません');
    requireFresh_(me, settings, now);
    const spot = roomSpots_(room.roomId).find(s => String(s.spotId) === String(req.spotId));
    if (!spot) throw err_('SPOT_NOT_FOUND', 'スポットが見つかりません');
    const d = dist_(Number(me.lat), Number(me.lng), Number(spot.lat), Number(spot.lng));
    const tolerance = Math.min(Number(me.accuracy) || 0, 20);
    if (d > Number(spot.radius) + tolerance) {
      throw err_('TOO_FAR', '「' + spot.name + '」まであと約' + Math.round(d - Number(spot.radius)) + 'mです');
    }

    if (room.mode === 'territory') {
      if (spot.ownerTeam === me.team) return { captured: false, message: '「' + spot.name + '」は既に自陣です' };
      if (spot.capturedAt !== '' && now - Number(spot.capturedAt) < settings.captureCooldownSec * 1000) {
        const s = Math.ceil((Number(spot.capturedAt) + settings.captureCooldownSec * 1000 - now) / 1000);
        throw err_('COOLDOWN', '占領直後のため、あと' + s + '秒は奪えません');
      }
      const prev = spot.ownerTeam;
      update_('Spots', spot, { ownerTeam: me.team, ownerUserId: me.userId, capturedAt: now });
      update_('Players', me, { score: Number(me.score || 0) + 1 });
      const fallback = TEAM_LABEL[me.team] + 'の' + me.nickname + ' が「' + spot.name + '」を' + (prev ? TEAM_LABEL[prev] + 'から奪取！' : '占領！');
      announce_(room, 'capture', fallback,
        TEAM_LABEL[me.team] + 'の「' + me.nickname + '」がスポット「' + spot.name + '」を' + (prev ? TEAM_LABEL[prev] + 'から奪った' : '初めて占領した') +
        '。現在の占領数: ' + territoryCount_(room.roomId) + '。実況を1〜2文で。', user.userId);
      return { captured: true, media: 'capture', message: '「' + spot.name + '」を占領しました！' };
    }

    if (room.mode === 'board') {
      if (me.target === '' || Number(me.target) !== Number(spot.orderNo)) throw err_('NOT_TARGET', 'ダイスで出た目的のマスではありません');
      if (me.mission) return { mission: String(me.mission), message: 'ミッション進行中です' };
      const fallbackMission = '「' + spot.name + '」の周りで、あなたが一番面白いと思ったものを見つけて写真に撮ろう！';
      const mission = aiOrFallback_(user.userId,
        'すごろくのマス「' + spot.name + '」に到着したプレイヤーへ、その場で5分以内にできる安全で楽しいミッションを1つ、1〜2文で出してください。他人の迷惑になる行為・危険な行為・購入を強制する内容は禁止。',
        fallbackMission);
      update_('Players', me, { mission });
      addEvent_(room.roomId, 'mission', me.nickname + ' が「' + spot.name + '」に到着！ミッション発令：' + mission, user.userId);
      return { mission, message: 'ミッション発令！' };
    }
    throw err_('INVALID_MODE', 'このモードではチェックインはありません');
  });
}

function rollDice_(req, user) {
  return withLock_(() => {
    const room = getRoom_(req.roomId);
    requirePlaying_(room);
    if (room.mode !== 'board') throw err_('INVALID_MODE', 'すごろくモード専用です');
    const me = getPlayer_(room.roomId, user.userId);
    if (me.target !== '' && me.target != null) throw err_('ALREADY_ROLLED', '先に目的のマスへ向かってください');
    const spots = roomSpots_(room.roomId);
    const dice = 1 + Math.floor(Math.random() * 6);
    const target = Math.min(Number(me.position || 0) + dice, spots.length);
    const spot = spots.find(s => Number(s.orderNo) === target);
    update_('Players', me, { target, mission: '' });
    addEvent_(room.roomId, 'dice', me.nickname + ' のダイスは「' + dice + '」！次の目的地は' + target + 'マス目「' + spot.name + '」', user.userId);
    return { dice, target, spot: spotOut_(spot), message: dice + 'が出ました！「' + spot.name + '」へ向かおう' };
  });
}

function completeMission_(req, user) {
  return withLock_(() => {
    const room = getRoom_(req.roomId);
    requirePlaying_(room);
    const me = getPlayer_(room.roomId, user.userId);
    if (!me || !me.mission) throw err_('NO_MISSION', '進行中のミッションがありません');
    const total = roomSpots_(room.roomId).length;
    const pos = Number(me.target);
    update_('Players', me, { position: pos, target: '', mission: '', score: Number(me.score || 0) + 1 });
    addEvent_(room.roomId, 'mission', me.nickname + ' がミッションクリア！' + pos + '/' + total + 'マス目に進んだ', user.userId);
    if (pos >= total) {
      finishGame_(room, 'goal', me);
      return { goal: true, media: 'win', message: 'ゴール！' };
    }
    return { goal: false, message: 'ミッションクリア！次のダイスを振ろう' };
  });
}

function gmOrder_(req, user) {
  const room = getRoom_(req.roomId);
  requirePlaying_(room);
  const settings = JSON.parse(room.settingsJson);
  const players = roomPlayers_(room.roomId);
  const me = players.find(p => String(p.userId) === String(user.userId));
  const spots = roomSpots_(room.roomId);
  const left = Math.max(0, Math.round((Number(room.endsAt) - Date.now()) / 60000));
  let near = '';
  if (me && me.lat !== '') {
    near = spots.map(s => ({ s, d: dist_(Number(me.lat), Number(me.lng), Number(s.lat), Number(s.lng)) }))
      .sort((a, b) => a.d - b.d).slice(0, 4)
      .map(x => '「' + x.s.name + '」(約' + Math.round(x.d) + 'm' + (x.s.ownerTeam ? '・' + TEAM_LABEL[x.s.ownerTeam] + '所有' : '') + ')').join('、');
  }
  const roleText = me ? (me.role === 'oni' ? '鬼' : me.role === 'runner' ? '逃走者' : me.team ? TEAM_LABEL[me.team] : 'プレイヤー') : 'プレイヤー';
  const prompt = 'あなたは' + MODE_LABEL[room.mode] + 'のゲームマスター。' + roleText + 'の「' + user.nickname + '」へ、今すぐ実行できる短い指令を1〜2文で出してください。' +
    '例:「〇〇の半径50m以内に侵入せよ」。残り' + left + '分。' + (near ? '近くのスポット: ' + near + '。' : '') +
    (room.mode === 'kakurenbo' || room.mode === 'onigokko' ? '索敵範囲は' + settings.radarRange + 'm。' : '') +
    '道路への飛び出し・私有地侵入・走って人にぶつかる等の危険行為は絶対に指示しない。';
  const order = aiOrFallback_(user.userId, prompt, '周囲を警戒しつつ、近くのスポットへ慎重に移動せよ！');
  withLock_(() => addEvent_(room.roomId, 'order', '📡 指令：' + order, user.userId, 'private'));
  return { order };
}

function finishGame_(room, reason, winnerPlayer) {
  if (room.status !== 'playing') return;
  const players = roomPlayers_(room.roomId);
  const spots = roomSpots_(room.roomId);
  let result = { reason };
  if (room.mode === 'onigokko' || room.mode === 'kakurenbo') {
    const runners = players.filter(p => p.role === 'runner' && p.status === 'active');
    result.winner = runners.length > 0 ? 'runner' : 'oni';
    result.text = runners.length > 0 ? '逃走者の勝利！逃げ切り: ' + runners.map(p => p.nickname).join('、') : '鬼の勝利！全員確保';
  } else if (room.mode === 'territory') {
    const c = territoryCountObj_(room.roomId);
    result.counts = c;
    result.winner = c.red > c.blue ? 'red' : c.blue > c.red ? 'blue' : 'draw';
    result.text = result.winner === 'draw' ? '引き分け！（赤' + c.red + ' 対 青' + c.blue + '）' :
      TEAM_LABEL[result.winner] + 'の勝利！（赤' + c.red + ' 対 青' + c.blue + '）';
  } else {
    const sorted = players.slice().sort((a, b) => Number(b.position || 0) - Number(a.position || 0) || Number(b.score || 0) - Number(a.score || 0));
    const w = winnerPlayer || sorted[0];
    result.winner = w ? String(w.userId) : '';
    result.text = w ? w.nickname + ' の勝利！（' + w.position + '/' + spots.length + 'マス）' : '終了';
  }
  result.ranking = players.slice()
    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0))
    .map(p => ({ nickname: String(p.nickname), role: p.role, team: p.team, score: Number(p.score || 0), status: p.status, position: Number(p.position || 0) }));
  update_('Rooms', room, { status: 'finished', resultJson: JSON.stringify(result), endsAt: Date.now() });
  const reasonText = { timeup: 'タイムアップ', allcaught: '全員確保', goal: 'ゴール到達', host: 'ホストによる終了' }[reason] || '';
  announce_(room, 'finish', 'ゲーム終了！' + result.text, 'ゲーム終了（' + reasonText + '）。結果: ' + result.text + '。参加者をねぎらう締めの実況を2文で。', '');
}

/* ============================================================
 * 状態の組み立て（可視性ルール）
 * ============================================================ */
function buildState_(room, user, now) {
  const settings = JSON.parse(room.settingsJson || '{}');
  const players = roomPlayers_(room.roomId);
  const spots = roomSpots_(room.roomId);
  const me = players.find(p => String(p.userId) === String(user.userId));
  const isTag = room.mode === 'onigokko' || room.mode === 'kakurenbo';
  const playing = room.status === 'playing';
  const startedAt = Number(room.startedAt) || 0;
  let reveal = false, nextRevealIn = null;
  if (playing && isTag && settings.revealInterval > 0) {
    const t = (now - startedAt) / 1000;
    if (t > settings.hideSeconds) {
      const phase = (t - settings.hideSeconds) % settings.revealInterval;
      reveal = phase >= settings.revealInterval - APP.REVEAL_WINDOW_SEC;
      nextRevealIn = Math.round(settings.revealInterval - APP.REVEAL_WINDOW_SEC - phase);
    }
  }
  const myLat = me && me.lat !== '' ? Number(me.lat) : null;
  const myLng = me && me.lng !== '' ? Number(me.lng) : null;

  const outPlayers = players.map(p => {
    const isMe = me && String(p.userId) === String(me.userId);
    const base = {
      userId: String(p.userId), nickname: String(p.nickname), role: p.role, team: p.team, status: p.status,
      score: Number(p.score || 0), position: Number(p.position || 0), isMe: !!isMe, isHost: String(p.userId) === String(room.hostId),
      stale: !isFresh_(p, now)
    };
    if (p.lat === '' || p.lat == null) return base;
    const plat = Number(p.lat), plng = Number(p.lng);
    let visible = true, radar = false, coarse = false;
    if (playing && !isMe && me) {
      if (isTag) {
        const sameSide = p.role === me.role;
        if (!sameSide) {
          visible = reveal;
          if (room.mode === 'onigokko') radar = true;
          else if (me.role === 'runner') radar = true;   // 逃走者は鬼の方向と距離がわかる
          else coarse = true;                           // 鬼には距離感のみ
        }
      } else if (room.mode === 'territory') {
        if (p.team !== me.team) { visible = false; radar = true; }
      }
    }
    if (visible) { base.lat = plat; base.lng = plng; base.accuracy = Number(p.accuracy) || null; }
    if (myLat != null && !isMe) {
      const d = dist_(myLat, myLng, plat, plng);
      if (visible || radar || coarse) {
        if (visible || d <= settings.radarRange) {
          if (coarse && !visible) base.heat = d <= settings.radarRange / 3 ? 'hot' : d <= settings.radarRange * 2 / 3 ? 'warm' : 'cold';
          else { base.distance = Math.round(d); base.bearing = Math.round(bearing_(myLat, myLng, plat, plng)); }
        }
      }
    }
    return base;
  });

  return {
    serverNow: now,
    room: {
      roomId: String(room.roomId), code: String(room.code), name: String(room.name), mode: room.mode, modeLabel: MODE_LABEL[room.mode],
      status: room.status, hostId: String(room.hostId), isHost: String(room.hostId) === String(user.userId),
      startedAt: startedAt || null, endsAt: Number(room.endsAt) || null, settings,
      center: room.centerLat !== '' ? [Number(room.centerLat), Number(room.centerLng)] : null,
      result: room.resultJson ? JSON.parse(room.resultJson) : null,
      reveal, nextRevealIn
    },
    me: me ? {
      role: me.role, team: me.team, status: me.status, score: Number(me.score || 0), position: Number(me.position || 0),
      target: me.target === '' || me.target == null ? null : Number(me.target), mission: String(me.mission || '')
    } : null,
    players: outPlayers,
    spots: spots.map(spotOut_)
  };
}

function eventsSince_(roomId, userId, sinceTs) {
  return rows_('Events')
    .filter(e => String(e.roomId) === String(roomId) && Number(e.createdAt) > sinceTs &&
      (e.visibility !== 'private' || String(e.userId) === String(userId)))
    .sort((a, b) => Number(a.createdAt) - Number(b.createdAt))
    .slice(-30)
    .map(e => ({ id: String(e.eventId), type: e.type, message: String(e.message), userId: String(e.userId), createdAt: Number(e.createdAt) }));
}

/* ============================================================
 * Gemini / TTS / メディア
 * ============================================================ */
const GM_SYSTEM = 'あなたは街を舞台にした位置情報ゲームの熱血ゲームマスター兼実況アナウンサーです。' +
  '日本語で、短く、テンポよく、ワクワクする口調で話します。絵文字・記号・マークダウンは使いません。' +
  '安全第一：交通ルール遵守、走って人にぶつからない、私有地に入らないことを常に前提にします。' +
  '出力はそのまま音声で読み上げられます。前置き・説明・「〜と読み上げてください」などの指示文や括弧書きは一切書かず、読み上げる本文だけを出力してください。';

function callGemini_(prompt) {
  const key = prop_('GEMINI_API_KEY');
  if (!key) throw err_('NO_API_KEY', 'GEMINI_API_KEY が未設定です');
  const model = prop_('GEMINI_TEXT_MODEL') || 'gemini-2.5-flash';
  const res = UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { 'x-goog-api-key': key },
    payload: JSON.stringify({
      systemInstruction: { parts: [{ text: GM_SYSTEM }] },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.9, maxOutputTokens: 2048 }
    })
  });
  if (res.getResponseCode() !== 200) throw err_('GEMINI_ERROR', 'Gemini API エラー: ' + res.getResponseCode() + ' ' + res.getContentText().slice(0, 200));
  const data = JSON.parse(res.getContentText());
  const parts = (((data.candidates || [])[0] || {}).content || {}).parts || [];
  const text = parts.filter(p => p.text && !p.thought).map(p => p.text).join('').trim();
  return text.replace(/[*#`]/g, '').slice(0, 300);
}

function aiOrFallback_(userId, prompt, fallback) {
  try {
    if (!prop_('GEMINI_API_KEY') || !rateOk_(userId)) return fallback;
    return callGemini_(prompt) || fallback;
  } catch (e) {
    console.warn('Gemini fallback', e);
    return fallback;
  }
}

function announce_(room, type, fallback, prompt, userId) {
  const settings = JSON.parse(room.settingsJson || '{}');
  const msg = settings.aiAnnounce ? aiOrFallback_('room_' + room.roomId, prompt, fallback) : fallback;
  addEvent_(room.roomId, type, msg, userId || '');
  return msg;
}

function tts_(req, user) {
  const text = String(req.text || '').slice(0, 300);
  if (!text) throw err_('EMPTY', 'テキストが空です');
  if (!rateOk_('tts_' + user.userId, 20)) throw err_('RATE_LIMIT', '音声生成の回数制限に達しました');
  const key = prop_('GEMINI_API_KEY');
  if (!key) throw err_('NO_API_KEY', 'GEMINI_API_KEY が未設定です');
  const model = prop_('GEMINI_TTS_MODEL') || 'gemini-2.5-flash-preview-tts';
  const voice = prop_('GEMINI_TTS_VOICE') || 'Kore';
  const res = UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { 'x-goog-api-key': key },
    payload: JSON.stringify({
      contents: [{ parts: [{ text: text }] }],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } }
      }
    })
  });
  if (res.getResponseCode() !== 200) throw err_('TTS_ERROR', 'TTS エラー: ' + res.getResponseCode() + ' ' + res.getContentText().slice(0, 200));
  const data = JSON.parse(res.getContentText());
  const part = ((((data.candidates || [])[0] || {}).content || {}).parts || []).find(p => p.inlineData);
  if (!part) throw err_('TTS_ERROR', '音声データが返りませんでした');
  return { audio: part.inlineData.data, mimeType: part.inlineData.mimeType || 'audio/L16;codec=pcm;rate=24000' };
}

function getMedia_() {
  const media = {};
  rows_('Media').forEach(m => {
    if (!m.key) return;
    const id = String(m.driveFileId || '').trim();
    const type = String(m.mediaType || 'video');
    let url = String(m.directUrl || '').trim();
    if (!url && id) url = type === 'image' ? 'https://lh3.googleusercontent.com/d/' + id : 'https://drive.google.com/uc?export=download&id=' + id;
    if (!url) return;
    media[String(m.key)] = { type, url, preview: id ? 'https://drive.google.com/file/d/' + id + '/preview' : '' };
  });
  return { media };
}

/* ============================================================
 * 内部ヘルパー
 * ============================================================ */
function sanitizeSettings_(s, mode) {
  const o = Object.assign({}, DEFAULT_SETTINGS);
  if (mode === 'kakurenbo') { o.hideSeconds = 120; o.revealInterval = 300; o.radarRange = 150; }
  if (mode === 'onigokko') { o.hideSeconds = 30; }
  const n = (k, min, max) => { const v = num_(s[k]); if (v != null) o[k] = clamp_(Math.round(v), min, max); };
  n('durationMin', 3, 180); n('catchRadius', 5, 50); n('hideSeconds', 0, 600); n('revealInterval', 0, 1800);
  n('radarRange', 50, 2000); n('alertRadius', 10, 300); n('oniCount', 0, 20); n('checkinRadius', 10, 200);
  n('captureCooldownSec', 0, 600); n('maxAccuracy', 10, 200);
  if (s.infect !== undefined) o.infect = !!s.infect;
  if (s.aiAnnounce !== undefined) o.aiAnnounce = !!s.aiAnnounce;
  return o;
}

function describeRoom_(room, players, spots, settings) {
  let t = 'モード: ' + MODE_LABEL[room.mode] + '、参加' + players.length + '人、制限時間' + settings.durationMin + '分。';
  if (room.mode === 'onigokko' || room.mode === 'kakurenbo') {
    t += '鬼: ' + players.filter(p => p.role === 'oni').map(p => p.nickname).join('、') + '。' + (room.mode === 'kakurenbo' ? '隠れ時間' : '逃げ時間') + settings.hideSeconds + '秒。';
  } else if (room.mode === 'territory') {
    t += 'スポット' + spots.length + 'か所を赤と青で奪い合う。';
  } else {
    t += 'マス' + spots.length + 'つ。ダイスを振って実際にマスまで歩き、ミッションをクリアして進む。';
  }
  return t;
}

function spotOut_(s) {
  return {
    spotId: String(s.spotId), name: String(s.name), lat: Number(s.lat), lng: Number(s.lng), radius: Number(s.radius),
    type: s.type, orderNo: Number(s.orderNo), ownerTeam: s.ownerTeam || '', capturedAt: Number(s.capturedAt) || null
  };
}

function territoryCountObj_(roomId) {
  const c = { red: 0, blue: 0 };
  roomSpots_(roomId).forEach(s => { if (c[s.ownerTeam] != null) c[s.ownerTeam]++; });
  return c;
}
function territoryCount_(roomId) { const c = territoryCountObj_(roomId); return '赤' + c.red + '・青' + c.blue; }

function addPlayer_(roomId, user) {
  insert_('Players', {
    roomId, userId: user.userId, nickname: user.nickname, role: '', team: '', lat: '', lng: '', accuracy: '',
    locUpdatedAt: '', status: 'active', score: 0, position: 0, target: '', mission: '', joinedAt: Date.now()
  });
}

function addEvent_(roomId, type, message, userId, visibility) {
  const now = Date.now();
  insert_('Events', {
    eventId: 'e' + now + '_' + randomStr_(4), roomId, type, message, userId: userId || '',
    visibility: visibility || 'all', createdAt: now
  });
}

function getRoom_(roomId) {
  const r = rows_('Rooms').find(x => String(x.roomId) === String(roomId));
  if (!r) throw err_('ROOM_NOT_FOUND', 'ルームが見つかりません');
  r.roomId = String(r.roomId);
  return r;
}
function getPlayer_(roomId, userId) {
  return rows_('Players').find(p => String(p.roomId) === String(roomId) && String(p.userId) === String(userId));
}
function roomPlayers_(roomId) { return rows_('Players').filter(p => String(p.roomId) === String(roomId)); }
function roomSpots_(roomId) {
  return rows_('Spots').filter(s => String(s.roomId) === String(roomId)).sort((a, b) => Number(a.orderNo) - Number(b.orderNo));
}
function requireHost_(room, user) {
  if (String(room.hostId) !== String(user.userId)) throw err_('NOT_HOST', 'ホストのみ操作できます');
}
function requirePlaying_(room) {
  if (room.status !== 'playing') throw err_('NOT_PLAYING', 'ゲーム中ではありません');
  if (Date.now() >= Number(room.endsAt)) { finishGame_(room, 'timeup'); throw err_('NOT_PLAYING', 'タイムアップです'); }
}
function isFresh_(p, now) { return p.locUpdatedAt !== '' && now - Number(p.locUpdatedAt) <= APP.FRESH_SEC * 1000; }
function requireFresh_(p, settings, now) {
  if (!isFresh_(p, now)) throw err_('NO_LOCATION', '位置情報が取得できていません。GPSを確認してください');
  if (Number(p.accuracy) > settings.maxAccuracy) throw err_('LOW_ACCURACY', 'GPS精度が低すぎます（±' + p.accuracy + 'm）。空の開けた場所で再試行してください');
}

function rateOk_(key, limit) {
  const cache = CacheService.getScriptCache();
  const k = 'rate_' + key + '_' + Math.floor(Date.now() / 60000);
  const n = Number(cache.get(k) || 0);
  if (n >= (limit || APP.AI_PER_MIN)) return false;
  cache.put(k, String(n + 1), 120);
  return true;
}

function dist_(lat1, lng1, lat2, lng2) {
  const R = 6371000, r = Math.PI / 180;
  const dLat = (lat2 - lat1) * r, dLng = (lng2 - lng1) * r;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
function bearing_(lat1, lng1, lat2, lng2) {
  const r = Math.PI / 180;
  const y = Math.sin((lng2 - lng1) * r) * Math.cos(lat2 * r);
  const x = Math.cos(lat1 * r) * Math.sin(lat2 * r) - Math.sin(lat1 * r) * Math.cos(lat2 * r) * Math.cos((lng2 - lng1) * r);
  return (Math.atan2(y, x) / r + 360) % 360;
}

function hash_(password, salt) {
  let h = salt + ':' + password;
  for (let i = 0; i < APP.HASH_ROUNDS; i++) {
    h = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, h + salt, Utilities.Charset.UTF_8)
      .map(b => ('0' + (b & 255).toString(16)).slice(-2)).join('');
  }
  return h;
}

function randomStr_(len, chars) {
  chars = chars || 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let out = '';
  while (out.length < len) {
    const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, Utilities.getUuid() + Math.random());
    for (let i = 0; i < bytes.length && out.length < len; i++) out += chars[(bytes[i] & 255) % chars.length];
  }
  return out;
}

function shuffle_(arr) {
  for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
  return arr;
}

function normEmail_(e) { return String(e || '').trim().toLowerCase(); }
function num_(v) { if (v === '' || v === null || v === undefined) return null; const n = Number(v); return isFinite(n) ? n : null; }
function clamp_(v, min, max) { return Math.max(min, Math.min(max, v)); }
function bool_(v) { return v === true || String(v).toUpperCase() === 'TRUE' || String(v) === '1'; }
function prop_(k) { return PropertiesService.getScriptProperties().getProperty(k); }
function cacheKey_(token) { return 'sess_' + String(token).slice(-40); }
function err_(code, message) { const e = new Error(message); e.code = code; return e; }
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw err_('BUSY', 'サーバーが混み合っています。もう一度お試しください');
  try { return fn(); } finally { lock.releaseLock(); }
}

/* ---------- シート操作（リクエスト内キャッシュ付き） ---------- */
let _ss = null;
const _rows = {};
function ss_() {
  if (_ss) return _ss;
  const id = prop_('SPREADSHEET_ID');
  _ss = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
  return _ss;
}
function sh_(name) {
  const sh = ss_().getSheetByName(name);
  if (!sh) throw err_('NO_SHEET', 'シート「' + name + '」がありません。setup() を実行してください');
  return sh;
}
function rows_(name) {
  if (_rows[name]) return _rows[name];
  const values = sh_(name).getDataRange().getValues();
  const head = values.shift() || [];
  _rows[name] = values.map((r, i) => { const o = { _row: i + 2 }; head.forEach((k, j) => { o[k] = r[j]; }); return o; });
  return _rows[name];
}
function insert_(name, obj) {
  const h = SHEETS[name];
  sh_(name).appendRow(h.map(k => (obj[k] === undefined || obj[k] === null) ? '' : obj[k]));
  delete _rows[name];
}
function update_(name, row, patch) {
  Object.assign(row, patch);
  const h = SHEETS[name];
  sh_(name).getRange(row._row, 1, 1, h.length).setValues([h.map(k => (row[k] === undefined || row[k] === null) ? '' : row[k])]);
}
function delete_(name, row) {
  sh_(name).deleteRow(row._row);
  delete _rows[name];
}
function deleteWhere_(name, pred) {
  const targets = rows_(name).filter(pred).map(r => r._row).sort((a, b) => b - a);
  const sh = sh_(name);
  targets.forEach(r => sh.deleteRow(r));
  delete _rows[name];
}
