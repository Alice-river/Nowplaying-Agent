// サーバとの通信係。画面の無いウィンドウの中で、Chromium の WebSocket を使う。
// こうすると、wss:// の宛先で、Windows の証明書ストアにある (秘密鍵を取り出せない)
// クライアント証明書を、ブラウザと同じ仕組みでそのまま使える。
//   /ws   送信: この PC の再生状態をサーバへ送る。サーバからは、操作の指示を受け取る
//   /sub  受信: サーバが持つ今の状態を受け取る (この PC が再生していないときの Discord 表示に使う)
// このウィンドウは、設定で「サーバへ送る」がオンのあいだだけ作られる。
let baseUrl = '';

// Chromium の WebSocket は、クライアント証明書を自分では選べない。
// 同じサーバへ先に普通の HTTPS で 1 回つなぐと、そこで選ばれた証明書が覚えられ、WebSocket でも使われる。
async function warmUp() {
  // ws:// は TLS もクライアント証明書も使わないので、事前の接続は要らない
  if (!/^wss:/.test(baseUrl)) return;
  await fetch(baseUrl.replace(/^wss:/, 'https:').replace(/\/ws$/, '/state'), { mode: 'no-cors', cache: 'no-store' });
}

function makeConnection({ path, onStatus, onMessage }) {
  let socket = null;
  let retry = 0;
  let timer = null;
  let generation = 0;

  function schedule() {
    // 1 秒から始めて、最大 30 秒まで間隔を延ばして再接続する
    retry = Math.min(retry + 1, 6);
    timer = setTimeout(connect, Math.min(30000, 1000 * 2 ** (retry - 1)));
  }

  async function connect() {
    clearTimeout(timer);
    if (!baseUrl) return;
    const mine = ++generation;
    onStatus('connecting');
    try {
      await warmUp();
    } catch (e) {
      if (mine === generation) { onStatus('error'); schedule(); }
      return;
    }
    if (mine !== generation) return;
    let ws;
    try {
      ws = new WebSocket(baseUrl.replace(/\/ws$/, path));
    } catch (e) {
      onStatus('error');
      return schedule();
    }
    socket = ws;
    ws.onopen = () => { retry = 0; onStatus('connected'); };
    ws.onmessage = (event) => { if (onMessage) onMessage(event.data); };
    ws.onclose = () => {
      if (socket === ws) socket = null;
      if (mine !== generation) return;
      onStatus('disconnected');
      schedule();
    };
    ws.onerror = () => {};
  }

  return {
    restart() {
      generation++;
      clearTimeout(timer);
      retry = 0;
      if (socket) { const old = socket; socket = null; old.onclose = null; old.onmessage = null; old.close(); }
      connect();
    },
    send(text) {
      if (socket && socket.readyState === WebSocket.OPEN) { socket.send(text); return true; }
      return false;
    },
  };
}

const sender = makeConnection({
  path: '/ws',
  onStatus: (s) => window.relay.status(s),
  // この接続でサーバから届くのは、操作の指示だけ
  onMessage: (text) => {
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    if (msg && msg.type === 'command') window.relay.command({ id: msg.id, command: msg.command });
  },
});
const receiver = makeConnection({
  path: '/sub',
  onStatus: (s) => window.relay.subStatus(s),
  onMessage: (text) => {
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    if (msg && msg.type === 'state') window.relay.serverState(msg);
  },
});

window.relay.onConfig((config) => {
  if (config.url === baseUrl) return;
  baseUrl = config.url;
  sender.restart();
  receiver.restart();
});

window.relay.onSend((payload) => {
  sender.send(JSON.stringify(payload));
});
