'use strict';

// watch.js — Opt-in background watches for TrendForge (Feature 2).
//
// Same guarantees as the other bots' watch.js, but persisted to a JSON file
// (watches.json) to match TrendForge's storage style (memory.js / preferences),
// since this bot has no SQLite. A watch:
//   • is OPT-IN — nothing starts until the user says "yes, keep watching",
//   • runs in the background so the chat stays fully responsive,
//   • is bounded by guard.js (poll cap + wall-clock deadline + fixed cadence),
//     so it always ends: fired / timed_out (offer to extend) / stopped,
//   • survives a restart (resumed from watches.json),
//   • costs 0 extra API tokens (pure local timers + cheap scrape checks).

const fs = require('fs');
const path = require('path');
const { Deadline, boundedPoll, LIMITS } = require('./utils/guard');

const WATCH_FILE = path.join(__dirname, '..', 'watches.json');

function load() {
  try {
    if (fs.existsSync(WATCH_FILE)) {
      const data = JSON.parse(fs.readFileSync(WATCH_FILE, 'utf-8'));
      if (Array.isArray(data.entries)) return data;
    }
  } catch (e) {
    console.error('[Watch] Failed to load:', e.message);
  }
  return { entries: [], seq: 0 };
}

function save(data) {
  try {
    fs.writeFileSync(WATCH_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch (e) {
    console.error('[Watch] Failed to save:', e.message);
  }
}

class WatchManager {
  constructor(bot, opts = {}) {
    this.bot = bot;
    this.probes = new Map();
    this.active = new Map();
    this.maxConcurrent = opts.maxConcurrent || 10;
    this.file = opts.file || WATCH_FILE;
  }

  registerProbe(kind, fn) {
    this.probes.set(kind, fn);
    return this;
  }

  _load() {
    // Allow an override file (tests) without touching the real watches.json.
    if (this.file === WATCH_FILE) return load();
    try {
      if (fs.existsSync(this.file)) {
        const d = JSON.parse(fs.readFileSync(this.file, 'utf-8'));
        if (Array.isArray(d.entries)) return d;
      }
    } catch {}
    return { entries: [], seq: 0 };
  }

  _save(data) {
    if (this.file === WATCH_FILE) return save(data);
    try { fs.writeFileSync(this.file, JSON.stringify(data, null, 2), 'utf-8'); } catch {}
  }

  _update(id, patch) {
    const data = this._load();
    const row = data.entries.find(e => e.id === id);
    if (row) {
      Object.assign(row, patch, { updatedAt: new Date().toISOString() });
      this._save(data);
    }
    return row;
  }

  activeCount() {
    return this.active.size;
  }

  startWatch({ chatId, label, kind, params = {}, maxPolls, intervalMs, totalMs }, deliver) {
    if (!this.probes.has(kind)) throw new Error(`No watch probe registered for kind "${kind}"`);
    if (this.active.size >= this.maxConcurrent) {
      throw new Error(`Too many concurrent watches (max ${this.maxConcurrent}). Stop one first.`);
    }
    const caps = {
      maxPolls: Math.min(maxPolls || LIMITS.MAX_POLLS, LIMITS.MAX_POLLS),
      intervalMs: intervalMs || LIMITS.BACKOFF_BASE_MS,
      totalMs: totalMs || LIMITS.DEFAULT_TOTAL_MS,
    };
    const deadlineAt = new Date(Date.now() + caps.totalMs).toISOString();
    const data = this._load();
    const id = (data.seq || 0) + 1;
    data.seq = id;
    data.entries.push({
      id, chatId: String(chatId), label, kind, params,
      status: 'active', pollsDone: 0, maxPolls: caps.maxPolls, intervalMs: caps.intervalMs,
      deadlineAt, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    this._save(data);
    this._run(id, { chatId, label, kind, params, caps, deadlineAt }, deliver);
    return { id, caps };
  }

  _run(id, spec, deliver) {
    const controller = new AbortController();
    this.active.set(id, { controller });
    const probe = this.probes.get(spec.kind);
    const remainingMs = Math.max(0, new Date(spec.deadlineAt).getTime() - Date.now());
    const deadline = new Deadline(remainingMs);

    boundedPoll(
      (pollIndex, signal) => probe(spec.params, pollIndex, signal),
      {
        maxPolls: spec.caps.maxPolls,
        intervalMs: spec.caps.intervalMs,
        backoff: false,
        deadline,
        signal: controller.signal,
        label: spec.label,
        onPoll: n => this._update(id, { pollsDone: n }),
      }
    )
      .then(outcome => this._finish(id, spec, outcome, deliver))
      .catch(err => this._finish(id, spec, { done: false, reason: 'error', error: err?.message }, deliver))
      .finally(() => this.active.delete(id));
  }

  async _finish(id, spec, outcome, deliver) {
    const status = outcome.done ? 'fired' : outcome.reason === 'stopped' ? 'stopped' : outcome.reason === 'too_long' ? 'timed_out' : 'ended';
    this._update(id, { status, result: JSON.stringify(outcome).slice(0, 2000), finishedAt: new Date().toISOString() });
    if (status === 'stopped') return;
    const msg = this._message(id, spec, status, outcome);
    const send = deliver || (async (chatId, text) => {
      if (this.bot?.api?.sendMessage) await this.bot.api.sendMessage(chatId, text);
    });
    try {
      await send(spec.chatId, msg, { status, outcome });
    } catch (err) {
      if (typeof console !== 'undefined') console.error('[watch] deliver failed:', err?.message);
    }
  }

  _message(id, spec, status, outcome) {
    if (status === 'fired') return `✅ Heads up — it happened.\nWatch #${id}: ${spec.label}`;
    if (status === 'timed_out') return `⏳ Still nothing after the time budget.\nWatch #${id}: ${spec.label}\nWant me to keep watching, or stop here?`;
    return `⚠️ Stopped watching.\nWatch #${id}: ${spec.label}${outcome.error ? `\n${outcome.error}` : ''}`;
  }

  stopWatch(id) {
    const entry = this.active.get(id);
    if (entry) entry.controller.abort();
    const row = this._load().entries.find(e => e.id === id);
    if (row && row.status === 'active') this._update(id, { status: 'stopped', finishedAt: new Date().toISOString() });
    return { stopped: true, id };
  }

  listWatches(chatId, { activeOnly = false } = {}) {
    const rows = this._load().entries.filter(e => String(e.chatId) === String(chatId));
    const filtered = activeOnly ? rows.filter(e => e.status === 'active') : rows;
    return filtered.sort((a, b) => b.id - a.id).slice(0, 20);
  }

  resumeWatches(deliver) {
    const rows = this._load().entries.filter(e => e.status === 'active');
    let resumed = 0;
    for (const row of rows) {
      if (!this.probes.has(row.kind)) continue;
      const spec = {
        chatId: row.chatId, label: row.label, kind: row.kind, params: row.params || {},
        caps: { maxPolls: row.maxPolls, intervalMs: row.intervalMs, totalMs: LIMITS.DEFAULT_TOTAL_MS },
        deadlineAt: row.deadlineAt || new Date().toISOString(),
      };
      if (new Date(spec.deadlineAt).getTime() <= Date.now()) {
        this._finish(row.id, spec, { done: false, reason: 'too_long', resumedExpired: true }, deliver);
        continue;
      }
      this._run(row.id, spec, deliver);
      resumed += 1;
    }
    return { resumed };
  }
}

module.exports = { WatchManager, WATCH_FILE };
