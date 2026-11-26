// サーバへの送信先を、決まった形 (ws://ホスト:ポート/ws) にそろえる。
// 入力は「IP アドレス」「IP アドレス:ポート」「ホスト名」「ws:// や wss:// で始まる URL」のどれでもよい。
const DEFAULT_SERVER_URL = 'ws://172.30.0.40:8000/ws';
const DEFAULT_PORT = '8000';

function normalizeServerUrl(input) {
  let text = String(input ?? '').trim();
  if (!text || text.length > 200 || /\s|\\/.test(text)) return null;
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text);
  if (!hasScheme) {
    // かっこの無い IPv6 アドレスは、かっこを付ける
    if (!text.startsWith('[') && !text.includes('/') && text.split(':').length > 2) text = `[${text}]`;
    text = `ws://${text}`;
  }
  const authority = text.slice(text.indexOf('://') + 3).split(/[/?#]/)[0];
  const rawHost = authority.startsWith('[') ? authority.slice(0, authority.indexOf(']') + 1) : authority.split(':')[0];
  // 数字とドットだけなら IPv4。省略形 (172.30.40 など) は、打ち間違いとして断る
  if (/^[0-9.]+$/.test(rawHost) && !/^(\d{1,3}\.){3}\d{1,3}$/.test(rawHost)) return null;

  let url;
  try { url = new URL(text); } catch { return null; }
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') return null;
  if (!url.hostname || url.username || url.password || url.search || url.hash) return null;
  // 形式を省略したときは、ポートも省略できる (このサーバの既定は 8000)
  if (!hasScheme && !/:\d+$/.test(authority)) url.port = DEFAULT_PORT;
  if (url.port === '0') return null;
  if (url.pathname === '/') url.pathname = '/ws';
  if (!url.pathname.endsWith('/ws')) return null;
  return url.href;
}

// 設定画面に出す短い形。normalizeServerUrl に渡すと、同じ URL に戻る
function displayAddress(serverUrl) {
  let url;
  try { url = new URL(serverUrl); } catch { return String(serverUrl || ''); }
  if (url.protocol !== 'ws:' || url.pathname !== '/ws') return url.href;
  return `${url.hostname}:${url.port || '80'}`;
}

// 「Spotify は統計に記録しない」がオンのとき、取得元が Spotify (デスクトップアプリと Web 版) の曲は
// 記録の対象から外す。表示と操作のために、状態そのものはサーバへ送る
function statsExcluded(settings, source) {
  return !!(settings && settings.skipSpotifyStats) && /^spotify\b/i.test(String(source || '').trim());
}

module.exports = { DEFAULT_SERVER_URL, DEFAULT_PORT, normalizeServerUrl, displayAddress, statsExcluded };
