const fs = require('fs');
const path = require('path');

const NOTES_FILE = path.join(__dirname, '..', 'notes.json');

function loadNotes() {
  try {
    if (fs.existsSync(NOTES_FILE)) return JSON.parse(fs.readFileSync(NOTES_FILE, 'utf-8'));
  } catch {}
  return {};
}

function saveNotes(notes) {
  fs.writeFileSync(NOTES_FILE, JSON.stringify(notes, null, 2), 'utf-8');
}

function saveNote(name, content) {
  const notes = loadNotes();
  notes[name] = { content, updatedAt: new Date().toISOString() };
  saveNotes(notes);
  return { success: true, name };
}

function readNote(name) {
  const notes = loadNotes();
  if (!notes[name]) return null;
  return { name, content: notes[name].content, updatedAt: notes[name].updatedAt };
}

function deleteNote(name) {
  const notes = loadNotes();
  if (!notes[name]) return { success: false, error: `Note "${name}" not found` };
  delete notes[name];
  saveNotes(notes);
  return { success: true, deleted: name };
}

function listNotes() {
  const notes = loadNotes();
  return Object.entries(notes).map(([name, n]) => ({
    name,
    updatedAt: n.updatedAt,
    preview: n.content.length > 100 ? n.content.substring(0, 100) + '...' : n.content,
  }));
}

module.exports = { saveNote, readNote, deleteNote, listNotes };
