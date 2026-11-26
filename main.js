const { app, BrowserWindow, Tray, Menu, screen, nativeImage, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { Wnp, HANDSHAKE } = require('./wnp');
const { trayIconPng } = require('./png');
const { setAcrylic, clearAcrylic } = require('./acrylic');
const { DiscordPresence } = require('./discord');
const { APPS, SmtcSource, pickView } = require('./smtc');
const { DEFAULT_SERVER_URL, normalizeServerUrl, displayAddress } = require('./relay-config');
const { Controller } = require('./control');

const PORT = Number(process.env.NP_PORT) || 37250;
const DEBUG = process.env.NP_DEBUG === '1';
const HIDE_DELAY_MS = 10_000;
const SIZE = { width: 360, height: 96 };
const MARGIN = 16;

const log = (...args) => { if (DEBUG) console.log('[np]', ...args); };

// 動作確認用: 設定の保存先を分けると、普段使いの Agent と並べて動かせる
if (process.env.NP_USERDATA) app.setPath('userData', process.env.NP_USERDATA);

if (!app.requestSingleInstanceLock()) app.quit();

const wnp = new Wnp();
const desktop = APPS.map((a) => new SmtcSource(a, { log }));
// デスクトップアプリ (SMTC) と Web (WebNowPlaying) のどれを出すかは pickView が決める
const currentView = () => pickView(desktop.map((d) => d.view()), wnp.view());
const sockets = new Set();
let win = null;
let tray = null;
let hideTimer = null;
let forcedHidden = false;
let settingsWin = null;
let previewOn = false;
let saveTimer = null;
let settings = { x: null, y: null, clickThrough: false, transparency: 25, blur: true,
  discord: true, discordAppId: '', spotify: true, appleMusic: true,
  // サーバへの送信は、使う人がオンにするまで何も送らない
  relay: false, serverUrl: DEFAULT_SERVER_URL, certIssuer: 'Console Private CA',
  // サーバや Web からの操作も、オンにするまで受け付けない
  remoteControl: false };
const controller = new Controller({ log });
let relayWin = null;
let relayStatus = 'off';
let remoteState = null; // サーバが持つ今の状態 (/sub で受け取る)
let lastRelayKey = '';
let lastRelayAt = 0;
let lastRelayCover = '';

const clampPercent = (v) => Math.min(100, Math.max(0, Math.round(Number(v)) || 0));
// 透過率が高いほど、暗い色の重ねを薄くする
const tintAlpha = () => Number((1 - settings.transparency / 100).toFixed(2));
const DISCORD_LABEL = {
  off: '無効', noid: 'Application ID が未設定', connecting: '接続しています',
  waiting: 'Discord が見つかりません (再試行中)', connected: '接続中', badid: 'Application ID が正しくありません',
};
const discord = new DiscordPresence({
  log,
  onStatus: (status) => {
    updateTray();
    sendToSettings('discord-status', DISCORD_LABEL[status] || status);
  },
});

const sampleView = () => ({
  playing: true, state: 0, title: 'プレビュー', artist: '透過率の確認', album: '', source: 'NowPlaying',
  cover: '', position: 60, duration: 200, at: Date.now(),
});

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

function loadSettings() {
  try { settings = { ...settings, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) }; } catch { /* 初回 */ }
  settings.transparency = clampPercent(settings.transparency);
  settings.relay = settings.relay === true;
  settings.remoteControl = settings.remoteControl === true;
  settings.serverUrl = normalizeServerUrl(settings.serverUrl) || DEFAULT_SERVER_URL;
}

function saveSettings() {
  try {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify(settings));
  } catch (e) { log('settings save failed', e.message); }
}

function defaultPosition() {
  const wa = screen.getPrimaryDisplay().workArea;
  return { x: wa.x + wa.width - SIZE.width - MARGIN, y: wa.y + MARGIN };
}

// 保存した位置が、今のどの画面にも入っていなければ右上に戻す
function startPosition() {
  if (settings.x === null || settings.y === null) return defaultPosition();
  const inside = screen.getAllDisplays().some((d) => {
    const b = d.workArea;
    return settings.x >= b.x - 20 && settings.y >= b.y - 20 && settings.x < b.x + b.width - 40 && settings.y < b.y + b.height - 40;
  });
  return inside ? { x: settings.x, y: settings.y } : defaultPosition();
}

function createWindow() {
  const pos = startPosition();
  win = new BrowserWindow({
    ...SIZE, x: pos.x, y: pos.y, show: false,
    frame: false, resizable: false, maximizable: false, minimizable: false, fullscreenable: false,
    skipTaskbar: true, alwaysOnTop: true, hasShadow: true,
    transparent: true, roundedCorners: true, backgroundColor: '#00000000',
    title: 'NowPlaying',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setIgnoreMouseEvents(settings.clickThrough, { forward: true });
  win.loadFile(path.join(__dirname, 'widget.html'));

  let moveTimer = null;
  win.on('moved', () => {
    clearTimeout(moveTimer);
    moveTimer = setTimeout(() => {
      const [x, y] = win.getPosition();
      settings.x = x; settings.y = y;
      saveSettings();
    }, 300);
  });
  win.webContents.on('did-finish-load', () => { pushConfig(); pushState(); });
}

function pushConfig() {
  if (!win || win.isDestroyed()) return;
  // ぼかしはウィンドウの後ろに、色の濃さ (不透明度) は画面側の半透明の色でかける
  if (settings.blur) setAcrylic(win); else clearAcrylic(win);
  win.webContents.send('config', { tint: tintAlpha() });
}

function pushState() {
  if (!win || win.isDestroyed()) return;
  const real = currentView();
  const view = real || (previewOn ? sampleView() : null);
  if (view) win.webContents.send('state', view);
  applyVisibility(view);
  relayPublish(real, false);
  discord.update(discordSource());
}

// Discord に出すのは、この PC の再生が優先。この PC に何も無くて、サーバへの送信がオンなら、
// サーバが持つ状態 (別の PC の再生) を出す
function discordSource() {
  const real = currentView();
  if (real || !relayEnabled() || !remoteState) return discordState(real);
  const s = remoteState;
  return {
    state: s.state, title: s.title, artist: s.artist, album: s.album, source: s.source,
    cover: /^https:\/\//i.test(s.cover) ? s.cover : '', position: s.position, duration: s.duration,
  };
}

// Discord へ渡す内容。確認用の表示は含めない。カバーは公開された https の URL だけ
function discordState(view) {
  if (!view) return { state: 2 };
  const elapsed = view.playing ? (Date.now() - view.at) / 1000 : 0;
  const position = view.duration > 0 ? Math.min(view.duration, view.position + elapsed) : view.position;
  return {
    state: view.state, title: view.title, artist: view.artist, album: view.album, source: view.source,
    cover: /^https:\/\//i.test(view.cover) ? view.cover : '', position: Math.round(position), duration: view.duration,
  };
}

// ---- サーバへの送信 ----
const relayEnabled = () => settings.relay && process.env.NP_NO_RELAY !== '1';
const relayUrl = () => normalizeServerUrl(process.env.NP_SERVER) || settings.serverUrl;
// 操作は、サーバへの送信と「操作を受け付ける」の両方がオンのときだけ受け付ける
const remoteEnabled = () => relayEnabled() && settings.remoteControl;

const RELAY_LABEL = {
  off: '準備中', connecting: '接続しています', connected: '接続中',
  disconnected: '切れました (再接続中)', error: '失敗 (再接続中)',
};
function relayLabel() {
  if (!relayEnabled()) return 'オフ (何も送りません)';
  return RELAY_LABEL[relayStatus] || relayStatus;
}

// カバーは、公開された https の URL か、縮小した JPEG (data URI) だけをサーバへ送る
const COVER_MAX_PX = 600;
const COVER_MAX_CHARS = 150_000;
let coverCache = { src: '', out: '' };
function coverForRelay(src) {
  if (!src) return '';
  if (/^https:\/\//i.test(src)) return src.length <= 1000 ? src : '';
  if (!/^data:image\//i.test(src)) return '';
  if (coverCache.src === src) return coverCache.out;
  let out = '';
  try {
    // SMTC の画像は、申告された種類 (jpeg) と中身 (PNG) が違うことがある。createFromBuffer は中身で見分ける
    const buf = Buffer.from(src.slice(src.indexOf(',') + 1), 'base64');
    let image = nativeImage.createFromBuffer(buf);
    const { width, height } = image.getSize();
    if (Math.max(width, height) > COVER_MAX_PX) {
      image = image.resize(width >= height ? { width: COVER_MAX_PX, quality: 'best' } : { height: COVER_MAX_PX, quality: 'best' });
    }
    if (!image.isEmpty()) {
      for (const q of [85, 70, 50, 30]) {
        out = 'data:image/jpeg;base64,' + image.toJPEG(q).toString('base64');
        if (out.length <= COVER_MAX_CHARS) break;
        out = '';
      }
    }
  } catch { out = ''; }
  coverCache = { src, out };
  return out;
}

// サーバへ送る内容。確認用の表示は送らない
function relayPayload(view) {
  if (!view) return { v: 1, type: 'state', state: 2, title: '', artist: '', album: '', source: '', cover: '', position: 0, duration: 0 };
  const s = discordState(view);
  return {
    v: 1, type: 'state', state: s.state, title: s.title, artist: s.artist, album: s.album,
    source: s.source, cover: coverForRelay(view.cover), position: s.position, duration: s.duration,
  };
}

// 内容が変わったらすぐ、変わらないときは 5 秒ごとに送る (サーバは 30 秒黙ると停止扱いにする)
function relayPublish(view, force) {
  if (!relayEnabled() || relayStatus !== 'connected' || !relayWin || relayWin.isDestroyed()) return;
  if (process.env.NP_NO_SEND === '1') return;
  const payload = relayPayload(view);
  if (remoteEnabled()) payload.control = true; // サーバに、操作を受け付けることを知らせる
  const key = JSON.stringify({ ...payload, position: 0 });
  const now = Date.now();
  if (!force && key === lastRelayKey && now - lastRelayAt < 5000) return;
  lastRelayKey = key;
  lastRelayAt = now;
  // 画像 (data URI) は大きいので、曲が変わったときと、つなぎ直したときだけ送る
  const coverKey = payload.cover.startsWith('data:') ? `${payload.title}\n${payload.artist}\n${payload.cover}` : '';
  const repeat = coverKey !== '' && coverKey === lastRelayCover;
  lastRelayCover = coverKey;
  relayWin.webContents.send('relay:send', repeat ? { ...payload, cover: '', keepCover: true } : payload);
}

// 設定に合わせて、通信係のウィンドウを作る / 閉じる / 宛先を変える
function applyRelay() {
  const alive = relayWin && !relayWin.isDestroyed();
  if (!relayEnabled()) {
    // ウィンドウごと閉じると、送信と受信の両方の接続が切れる
    if (alive) relayWin.destroy();
    relayWin = null;
    relayStatus = 'off';
    remoteState = null;
  } else if (!alive) {
    relayStatus = 'off';
    relayWin = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: path.join(__dirname, 'relay-preload.js'), contextIsolation: true, sandbox: true,
        backgroundThrottling: false,
      },
    });
    const created = relayWin;
    created.webContents.on('console-message', (e) => log('relay console:', e.message));
    created.webContents.on('did-finish-load', () => created.webContents.send('relay:config', { url: relayUrl() }));
    created.loadFile(path.join(__dirname, 'relay.html'));
  } else if (!relayWin.webContents.isLoading()) {
    relayWin.webContents.send('relay:config', { url: relayUrl() });
  }
  relayChanged();
}

// 実行役 (control.ps1) は、操作を受け付けるあいだだけ起動しておく
function applyRemote() {
  if (remoteEnabled()) controller.start(); else controller.stop();
}

function setRemote(on) {
  settings.remoteControl = !!on;
  saveSettings();
  applyRemote();
  updateTray();
  relayPublish(currentView(), true);
}

// サーバから届いた操作を実行して、結果を返す
async function handleCommand(message) {
  const id = String((message && message.id) || '').slice(0, 64);
  if (!id) return;
  const command = String(message.command || '');
  const result = remoteEnabled()
    ? await controller.run(command, currentView())
    : { ok: false, error: 'disabled' };
  log('command', command, JSON.stringify(result));
  if (relayWin && !relayWin.isDestroyed()) {
    relayWin.webContents.send('relay:send', { v: 1, type: 'result', id, ...result });
  }
  // 再生の状態が変わるのを少し待ってから、知らせ直す
  setTimeout(() => relayPublish(currentView(), true), 1500);
}

function relayChanged() {
  updateTray();
  sendToSettings('relay-status', relayLabel());
}

// 通信係のウィンドウ以外からの通知や、閉じたあとに届いた通知は無視する
const fromRelay = (event) => relayWin && !relayWin.isDestroyed() && event.sender === relayWin.webContents;

ipcMain.on('relay:status', (event, status) => {
  if (!fromRelay(event)) return;
  relayStatus = status;
  log('relay', status, relayUrl());
  relayChanged();
  if (status === 'connected') {
    lastRelayCover = '';
    relayPublish(currentView(), true);
  }
});
ipcMain.on('relay:sub-status', (event, status) => {
  if (!fromRelay(event)) return;
  log('relay (subscribe)', status);
  if (status !== 'connected') remoteState = null;
});
ipcMain.on('relay:command', (event, message) => {
  if (!fromRelay(event)) return;
  handleCommand(message);
});
ipcMain.on('relay:server-state', (event, state) => {
  if (!fromRelay(event)) return;
  remoteState = state;
  discord.update(discordSource());
});

// サーバの証明書に問題があるときは、つながない (記録だけ残す)
app.on('certificate-error', (_event, _webContents, url, error, _certificate, callback) => {
  console.error('[np] server certificate error:', error, url);
  callback(false);
});

// サーバがクライアント証明書を求めたら、Windows の証明書ストアから選ぶ。秘密鍵はファイルに出さない
app.on('select-client-certificate', (event, _webContents, _url, list, callback) => {
  event.preventDefault();
  const pick = settings.certIssuer && list.find((c) => (c.issuerName || '').includes(settings.certIssuer));
  log('client certificate:', pick ? `selected (${pick.subjectName})` : `none matched among ${list.length}`);
  if (pick) callback(pick); else callback();
});

function setRelay(enabled, address) {
  const url = normalizeServerUrl(address);
  if (!url) return { ok: false, error: '宛先を読み取れません。例: 192.168.1.10 または 192.168.1.10:8000' };
  const changed = url !== settings.serverUrl;
  settings.relay = !!enabled;
  settings.serverUrl = url;
  saveSettings();
  if (changed) {
    remoteState = null;
    if (relayStatus === 'connected') relayStatus = 'connecting';
  }
  applyRelay();
  applyRemote();
  pushState();
  return { ok: true, enabled: settings.relay, address: displayAddress(url), url };
}

function sendToSettings(channel, value) {
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send(channel, value);
}

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.show(); settingsWin.focus(); return; }
  settingsWin = new BrowserWindow({
    width: 380, height: Math.min(1100, screen.getPrimaryDisplay().workArea.height - 60), useContentSize: true, resizable: false, minimizable: false, maximizable: false, fullscreenable: false,
    title: 'NowPlaying 設定', backgroundColor: '#15161d', autoHideMenuBar: true, show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
  });
  settingsWin.setMenu(null);
  settingsWin.webContents.on('render-process-gone', (_e, d) => console.error('[np] settings renderer gone:', d.reason, d.exitCode));
  settingsWin.webContents.on('did-fail-load', (_e, code, desc) => console.error('[np] settings load failed:', code, desc));
  settingsWin.webContents.on('console-message', (e) => log('settings console:', e.message));
  // 起動時の表示指定 (非表示で起動した場合など) で最初の show が無視されることがあるので、念のため 2 回目も行う
  const reveal = () => { if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.show(); settingsWin.focus(); } };
  settingsWin.once('ready-to-show', reveal);
  setTimeout(() => { if (settingsWin && !settingsWin.isDestroyed() && !settingsWin.isVisible()) reveal(); }, 600);
  settingsWin.loadFile(path.join(__dirname, 'settings.html'));
  previewOn = true;
  pushState();
  settingsWin.on('closed', () => { settingsWin = null; previewOn = false; pushState(); });
}

// 配布版 (ポータブル exe) は、起動した exe 自身を登録する
const loginItem = () => (app.isPackaged ? { path: process.env.PORTABLE_EXECUTABLE_FILE || process.execPath } : null);

ipcMain.handle('settings:get', () => ({
  transparency: settings.transparency, blur: settings.blur,
  autostart: app.isPackaged && app.getLoginItemSettings(loginItem() || {}).openAtLogin,
  canAutostart: app.isPackaged,
  desktop: Object.fromEntries(APPS.map((a) => [a.key, !!settings[a.key]])),
  discord: settings.discord, discordAppId: settings.discordAppId,
  discordStatus: DISCORD_LABEL[discord.status] || discord.status,
  relay: settings.relay,
  serverAddress: displayAddress(settings.serverUrl),
  defaultAddress: displayAddress(DEFAULT_SERVER_URL),
  relayStatus: relayLabel(),
  remoteControl: settings.remoteControl,
  serverOverride: normalizeServerUrl(process.env.NP_SERVER) || '',
}));
ipcMain.handle('settings:set-relay', (_event, { enabled, address }) => setRelay(enabled, address));
ipcMain.on('settings:set-remote', (_event, on) => setRemote(on));
ipcMain.on('settings:set-discord', (_event, { enabled, appId }) => {
  settings.discord = !!enabled;
  settings.discordAppId = String(appId || '').trim().slice(0, 30);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveSettings, 300);
  discord.configure({ enabled: settings.discord, appId: settings.discordAppId });
});
ipcMain.on('settings:set-desktop', (_event, { key, on }) => {
  const source = desktop.find((d) => d.app.key === key);
  if (!source) return;
  settings[key] = !!on;
  if (settings[key]) source.start(); else source.stop();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveSettings, 300);
});
ipcMain.on('settings:set-autostart', (_event, on) => {
  if (app.isPackaged) app.setLoginItemSettings({ ...loginItem(), openAtLogin: !!on });
});
ipcMain.on('settings:set-blur', (_event, on) => {
  settings.blur = !!on;
  pushConfig();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveSettings, 300);
});
ipcMain.on('settings:set-transparency', (_event, value) => {
  settings.transparency = clampPercent(value);
  pushConfig();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveSettings, 300);
});

function applyVisibility(view) {
  if (!win || win.isDestroyed()) return;
  if ((forcedHidden && !previewOn) || !view) {
    clearTimeout(hideTimer); hideTimer = null;
    if (win.isVisible()) win.hide();
    return;
  }
  if (view.playing) {
    clearTimeout(hideTimer); hideTimer = null;
    if (!win.isVisible()) { win.showInactive(); win.moveTop(); }
  } else if (win.isVisible() && !hideTimer) {
    // 一時停止や停止のあと、少し待ってから隠す
    hideTimer = setTimeout(() => { hideTimer = null; if (win && !win.isDestroyed()) win.hide(); }, HIDE_DELAY_MS);
  }
}

function startServer() {
  const wss = new WebSocketServer({
    host: '127.0.0.1', port: PORT, maxPayload: 8 * 1024 * 1024,
    // ブラウザの拡張だけを受け付ける。普通のWebページからの接続は断る
    verifyClient: ({ origin }) => !origin || /^(chrome|moz|edge)-extension:\/\//.test(origin),
  });
  wss.on('listening', () => log(`listening on 127.0.0.1:${PORT}`));
  wss.on('error', (e) => { console.error('[np] server error:', e.message); updateTray(); });
  wss.on('connection', (ws) => {
    sockets.add(ws);
    ws.send(HANDSHAKE);
    updateTray();
    log('extension connected');
    ws.on('message', (data, isBinary) => {
      if (isBinary) wnp.handleBinary(Buffer.from(data));
      else wnp.handleText(data.toString('utf8'));
    });
    ws.on('close', () => {
      sockets.delete(ws);
      if (sockets.size === 0) wnp.clear();
      updateTray();
      log('extension disconnected');
    });
    ws.on('error', () => ws.terminate());
  });
}

function updateTray() {
  if (!tray) return;
  const connected = sockets.size > 0;
  tray.setToolTip(`NowPlaying (${connected ? '拡張と接続中' : '拡張の接続待ち'})`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `127.0.0.1:${PORT} で待ち受け (${connected ? `接続 ${sockets.size}` : '未接続'})`, enabled: false },
    { label: `Discord: ${DISCORD_LABEL[discord.status] || discord.status}`, enabled: false },
    { label: `サーバへの送信: ${relayLabel()}`, enabled: false },
    { type: 'separator' },
    { label: '設定…', click: openSettings },
    {
      label: 'サーバへ送信する', type: 'checkbox', checked: settings.relay,
      click: (item) => {
        setRelay(item.checked, settings.serverUrl);
        sendToSettings('relay-enabled', settings.relay);
      },
    },
    {
      label: 'サーバや Web からの操作を受け付ける', type: 'checkbox', checked: settings.remoteControl,
      enabled: settings.relay,
      click: (item) => { setRemote(item.checked); sendToSettings('remote-enabled', settings.remoteControl); },
    },
    {
      label: 'ウィジェットを隠す', type: 'checkbox', checked: forcedHidden,
      click: (item) => { forcedHidden = item.checked; pushState(); },
    },
    {
      label: 'クリックを通す (操作できなくなる)', type: 'checkbox', checked: settings.clickThrough,
      click: (item) => { settings.clickThrough = item.checked; saveSettings(); win.setIgnoreMouseEvents(item.checked, { forward: true }); },
    },
    {
      label: '位置を右上に戻す',
      click: () => { const p = defaultPosition(); win.setPosition(p.x, p.y); settings.x = p.x; settings.y = p.y; saveSettings(); },
    },
    { type: 'separator' },
    { label: '終了', click: () => app.quit() },
  ]));
}

app.on('second-instance', (_event, argv) => {
  if (argv.includes('--settings')) { openSettings(); return; }
  forcedHidden = false; pushState(); updateTray();
});

app.whenReady().then(() => {
  loadSettings();
  createWindow();
  tray = new Tray(nativeImage.createFromBuffer(trayIconPng(32)));
  tray.on('double-click', openSettings);
  updateTray();
  if (process.argv.includes('--settings')) openSettings();
  wnp.on('change', pushState);
  for (const source of desktop) {
    source.on('change', pushState);
    if (settings[source.app.key]) source.start();
  }
  // あとから出た最前面ウィンドウに隠されないよう、ときどき一番上へ戻す
  setInterval(() => { if (win && !win.isDestroyed() && win.isVisible()) win.moveTop(); }, 3000);
  // 再生位置は動き続けるので、変化がなくても 5 秒ごとに渡す
  setInterval(() => { relayPublish(currentView(), true); discord.update(discordSource()); }, 5000);
  applyRelay();
  applyRemote();
  discord.configure({ enabled: settings.discord, appId: settings.discordAppId });
  startServer();
});

app.on('window-all-closed', (e) => e.preventDefault());
app.on('before-quit', () => { for (const source of desktop) source.stop(); discord.close(); controller.stop(); if (relayWin && !relayWin.isDestroyed()) relayWin.destroy(); });
