// 操作の受け付け (control.js) の確認。実行役は偽物にして、再生には触れない
const assert = require('assert');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const { COMMANDS, TARGETS, targetList, preferred, Controller } = require('../control');

let passed = 0;
const ok = (name) => { passed++; console.log('PASS', name); };

function fakeHelper(reply) {
  const proc = new EventEmitter();
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.requests = [];
  proc.killed = false;
  proc.kill = () => { proc.killed = true; proc.emit('exit'); };
  let buf = '';
  proc.stdin.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const request = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      proc.requests.push(request);
      const answer = reply(request);
      if (answer !== undefined) proc.stdout.write(`${answer}\n`);
    }
  });
  return proc;
}

(async () => {
  assert.deepStrictEqual(COMMANDS, ['play', 'pause', 'next', 'previous', 'volume_up', 'volume_down']);
  assert.deepStrictEqual(preferred(null, TARGETS), []);
  assert.deepStrictEqual(preferred({ app: 'spotify', source: 'Spotify' }, TARGETS), ['spotify']);
  assert.strictEqual(preferred({ app: 'appleMusic' }, TARGETS).length, 1);
  const browsers = preferred({ source: 'Spotify' }, TARGETS); // ブラウザ版の Spotify はブラウザを優先
  assert.ok(browsers.includes('^chrome') && !browsers.includes('spotify'));
  assert.ok(new RegExp(TARGETS[1].match, 'i').test('AppleInc.AppleMusicWin_nzyj5cx40ttqa!App'));
  assert.deepStrictEqual(targetList({}), TARGETS);
  assert.deepStrictEqual(targetList({ NP_CONTROL_ONLY: 'test', NP_CONTROL_PROCESS: 'p' }), [{ match: 'test', processes: ['p'] }]);
  ok('対象の選び方');

  let helper;
  let launches = 0;
  const controller = new Controller({
    timeout: 300,
    launch: () => {
      launches++;
      helper = fakeHelper((r) => {
        if (r.command === 'next') return JSON.stringify({ id: r.id, ok: true });
        if (r.command === 'volume_up') return `garbage\n${JSON.stringify({ id: r.id, ok: true, volume: 60, extra: 'x' })}`;
        if (r.command === 'previous') return JSON.stringify({ id: r.id, ok: false, error: 'no_session' });
        return undefined; // 返事をしない
      });
      return helper;
    },
  });
  assert.deepStrictEqual(await controller.run('format c:', null), { ok: false, error: 'unknown' });
  assert.strictEqual(launches, 0);
  ok('知らない操作は、実行役に渡さない');
  assert.deepStrictEqual(await controller.run('next', { app: 'spotify' }), { ok: true });
  assert.deepStrictEqual(helper.requests[0].prefer, ['spotify']);
  assert.deepStrictEqual(await controller.run('volume_up', null), { ok: true, volume: 60 });
  assert.deepStrictEqual(await controller.run('previous', null), { ok: false, error: 'no_session' });
  assert.strictEqual(launches, 1);
  ok('依頼と返事の対応。実行役は 1 つを使い回す');

  const first = helper;
  assert.deepStrictEqual(await controller.run('pause', null), { ok: false, error: 'timeout' });
  assert.ok(first.killed);
  assert.deepStrictEqual(await controller.run('next', null), { ok: true });
  assert.strictEqual(launches, 2);
  ok('返事が無いと時間切れにして、次は作り直す');

  const waiting = [1, 2, 3, 4].map(() => controller.run('play', null));
  assert.deepStrictEqual(await controller.run('play', null), { ok: false, error: 'busy' });
  controller.stop();
  for (const result of await Promise.all(waiting)) assert.deepStrictEqual(result, { ok: false, error: 'disabled' });
  assert.ok(helper.killed);
  ok('同時の依頼は 4 件まで。止めると、待っている依頼は断る');

  console.log(`ALL PASS (${passed})`);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
