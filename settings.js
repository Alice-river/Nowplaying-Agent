const slider = document.getElementById('t');
const out = document.getElementById('v');
const blur = document.getElementById('blur');
const DEFAULT = 25;

function show(value) {
  slider.value = String(value);
  out.textContent = `${value}%`;
}

slider.addEventListener('input', () => {
  const value = Number(slider.value);
  out.textContent = `${value}%`;
  window.np.setTransparency(value);
});

const auto = document.getElementById('auto');
auto.addEventListener('change', () => window.np.setAutostart(auto.checked));

blur.addEventListener('change', () => window.np.setBlur(blur.checked));

document.getElementById('reset').addEventListener('click', () => {
  show(DEFAULT);
  blur.checked = true;
  window.np.setTransparency(DEFAULT);
  window.np.setBlur(true);
});

// data-app は smtc.js の APPS の key
const desktopChecks = document.querySelectorAll('input[data-app]');
for (const box of desktopChecks) {
  box.addEventListener('change', () => window.np.setDesktop(box.dataset.app, box.checked));
}

const dcOn =document.getElementById('dc-on');
const dcId = document.getElementById('dc-id');
const dcStatus = document.getElementById('dc-status');
let dcTimer = null;

function sendDiscord() {
  clearTimeout(dcTimer);
  dcTimer = setTimeout(() => window.np.setDiscord(dcOn.checked, dcId.value.trim()), 400);
}
dcOn.addEventListener('change', sendDiscord);
dcId.addEventListener('input', sendDiscord);
window.np.onDiscordStatus((label) => { dcStatus.textContent = `状態: ${label}`; });

const rlOn = document.getElementById('rl-on');
const rlAddr = document.getElementById('rl-addr');
const rlError = document.getElementById('rl-error');
const rlStatus = document.getElementById('rl-status');
let rlSaved = '';
let rlDefault = '';

// 宛先は、入力の途中でつなぎ直さないように、「適用」か Enter、チェックの切り替えで反映する
async function applyRelay(address) {
  const result = await window.np.setRelay(rlOn.checked, address);
  if (result.ok) {
    rlSaved = result.address;
    rlAddr.value = result.address;
    rlError.textContent = '';
  } else {
    rlError.textContent = result.error;
  }
  return result.ok;
}
rlOn.addEventListener('change', async () => {
  // 入力中の宛先が読み取れないときは、保存済みの宛先のまま切り替える
  if (!await applyRelay(rlAddr.value)) {
    const message = rlError.textContent;
    await applyRelay(rlSaved);
    rlError.textContent = message;
  }
});
document.getElementById('rl-apply').addEventListener('click', () => applyRelay(rlAddr.value));
rlAddr.addEventListener('keydown', (e) => { if (e.key === 'Enter') applyRelay(rlAddr.value); });
document.getElementById('rl-default').addEventListener('click', () => applyRelay(rlDefault));
window.np.onRelayStatus((label) => { rlStatus.textContent = `状態: ${label}`; });
window.np.onRelayEnabled((on) => { rlOn.checked = on; });

const ssOn = document.getElementById('ss-on');
ssOn.addEventListener('change', () => window.np.setSkipSpotify(ssOn.checked));

const rcOn = document.getElementById('rc-on');
rcOn.addEventListener('change', () => window.np.setRemote(rcOn.checked));
// 送信がオフのあいだは、操作も受け付けないので、切り替えられないようにする
rlOn.addEventListener('change', () => { rcOn.disabled = !rlOn.checked; });
window.np.onRemoteEnabled((on) => { rcOn.checked = on; });
window.np.onRelayEnabled((on) => { rcOn.disabled = !on; });

window.np.getSettings().then((s) => {
  show(s.transparency);
  blur.checked = s.blur;
  auto.checked = s.autostart;
  auto.disabled = !s.canAutostart; // 開発中 (exe でないとき) は変えられない
  for (const box of desktopChecks) box.checked = s.desktop[box.dataset.app];
  dcOn.checked = s.discord;
  dcId.value = s.discordAppId;
  dcStatus.textContent = `状態: ${s.discordStatus}`;
  rlOn.checked = s.relay;
  ssOn.checked = s.skipSpotifyStats;
  rcOn.checked = s.remoteControl;
  rcOn.disabled = !s.relay;
  rlSaved = s.serverAddress;
  rlDefault = s.defaultAddress;
  rlAddr.value = s.serverAddress;
  rlStatus.textContent = `状態: ${s.relayStatus}`;
  if (s.serverOverride) rlError.textContent = `環境変数 NP_SERVER の宛先 (${s.serverOverride}) を使っています。`;
});
