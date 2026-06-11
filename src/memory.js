const fs = require('fs');
const path = require('path');

// Freeform "memory" the bot keeps for the user: short facts/preferences they
// ask it to remember. Distinct from notes.js (named key/value notes) — this is
// an ordered list the user can dump, recall verbatim, and forget by id/text.
const MEM_FILE = path.join(__dirname, '..', 'memories.json');

function load() {
  try {
    if (fs.existsSync(MEM_FILE)) {
      const data = JSON.parse(fs.readFileSync(MEM_FILE, 'utf-8'));
      if (Array.isArray(data.entries)) return data;
    }
  } catch (e) {
    console.error('[Memory] Failed to load:', e.message);
  }
  return { entries: [] };
}

function save(data) {
  fs.writeFileSync(MEM_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

function addMemory(text) {
  const clean = String(text || '').trim();
  if (!clean) return { success: false, error: 'empty memory' };
  const data = load();
  const id = data.entries.reduce((m, e) => Math.max(m, e.id || 0), 0) + 1;
  const entry = { id, text: clean, createdAt: new Date().toISOString() };
  data.entries.push(entry);
  save(data);
  return { success: true, id, text: clean };
}

function listMemories() {
  return load().entries;
}

// Exact on-disk bytes, for /recallraw (verbatim, character-by-character).
function rawMemories() {
  try {
    if (fs.existsSync(MEM_FILE)) return fs.readFileSync(MEM_FILE, 'utf-8');
  } catch (e) {
    return `(could not read memory file: ${e.message})`;
  }
  return JSON.stringify({ entries: [] }, null, 2);
}

// arg: "all" clears everything; an integer removes that id; otherwise removes
// every entry whose text contains the arg (case-insensitive substring).
function forgetMemory(arg) {
  const data = load();
  const before = data.entries.length;
  const raw = String(arg || '').trim();

  if (!raw || raw.toLowerCase() === 'all') {
    data.entries = [];
    save(data);
    return { removed: before, mode: 'all' };
  }

  if (/^\d+$/.test(raw)) {
    const id = Number(raw);
    const idx = data.entries.findIndex((e) => e.id === id);
    if (idx === -1) return { removed: 0, mode: 'id' };
    const [gone] = data.entries.splice(idx, 1);
    save(data);
    return { removed: 1, mode: 'id', text: gone.text };
  }

  const q = raw.toLowerCase();
  const kept = data.entries.filter((e) => !e.text.toLowerCase().includes(q));
  const removed = before - kept.length;
  data.entries = kept;
  if (removed > 0) save(data);
  return { removed, mode: 'match' };
}

// Compact block for injecting into report/idea prompts so output is personalized.
function memoriesForPrompt(max = 25) {
  const entries = load().entries;
  if (!entries.length) return '';
  return entries.slice(-max).map((e) => `- ${e.text}`).join('\n');
}

module.exports = { addMemory, listMemories, rawMemories, forgetMemory, memoriesForPrompt };
