// Intelligent per-chat task queue — "multitasking, like a good assistant".
//
// Behaviour (matches how a person juggles requests):
//   * IDLE  → run the task right away, no chatter.
//   * BUSY  → the running task is NEVER interrupted. The new message is handled
//              conversationally: acknowledgements and status questions get an
//              immediate answer; new tasks are refused until the current task
//              finishes unless the user explicitly asks to stop/cancel.
//   * Every busy decision is ACKNOWLEDGED so the user always knows what happened.
//
// The module is deliberately free of any Telegram/grammY coupling so it can be
// unit-tested with plain async thunks and an injected classifier (no real LLM).

// Obvious "do it now" phrasings — a free, deterministic fast-path so we don't
// spend an LLM call on the clear cases.
const PREEMPT_RE = /\b(quick(ly)?|real\s?quick|right\s?now|right\s?away|immediately|urgent(ly)?|asap|do\s+this\s+first|first\s+(though|please)?|answer\s+(me\s+)?(this\s+)?now|just\s+answer|quick\s+(question|one|thing)|one\s+quick|before\s+that)\b/i;
const STATUS_RE = /\b(status|progress|what(?:'|’)?s happening|what are you doing|current task|are you done|how(?:'|’)?s it going|where are we|state|update)\b/i;
const ACK_RE = /\b(ok|okay|got it|cool|thanks|thank you|sounds good|working on that|fine|great)\b/i;

// Obvious "never mind" phrasings.
const CANCEL_RE = /\b(cancel|abort|never\s?mind|forget\s+it|stop\s+that|drop\s+it|scratch\s+that|disregard)\b/i;

// Returns 'status' | 'ack' | 'cancel' | 'queue' on a confident keyword hit.
function classifyByKeyword(text) {
  const t = (text || '').toString();
  if (CANCEL_RE.test(t)) return 'cancel';
  if (STATUS_RE.test(t) || (/\?/.test(t) && /\b(task|doing|progress|done|finished|working)\b/i.test(t))) return 'status';
  if (t.length <= 80 && ACK_RE.test(t) && !/[?]/.test(t)) return 'ack';
  if (PREEMPT_RE.test(t)) return 'queue';
  return null;
}

function createTaskQueue(deps = {}) {
  const classifyLLM = deps.classify || null; // async ({text, current}) => 'queue'|'status'|'ack'|'cancel'
  const onAck = deps.onAck || (async () => {}); // async ({chatId, intent, task, current, dropped}) => void
  const log = deps.log || (() => {});
  const states = new Map();

  function getState(chatId) {
    if (!states.has(chatId)) {
      states.set(chatId, { running: null, queue: [], draining: false, preempting: 0 });
    }
    return states.get(chatId);
  }

  // "Busy" means there is anything in flight or waiting: a draining serial lane,
  // queued tasks, or a preempt running in parallel.
  function isBusy(chatId) {
    const s = getState(chatId);
    return s.draining || s.queue.length > 0 || s.preempting > 0;
  }

  async function classify(task, current) {
    const kw = classifyByKeyword(task.text);
    if (kw) return kw;
    if (classifyLLM) {
      try {
        const out = await classifyLLM({ text: task.text, current: current ? current.label : null });
        if (out === 'status' || out === 'ack' || out === 'cancel' || out === 'queue') return out;
      } catch (e) {
        log('classify LLM failed: ' + e.message);
      }
    }
    return 'queue';
  }

  // Serial lane: runs queued tasks one at a time, in order. Idempotent — calling
  // it while already draining is a no-op; calling it after it has gone idle
  // restarts it for any newly-queued task.
  async function drain(chatId) {
    const s = getState(chatId);
    if (s.draining) return;
    s.draining = true;
    try {
      while (s.queue.length > 0) {
        const task = s.queue.shift();
        s.running = task;
        try {
          await task.run();
        } catch (e) {
          log('task run error: ' + e.message);
        }
        s.running = null;
      }
    } finally {
      s.draining = false;
    }
  }

  // Parallel lane for a pre-empted quick task: runs immediately alongside the
  // long-running task. We never touch the running task.
  async function runImmediate(chatId, task) {
    const s = getState(chatId);
    s.preempting += 1;
    try {
      await task.run();
    } catch (e) {
      log('preempt run error: ' + e.message);
    } finally {
      s.preempting -= 1;
    }
  }

  async function safeAck(info) {
    try {
      await onAck(info);
    } catch (e) {
      log('ack failed: ' + e.message);
    }
  }

  // Submit a task for a chat. A task is { text, label, run } where run is an
  // async thunk that does the actual work. Returns the decision string:
  // 'run' | 'queue' | 'preempt' | 'cancel'.
  async function submit(chatId, task) {
    const s = getState(chatId);

    if (!isBusy(chatId)) {
      s.queue.push(task);
      drain(chatId); // fire-and-forget; do not await the whole run here
      return 'run';
    }

    const current = s.running;
    const intent = await classify(task, current);

    if (intent === 'cancel') {
      const dropped = s.queue.length;
      s.queue = [];
      await safeAck({ chatId, intent, task, current, dropped });
      return 'cancel';
    }

    await safeAck({ chatId, intent, task, current });

    // Busy chat is conversational only. Do not start/queue a second task unless
    // the first one is done; the ack tells the user how to ask for status or stop.
    return intent;
  }

  function inspect(chatId) {
    const s = getState(chatId);
    return { running: !!s.running, queued: s.queue.length, preempting: s.preempting, busy: isBusy(chatId) };
  }

  return { submit, isBusy, inspect, classify, _states: states };
}

module.exports = { createTaskQueue, classifyByKeyword, PREEMPT_RE, STATUS_RE, ACK_RE, CANCEL_RE };
