// Intelligent per-chat task queue — "multitasking, like a good assistant".
//
// Behaviour (matches how a person juggles requests):
//   * IDLE  → run the task right away, no chatter.
//   * BUSY  → the running task is NEVER interrupted. The new task is classified:
//       - queue   (default): handled right after the current task finishes.
//       - preempt: the user wants a quick answer NOW ("quick…", "do this first",
//                  "answer me now") → run it immediately, in parallel, while the
//                  long task keeps going. Nothing is stopped.
//       - cancel : the user changed their mind → drop everything still waiting in
//                  the queue. The in-flight task is left to finish (we don't kill
//                  work midway).
//   * Every busy decision is ACKNOWLEDGED so the user always knows what happened.
//
// The module is deliberately free of any Telegram/grammY coupling so it can be
// unit-tested with plain async thunks and an injected classifier (no real LLM).

// Obvious "do it now" phrasings — a free, deterministic fast-path so we don't
// spend an LLM call on the clear cases.
const PREEMPT_RE = /\b(quick(ly)?|real\s?quick|right\s?now|right\s?away|immediately|urgent(ly)?|asap|do\s+this\s+first|first\s+(though|please)?|answer\s+(me\s+)?(this\s+)?now|just\s+answer|quick\s+(question|one|thing)|one\s+quick|before\s+that)\b/i;

// Obvious "never mind" phrasings.
const CANCEL_RE = /\b(cancel|abort|never\s?mind|forget\s+it|stop\s+that|drop\s+it|scratch\s+that|disregard)\b/i;

// Returns 'preempt' | 'cancel' on a confident keyword hit, otherwise null
// (caller falls back to the LLM classifier, then to the 'queue' default).
function classifyByKeyword(text) {
  const t = (text || '').toString();
  if (CANCEL_RE.test(t)) return 'cancel';
  if (PREEMPT_RE.test(t)) return 'preempt';
  return null;
}

function createTaskQueue(deps = {}) {
  const classifyLLM = deps.classify || null; // async ({text, current}) => 'queue'|'preempt'|'cancel'
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
    // Free deterministic path first.
    const kw = classifyByKeyword(task.text);
    if (kw) return kw;
    // Nuanced cases: ask the injected LLM classifier if present. Any failure or
    // unrecognised answer falls back to the safe default — queue, never stop.
    if (classifyLLM) {
      try {
        const out = await classifyLLM({ text: task.text, current: current ? current.label : null });
        if (out === 'preempt' || out === 'cancel' || out === 'queue') return out;
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

    if (intent === 'preempt') {
      runImmediate(chatId, task); // parallel, fire-and-forget
      return 'preempt';
    }

    s.queue.push(task);
    drain(chatId); // ensure the lane is running for the newly-queued task
    return 'queue';
  }

  function inspect(chatId) {
    const s = getState(chatId);
    return { running: !!s.running, queued: s.queue.length, preempting: s.preempting, busy: isBusy(chatId) };
  }

  return { submit, isBusy, inspect, classify, _states: states };
}

module.exports = { createTaskQueue, classifyByKeyword, PREEMPT_RE, CANCEL_RE };
