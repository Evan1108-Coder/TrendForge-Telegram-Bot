'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const { WatchManager } = require('../src/watch');

// Each manager gets its own temp JSON file so tests never touch real watches.json.
function tmpFile(tag) {
  return path.join(os.tmpdir(), `trendforge-watch-${process.pid}-${tag}.json`);
}

function fakeBot() {
  const sent = [];
  return { sent, api: { async sendMessage(chatId, text) { sent.push({ chatId, text }); } } };
}

async function until(pred, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return true;
    await new Promise(r => setTimeout(r, 10));
  }
  return pred();
}

test('a watch that fires delivers a heads-up and is recorded as fired', async () => {
  const file = tmpFile('fire');
  try { fs.unlinkSync(file); } catch {}
  const bot = fakeBot();
  const wm = new WatchManager(bot, { file });
  let polls = 0;
  wm.registerProbe('test-fire', async () => { polls += 1; return { done: polls >= 3 }; });

  const { id } = wm.startWatch({ chatId: 42, label: '“rust” to trend', kind: 'test-fire', intervalMs: 5, totalMs: 60000 });
  assert.ok(id > 0);
  await until(() => bot.sent.length > 0);
  assert.match(bot.sent[0].text, /it happened/i);
  const row = wm.listWatches(42)[0];
  assert.equal(row.status, 'fired');
});

test('ADVERSARIAL: a watch whose event never happens times out (never runs forever)', async () => {
  const file = tmpFile('never');
  try { fs.unlinkSync(file); } catch {}
  const bot = fakeBot();
  const wm = new WatchManager(bot, { file });
  wm.registerProbe('never', async () => ({ done: false }));

  wm.startWatch({ chatId: 42, label: 'the impossible', kind: 'never', intervalMs: 5, totalMs: 60 });
  await until(() => bot.sent.length > 0, 3000);
  assert.match(bot.sent[0].text, /keep watching|nothing|budget/i);
});

test('stopWatch aborts an active watch and sends no ping', async () => {
  const file = tmpFile('stop');
  try { fs.unlinkSync(file); } catch {}
  const bot = fakeBot();
  const wm = new WatchManager(bot, { file });
  wm.registerProbe('slow', async () => { await new Promise(r => setTimeout(r, 50)); return { done: false }; });
  const { id } = wm.startWatch({ chatId: 42, label: 'stop me', kind: 'slow', intervalMs: 20, totalMs: 60000 });
  wm.stopWatch(id);
  await new Promise(r => setTimeout(r, 100));
  const row = wm.listWatches(42).find(w => w.id === id);
  assert.equal(row.status, 'stopped');
  assert.equal(bot.sent.length, 0);
});

test('watch is opt-in: nothing starts until startWatch is called', () => {
  const file = tmpFile('optin');
  try { fs.unlinkSync(file); } catch {}
  const wm = new WatchManager(fakeBot(), { file });
  wm.registerProbe('x', async () => ({ done: true }));
  assert.equal(wm.activeCount(), 0);
  assert.equal(wm.listWatches(1).length, 0);
});

test('startWatch throws for an unregistered probe kind', () => {
  const wm = new WatchManager(fakeBot(), { file: tmpFile('unreg') });
  assert.throws(() => wm.startWatch({ chatId: 1, label: 'x', kind: 'nope' }), /No watch probe/);
});

test('watches persist to JSON and survive a fresh manager (resume)', async () => {
  const file = tmpFile('persist');
  try { fs.unlinkSync(file); } catch {}
  // Manager A inserts an already-expired active watch by hand.
  const a = new WatchManager(fakeBot(), { file });
  a.registerProbe('resumable', async () => ({ done: false }));
  const data = { entries: [{ id: 1, chatId: '42', label: 'left over', kind: 'resumable', params: {}, status: 'active', pollsDone: 0, maxPolls: 20, intervalMs: 5, deadlineAt: new Date(Date.now() - 1000).toISOString() }], seq: 1 };
  fs.writeFileSync(file, JSON.stringify(data), 'utf8');

  const bot = fakeBot();
  const b = new WatchManager(bot, { file });
  b.registerProbe('resumable', async () => ({ done: false }));
  const { resumed } = b.resumeWatches();
  assert.equal(resumed, 0, 'expired one is closed out, not resumed');
  await until(() => bot.sent.length > 0);
  assert.match(bot.sent[0].text, /keep watching|nothing|budget/i);
});

test('concurrency cap prevents unbounded parallel watches', () => {
  const file = tmpFile('cap');
  try { fs.unlinkSync(file); } catch {}
  const wm = new WatchManager(fakeBot(), { file, maxConcurrent: 2 });
  wm.registerProbe('hold', async () => { await new Promise(r => setTimeout(r, 500)); return { done: false }; });
  wm.startWatch({ chatId: 1, label: 'a', kind: 'hold', intervalMs: 50, totalMs: 60000 });
  wm.startWatch({ chatId: 1, label: 'b', kind: 'hold', intervalMs: 50, totalMs: 60000 });
  assert.throws(() => wm.startWatch({ chatId: 1, label: 'c', kind: 'hold', intervalMs: 50, totalMs: 60000 }), /Too many/);
});
