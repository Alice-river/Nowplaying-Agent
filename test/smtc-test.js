// デスクトップアプリの読み取り (smtc.js) の確認。PowerShell は起動せず、読み取り結果の行を直接渡す
const assert = require('assert');
const { APPS, SmtcSource, pickView } = require('../smtc');

let count = 0;
const equal = (actual, expected, name) => { assert.deepStrictEqual(actual, expected, name); count += 1; };
const app = (key) => APPS.find((a) => a.key === key);
const line = (o) => `${JSON.stringify({ running: true, playing: true, title: 'T', artist: 'A', album: 'L', position: 10, duration: 200, ...o })}\n`;

// 優先順位の並びと、サーバへ送る source
equal(APPS.map((a) => a.source), ['Spotify', 'Apple Music'], 'sources');

// SourceAppUserModelId の判定。PowerShell の -match と同じく、大文字小文字は区別しない
const matches = (key, id) => new RegExp(app(key).match, 'i').test(id);
const SPOTIFY_ID = 'SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify';
const APPLE_ID = 'AppleInc.AppleMusicWin_nzyj5cx40ttqa!App';
equal(matches('spotify', SPOTIFY_ID), true, 'spotify id');
equal(matches('spotify', APPLE_ID), false, 'spotify does not take apple');
equal(matches('appleMusic', APPLE_ID), true, 'apple id');
equal(matches('appleMusic', SPOTIFY_ID), false, 'apple does not take spotify');
// ブラウザに入れた Web 版の Apple Music (PWA) は、デスクトップアプリとして扱わない
equal(matches('appleMusic', 'Chrome._crx_blgdilankhlgpdndahbehalgkh'), false, 'web app');

// 読み取り結果が view() になる。行が分かれて届いてもよい
const spotify = new SmtcSource(app('spotify'));
let changes = 0;
spotify.on('change', () => { changes += 1; });
equal(spotify.view(), null, 'no data');
const first = line({ cover: 'data:image/png;base64,AA==' });
spotify.onData(first.slice(0, 7));
spotify.onData(first.slice(7));
const v = spotify.view();
equal({ ...v, at: 0 }, {
  playing: true, state: 0, title: 'T', artist: 'A', album: 'L', source: 'Spotify', app: 'spotify',
  cover: 'data:image/png;base64,AA==', position: 10, duration: 200, at: 0,
}, 'view');
spotify.onData(line({}));
equal([changes, spotify.view().cover], [1, v.cover], 'unchanged line keeps cover, no change event');
spotify.onData(line({ playing: false }));
equal([changes, spotify.view().state], [2, 1], 'paused');
spotify.onData(line({ title: 'T2', position: 0 }));
equal([changes, spotify.view().cover], [3, ''], 'new track drops old cover');
spotify.onData('broken\n');
spotify.onData(line({ title: '', artist: '' }));
equal([changes, spotify.view()], [4, null], 'no track info');
spotify.onData(line({}));
spotify.onData('{"running":false}\n');
equal([changes, spotify.view()], [6, null], 'app closed');

// オフにすると、すぐに表示から外れる
spotify.onData(line({}));
spotify.stop();
equal([changes, spotify.view()], [8, null], 'stop clears view');

// 優先順位
const playing = (source) => ({ source, playing: true });
const paused = (source) => ({ source, playing: false });
const picked = (desktop, web) => { const r = pickView(desktop, web); return r && `${r.source}:${r.playing}`; };
equal(picked([playing('Spotify'), playing('Apple Music')], playing('Web')), 'Spotify:true', 'all playing');
equal(picked([paused('Spotify'), playing('Apple Music')], playing('Web')), 'Apple Music:true', 'playing desktop wins');
equal(picked([playing('Spotify'), paused('Apple Music')], null), 'Spotify:true', 'playing spotify wins');
equal(picked([paused('Spotify'), paused('Apple Music')], playing('Web')), 'Web:true', 'playing web over paused desktop');
equal(picked([null, paused('Apple Music')], playing('Web')), 'Web:true', 'playing web over paused apple');
equal(picked([null, playing('Apple Music')], playing('Web')), 'Apple Music:true', 'playing desktop over playing web');
equal(picked([paused('Spotify'), paused('Apple Music')], paused('Web')), 'Spotify:false', 'paused desktop over paused web');
equal(picked([null, paused('Apple Music')], paused('Web')), 'Apple Music:false', 'paused apple over paused web');
equal(picked([paused('Spotify'), null], null), 'Spotify:false', 'paused desktop only');
equal(picked([null, playing('Apple Music')], null), 'Apple Music:true', 'apple only');
equal(picked([null, null], playing('Web')), 'Web:true', 'web only');
equal(picked([null, null], paused('Web')), 'Web:false', 'paused web only');
equal(picked([null, null], null), null, 'nothing');

console.log(`smtc: ${count} 項目すべて成功`);
