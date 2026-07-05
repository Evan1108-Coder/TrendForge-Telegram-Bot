'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyComplexity, StagedStatus, maybeStaged } = require('../src/utils/staged');

function fakeCtx() {
  const calls = { replies: [], edits: [] };
  let nextId = 100;
  return {
    calls,
    chat: { id: 42 },
    async reply(text) {
      const message_id = nextId++;
      calls.replies.push({ text, message_id });
      return { message_id, chat: { id: 42 } };
    },
    api: {
      async editMessageText(chatId, messageId, text) {
        calls.edits.push({ chatId, messageId, text });
        return true;
      },
    },
  };
}

test('greetings and thanks are trivial (no status line)', () => {
  for (const t of ['hi', 'Hello', 'thanks', 'thank you!', 'ok', 'got it', '👍']) {
    assert.equal(classifyComplexity(t).complex, false, `${t} should be trivial`);
  }
});

test('trend/report requests are complex (staged status)', () => {
  for (const t of [
    'give me a trend report',
    'scrape github trending',
    'what is trending on hacker news',
    'summarize today\'s ai news',
    'schedule a daily digest',
    'research rust web frameworks',
  ]) {
    assert.equal(classifyComplexity(t).complex, true, `${t} should be complex`);
  }
});

test('short plain questions are trivial', () => {
  assert.equal(classifyComplexity('who are you').complex, false);
  assert.equal(classifyComplexity('what can you do?').complex, false);
});

test('maybeStaged returns null for trivial, a StagedStatus for complex', () => {
  assert.equal(maybeStaged(fakeCtx(), 'hi').staged, null);
  assert.ok(maybeStaged(fakeCtx(), 'scrape github trending').staged instanceof StagedStatus);
});

test('StagedStatus owns ONE message id and edits it in place (plain text)', async () => {
  const ctx = fakeCtx();
  const s = new StagedStatus(ctx);
  await s.stage('🧠 thinking');
  await s.stage('🔍 scraping', 'picked the sources');
  await s.done('report ready');

  assert.equal(ctx.calls.replies.length, 1);
  const id = ctx.calls.replies[0].message_id;
  assert.ok(ctx.calls.edits.length >= 2);
  for (const e of ctx.calls.edits) assert.equal(e.messageId, id);
  // Plain text: no HTML tags leak into the rendered message.
  for (const e of ctx.calls.edits) assert.doesNotMatch(e.text, /<\/?[a-z]/i);
});

test('each new stage carries the previous stage conclusion beneath it', async () => {
  const ctx = fakeCtx();
  const s = new StagedStatus(ctx);
  await s.stage('🧠 thinking');
  await s.stage('📊 analysing', 'scraped 25 repos');
  const last = ctx.calls.edits[ctx.calls.edits.length - 1];
  assert.match(last.text, /thinking/);
  assert.match(last.text, /scraped 25 repos/);
  assert.match(last.text, /analysing/);
});

test('terminal states render and freeze the message', async () => {
  const ctx = fakeCtx();
  const s = new StagedStatus(ctx);
  await s.stage('⚙️ working');
  await s.cant('all sources timed out', 'try again in a minute');
  const before = ctx.calls.edits.length;
  await s.stage('ignored');
  await s.done('too late');
  assert.equal(ctx.calls.edits.length, before);
  assert.match(ctx.calls.edits[ctx.calls.edits.length - 1].text, /Couldn.t finish/);
});

test('tooLong offers to keep watching or stop', async () => {
  const ctx = fakeCtx();
  const s = new StagedStatus(ctx);
  await s.stage('⏳ waiting');
  await s.tooLong('report still generating');
  assert.match(ctx.calls.edits[ctx.calls.edits.length - 1].text, /keep watching/i);
});

test('an edit failure never throws out of the status layer', async () => {
  const ctx = fakeCtx();
  ctx.api.editMessageText = async () => { throw { description: 'Bad Request: message is not modified' }; };
  const s = new StagedStatus(ctx);
  await s.stage('a');
  await assert.doesNotReject(s.stage('b', 'x'));
  await assert.doesNotReject(s.done('ok'));
});
