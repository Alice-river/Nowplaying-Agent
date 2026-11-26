// サーバや Web から届いた操作を実行する。実際の操作は control.ps1 が行う。
//   再生・停止・次へ・戻る  Windows の SMTC (メディア操作)
//   音量                    再生中のアプリだけの音量 (Windows の音量ミキサー)
const { spawn } = require('child_process');
const path = require('path');

const COMMANDS = ['play', 'pause', 'next', 'previous', 'volume_up', 'volume_down'];
const TIMEOUT_MS = 8000;
const MAX_PENDING = 4;

// 操作できるアプリ。match は SMTC の SourceAppUserModelId の正規表現、processes は音を出すプロセスの名前。
// key はデスクトップアプリの設定の項目名 (smtc.js の APPS)。key の無いものはブラウザ
const TARGETS = [
  { key: 'spotify', match: 'spotify', processes: ['Spotify'] },
  { key: 'appleMusic', match: '^AppleInc\\.AppleMusicWin_', processes: ['AppleMusic'] },
  { match: '^chrome', processes: ['chrome'] },
  { match: '^msedge', processes: ['msedge'] },
  { match: '^brave', processes: ['brave'] },
  { match: '^vivaldi', processes: ['vivaldi'] },
  { match: 'opera', processes: ['opera'] },
  { match: '308046B0AF4A39CB|firefox', processes: ['firefox'] },
];

// 確認用: 対象を 1 つのアプリに限る (普段使いの再生に触れずに試せる)
function targetList(env = process.env) {
  if (!env.NP_CONTROL_ONLY) return TARGETS;
  return [{ match: env.NP_CONTROL_ONLY, processes: [env.NP_CONTROL_PROCESS || 'electron'] }];
}

// いま出している曲のアプリを優先する。desktop の view には app (key) があり、ブラウザの view には無い
function preferred(view, targets) {
  if (!view) return [];
  const chosen = view.app ? targets.filter((t) => t.key === view.app) : targets.filter((t) => !t.key);
  return chosen.map((t) => t.match);
}

class Controller {
  constructor({ log = () => {}, launch = null, timeout = TIMEOUT_MS } = {}) {
    this.log = log;
    this.timeout = timeout;
    this.launch = launch || (() => spawn('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
        // 配布版 (asar) では、powershell が読めるよう展開済みのほうを使う
        path.join(__dirname, 'control.ps1').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }));
    this.proc = null;
    this.buf = '';
    this.pending = new Map();
    this.nextId = 0;
  }

  start() {
    if (this.proc) return;
    const proc = this.launch();
    this.proc = proc;
    this.buf = '';
    const current = () => this.proc === proc;
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (d) => { if (current()) this.onData(d); });
    proc.stderr.on('data', (d) => this.log('control stderr', String(d).trim()));
    proc.stdin.on('error', (e) => this.log('control stdin', e.message));
    const gone = () => {
      if (!current()) return;
      this.proc = null;
      this.finishAll('failed');
    };
    proc.on('error', (e) => { this.log('control spawn failed', e.message); gone(); });
    proc.on('exit', gone);
  }

  stop() {
    const proc = this.proc;
    this.proc = null;
    if (proc) proc.kill();
    this.finishAll('disabled');
  }

  finishAll(error) {
    for (const done of [...this.pending.values()]) done({ ok: false, error });
  }

  onData(chunk) {
    this.buf += chunk;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const done = this.pending.get(msg.id);
      if (!done) continue;
      const result = { ok: msg.ok === true };
      if (typeof msg.error === 'string' && msg.error) result.error = msg.error;
      if (Number.isInteger(msg.volume)) result.volume = msg.volume;
      done(result);
    }
  }

  // command を実行して { ok, error?, volume? } を返す。例外は投げない
  run(command, view) {
    if (!COMMANDS.includes(command)) return Promise.resolve({ ok: false, error: 'unknown' });
    if (this.pending.size >= MAX_PENDING) return Promise.resolve({ ok: false, error: 'busy' });
    this.start();
    const id = ++this.nextId;
    const targets = targetList();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        // 返事が無いときは、実行役を作り直す
        finish({ ok: false, error: 'timeout' });
        const proc = this.proc;
        this.proc = null;
        if (proc) proc.kill();
      }, this.timeout);
      const finish = (result) => {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve(result);
      };
      this.pending.set(id, finish);
      const request = {
        id, command, prefer: preferred(view, targets),
        targets: targets.map((t) => ({ match: t.match, processes: t.processes })),
      };
      try { this.proc.stdin.write(`${JSON.stringify(request)}\n`); } catch { finish({ ok: false, error: 'failed' }); }
    });
  }
}

module.exports = { COMMANDS, TARGETS, targetList, preferred, Controller };
