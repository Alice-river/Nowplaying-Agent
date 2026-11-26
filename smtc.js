const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const path = require('path');

// デスクトップアプリの再生情報を、Windows の SMTC から読む (OBSSpotifyPlugin と同じ方式)。
// 実際の読み取りは smtc.ps1 (WinRT) がアプリごとに行い、1 秒ごとに 1 行の JSON を返す。
// view() は wnp.js の view() と同じ形。アプリが動いていなければ null。
const STATE = { PLAYING: 0, PAUSED: 1, STOPPED: 2 };
const RESTART_MS = 5000;

// 読み取れるアプリ。並び順が、同時に再生しているときの優先順位。
// key は設定の項目名、source はサーバや Discord に出す名前、match は SMTC の SourceAppUserModelId の正規表現
const APPS = [
  { key: 'spotify', source: 'Spotify', match: 'spotify' },
  { key: 'appleMusic', source: 'Apple Music', match: '^AppleInc\\.AppleMusicWin_' },
];

// 出すものを選ぶ。順は、再生中のデスクトップアプリ、再生中のブラウザ (web)、
// 停止中のデスクトップアプリ、停止中のブラウザ。デスクトップアプリ同士が同じ状態なら並び順
function pickView(desktopViews, webView) {
  const found = desktopViews.filter(Boolean);
  return found.find((v) => v.playing)
    || (webView && webView.playing ? webView : found[0] || webView);
}

class SmtcSource extends EventEmitter {
  constructor(app, { log = () => {} } = {}) {
    super();
    this.app = app;
    this.log = log;
    this.proc = null;
    this.restartTimer = null;
    this.buf = '';
    this.info = null;      // 直近の読み取り (running のときだけ)
    this.cover = '';
    this.at = 0;
    this.lastKey = '';
  }

  start() {
    if (process.platform !== 'win32' || this.proc) return;
    clearTimeout(this.restartTimer);
    this.buf = '';
    // 配布版 (asar) では、powershell が読めるよう展開済みのほうを使う
    const script = path.join(__dirname, 'smtc.ps1').replace(/app\.asar([\\\\/])/, 'app.asar.unpacked$1');
    const proc = spawn('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Match', this.app.match],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this.proc = proc;
    // 止めたあとや、起動し直したあとに届く古いプロセスの通知は無視する
    const current = () => this.proc === proc;
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (d) => { if (current()) this.onData(d); });
    proc.stderr.on('data', (d) => this.log(this.app.key, 'stderr', String(d).trim()));
    proc.on('error', (e) => this.log(this.app.key, 'spawn failed', e.message));
    proc.on('exit', () => {
      if (!current()) return;
      this.proc = null;
      this.setInfo(null);
      this.restartTimer = setTimeout(() => this.start(), RESTART_MS);
    });
  }

  stop() {
    clearTimeout(this.restartTimer);
    const proc = this.proc;
    this.proc = null;
    if (proc) proc.kill();
    this.setInfo(null);
  }

  onData(chunk) {
    this.buf += chunk;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      try { this.setInfo(JSON.parse(line)); } catch { /* 壊れた行は捨てる */ }
    }
  }

  setInfo(msg) {
    const now = Date.now();
    if (!msg || !msg.running) {
      if (this.info) { this.info = null; this.cover = ''; this.lastKey = ''; this.emit('change'); }
      return;
    }
    if (!msg.title && !msg.artist) { // 曲の情報がまだ無い
      if (this.info) { this.info = null; this.emit('change'); }
      return;
    }
    const key = `${msg.title}\n${msg.artist}\n${msg.album}`;
    const trackChanged = key !== this.lastKey;
    if (trackChanged) { this.lastKey = key; this.cover = ''; }
    if (msg.cover) this.cover = msg.cover;

    const prev = this.info;
    // SMTC の位置は、再生中でも変化があったときしか更新されない。
    // 値が前回と同じなら基準 (position と at) は据え置き、経過は view() 側で足す
    if (prev && !trackChanged && prev.playing === msg.playing && prev.rawPosition === msg.position && !msg.cover) return;
    const elapsed = prev && prev.playing ? (now - this.at) / 1000 : 0;
    const expected = prev ? prev.position + elapsed : 0;
    const changed = trackChanged || !prev || prev.playing !== msg.playing
      || Math.abs(msg.position - expected) > 2.5 || !!msg.cover;
    this.info = { ...msg, rawPosition: msg.position };
    this.at = now;
    if (changed) this.emit('change');
  }

  view() {
    const p = this.info;
    if (!p) return null;
    return {
      playing: !!p.playing,
      state: p.playing ? STATE.PLAYING : STATE.PAUSED,
      title: p.title,
      artist: p.artist,
      album: p.album,
      source: this.app.source,
      app: this.app.key, // 操作の対象を選ぶのに使う (ブラウザの view には無い)
      cover: this.cover,
      position: p.position,
      duration: p.duration,
      at: this.at,
    };
  }
}

module.exports = { APPS, SmtcSource, pickView };
