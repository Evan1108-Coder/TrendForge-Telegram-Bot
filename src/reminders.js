const fs = require('fs');
const path = require('path');

// Durable store for one-time reminders ("remind me in 30 minutes").
//
// Why this file exists: reminders used to live only in an in-memory Map of
// setTimeout timers. A /restart (or any process respawn) silently dropped every
// pending reminder — it would never fire. We now persist each reminder to disk
// so the bot can re-arm still-pending ones on startup and fire any that came due
// while it was down. Distinct from memory.js (facts) and notes.js (named notes).
const REM_FILE = path.join(__dirname, '..', 'reminders.json');

function load() {
  try {
    if (fs.existsSync(REM_FILE)) {
      const data = JSON.parse(fs.readFileSync(REM_FILE, 'utf-8'));
      if (Array.isArray(data.entries)) return data;
    }
  } catch (e) {
    console.error('[Reminders] Failed to load:', e.message);
  }
  return { entries: [] };
}

function save(data) {
  fs.writeFileSync(REM_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

// Persist a reminder and return the stored entry (with its assigned id).
// firesAt is an absolute epoch-ms timestamp so restored timers re-arm correctly.
function addReminder({ message, chatId, firesAt }) {
  const data = load();
  const id = data.entries.reduce((m, e) => Math.max(m, e.id || 0), 0) + 1;
  const entry = {
    id,
    message: String(message || 'Reminder!'),
    chatId,
    firesAt,
    createdAt: Date.now(),
  };
  data.entries.push(entry);
  save(data);
  return entry;
}

// Remove a fired/cancelled reminder by id. Idempotent.
function removeReminder(id) {
  const data = load();
  const before = data.entries.length;
  data.entries = data.entries.filter((e) => e.id !== id);
  if (data.entries.length !== before) save(data);
  return before - data.entries.length;
}

function listReminders() {
  return load().entries;
}

module.exports = { addReminder, removeReminder, listReminders, load };
