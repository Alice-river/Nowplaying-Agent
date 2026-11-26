// 送信先の読み取り (relay-config.js) の確認
const assert = require('assert');
const { DEFAULT_SERVER_URL, normalizeServerUrl, displayAddress } = require('../relay-config');

const valid = [
  ['172.30.0.40', 'ws://172.30.0.40:8000/ws'],
  ['  192.168.1.10  ', 'ws://192.168.1.10:8000/ws'],
  ['192.168.1.10:9000', 'ws://192.168.1.10:9000/ws'],
  ['192.168.1.10:80', 'ws://192.168.1.10/ws'],
  ['nas.local', 'ws://nas.local:8000/ws'],
  ['fd00::1', 'ws://[fd00::1]:8000/ws'],
  ['[fd00::1]:9000', 'ws://[fd00::1]:9000/ws'],
  ['ws://172.30.0.40:8000/ws', 'ws://172.30.0.40:8000/ws'],
  ['ws://10.0.0.5', 'ws://10.0.0.5/ws'],
  ['wss://example.com/np/ws', 'wss://example.com/np/ws'],
  ['10.0.0.5/np/ws', 'ws://10.0.0.5:8000/np/ws'],
];
const invalid = [
  '', '   ', null, undefined, 'http://example.com/ws', 'file:///c:/x', '999.1.1.1', '172.30.40', '12345',
  '192.168.1.10:99999', '192.168.1.10:0', 'host with space', 'ws://user:pw@10.0.0.1/ws', '10.0.0.1/ws?x=1',
  'ws://10.0.0.1/other', '10.0.0.1\\ws', `${'a'.repeat(300)}.com`,
];

let count = 0;
for (const [input, expected] of valid) {
  assert.strictEqual(normalizeServerUrl(input), expected, `input: ${input}`);
  // 画面に出した形を入れ直しても、同じ宛先になる
  assert.strictEqual(normalizeServerUrl(displayAddress(expected)), expected, `round trip: ${input}`);
  count += 2;
}
for (const input of invalid) {
  assert.strictEqual(normalizeServerUrl(input), null, `should reject: ${input}`);
  count += 1;
}
assert.strictEqual(normalizeServerUrl(DEFAULT_SERVER_URL), DEFAULT_SERVER_URL);
assert.strictEqual(displayAddress(DEFAULT_SERVER_URL), '172.30.0.40:8000');
count += 2;

console.log(`relay-config: ${count} 項目すべて成功`);
