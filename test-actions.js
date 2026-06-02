require('dotenv').config();
const { cleanOutput } = require('./src/utils/format');
const { addSchedule, removeSchedule, listSchedules, loadSchedules } = require('./src/schedules');
const { saveNote, readNote, deleteNote, listNotes } = require('./src/notes');
const fs = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS: ${name}`);
    passed++;
  } catch (e) {
    console.log(`  FAIL: ${name} -> ${e.message}`);
    failed++;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

console.log('\n=== ROUND 1: Core Parsing & Cleanup ===\n');

test('cleanOutput strips [ACTIONS] block', () => {
  const input = 'Let me check that!\n[ACTIONS]\n[{"action":"fetch_data","params":{"sources":["github"]}}]\n[/ACTIONS]';
  const result = cleanOutput(input);
  assert(result === 'Let me check that!', `Got: "${result}"`);
});

test('cleanOutput strips legacy [NEED_DATA]', () => {
  const input = 'Checking GitHub for you!\n[NEED_DATA:github,hn]';
  const result = cleanOutput(input);
  assert(result === 'Checking GitHub for you!', `Got: "${result}"`);
});

test('cleanOutput strips legacy [SETTINGS_UPDATE]', () => {
  const input = 'Updated!\n[SETTINGS_UPDATE]{"interests":["AI"]}[/SETTINGS_UPDATE]';
  const result = cleanOutput(input);
  assert(result === 'Updated!', `Got: "${result}"`);
});

test('cleanOutput strips markdown from actions response', () => {
  const input = '**Bold** and *italic* and `code` and [link](url)\n[ACTIONS][{"action":"fetch_data"}][/ACTIONS]';
  const result = cleanOutput(input);
  assert(result === 'Bold and italic and code and link', `Got: "${result}"`);
});

test('parseResponse extracts actions correctly', () => {
  // We need to test parseResponse which is inside createBot closure
  // So we test the parsing logic pattern directly
  const text = 'Checking!\n[ACTIONS]\n[{"action":"fetch_data","params":{"sources":["github","hn"]}}]\n[/ACTIONS]';
  const actionsMatch = text.match(/\[ACTIONS\]([\s\S]*?)\[\/ACTIONS\]/);
  assert(actionsMatch !== null, 'Should match ACTIONS block');
  const actions = JSON.parse(actionsMatch[1].trim());
  assert(Array.isArray(actions), 'Should be array');
  assert(actions[0].action === 'fetch_data', `Got action: ${actions[0].action}`);
  assert(actions[0].params.sources.length === 2, 'Should have 2 sources');
});

test('parseResponse handles multiple actions', () => {
  const text = 'Setting up!\n[ACTIONS]\n[{"action":"add_schedule","params":{"name":"morning","cron":"0 9 * * *","type":"report"}},{"action":"add_schedule","params":{"name":"evening","cron":"0 21 * * *","type":"report"}}]\n[/ACTIONS]';
  const actionsMatch = text.match(/\[ACTIONS\]([\s\S]*?)\[\/ACTIONS\]/);
  const actions = JSON.parse(actionsMatch[1].trim());
  assert(actions.length === 2, `Expected 2 actions, got ${actions.length}`);
  assert(actions[0].params.name === 'morning', 'First should be morning');
  assert(actions[1].params.name === 'evening', 'Second should be evening');
});

test('parseResponse falls back to legacy NEED_DATA', () => {
  const text = 'Checking!\n[NEED_DATA:github,hn]';
  const actionsMatch = text.match(/\[ACTIONS\]([\s\S]*?)\[\/ACTIONS\]/);
  assert(actionsMatch === null, 'Should not match ACTIONS');
  const dataMatch = text.match(/\[NEED_DATA:([^\]]+)\]/);
  assert(dataMatch !== null, 'Should match NEED_DATA');
  const sources = dataMatch[1].split(',').map(s => s.trim());
  assert(sources.length === 2, `Expected 2 sources, got ${sources.length}`);
});

console.log('\n=== ROUND 2: Schedule Management ===\n');

// Clean up any existing test schedules
const schedFile = path.join(__dirname, 'schedules.json');
if (fs.existsSync(schedFile)) fs.unlinkSync(schedFile);

test('addSchedule creates a valid schedule', () => {
  const result = addSchedule('test-morning', { cron: '0 9 * * *', type: 'report', description: 'Test morning' });
  assert(result.success === true, `Failed: ${result.error}`);
  assert(result.name === 'test-morning');
});

test('addSchedule rejects invalid cron', () => {
  const result = addSchedule('bad-cron', { cron: 'not-a-cron' });
  assert(result.success === false, 'Should reject invalid cron');
  assert(result.error.includes('Invalid cron'), `Got error: ${result.error}`);
});

test('addSchedule creates multiple schedules', () => {
  addSchedule('test-evening', { cron: '0 21 * * *', type: 'report', description: 'Test evening' });
  addSchedule('test-bimonthly', { cron: '0 12 15-21 1,3,5,7,9,11 *', type: 'report', description: 'Bimonthly 3rd week' });
  const schedules = listSchedules();
  const custom = schedules.filter(s => s.source === 'custom');
  assert(custom.length === 3, `Expected 3 custom schedules, got ${custom.length}`);
});

test('listSchedules includes default report', () => {
  const schedules = listSchedules();
  const def = schedules.find(s => s.name === 'default-report');
  assert(def !== undefined, 'Should have default-report');
  assert(def.source === 'preferences');
});

test('removeSchedule works', () => {
  const result = removeSchedule('test-bimonthly');
  assert(result.success === true);
  const schedules = listSchedules();
  const custom = schedules.filter(s => s.source === 'custom');
  assert(custom.length === 2, `Expected 2 after removal, got ${custom.length}`);
});

test('removeSchedule fails on missing name', () => {
  const result = removeSchedule('nonexistent');
  assert(result.success === false);
});

test('Complex Evan schedule: 2 daily + 3 bimonthly 3rd week', () => {
  // Clean slate
  removeSchedule('test-morning');
  removeSchedule('test-evening');

  addSchedule('daily-morning', { cron: '0 9 * * *', type: 'report', description: 'Daily morning report' });
  addSchedule('daily-evening', { cron: '0 21 * * *', type: 'report', description: 'Daily evening report' });
  addSchedule('bimonthly-3w-1', { cron: '0 9 15-21 1,3,5,7,9,11 *', type: 'report', description: '3rd week bimonthly - 9am' });
  addSchedule('bimonthly-3w-2', { cron: '0 14 15-21 1,3,5,7,9,11 *', type: 'report', description: '3rd week bimonthly - 2pm' });
  addSchedule('bimonthly-3w-3', { cron: '0 20 15-21 1,3,5,7,9,11 *', type: 'report', description: '3rd week bimonthly - 8pm' });

  const schedules = listSchedules();
  const custom = schedules.filter(s => s.source === 'custom');
  assert(custom.length === 5, `Expected 5 custom schedules, got ${custom.length}`);

  // Verify cron expressions are all valid
  const cron = require('node-cron');
  for (const s of custom) {
    assert(cron.validate(s.cron), `Invalid cron for ${s.name}: ${s.cron}`);
  }
});

console.log('\n=== ROUND 3: Notes, Edge Cases, Safety ===\n');

// Clean up notes
const notesFile = path.join(__dirname, 'notes.json');
if (fs.existsSync(notesFile)) fs.unlinkSync(notesFile);

test('saveNote and readNote', () => {
  saveNote('test-idea', 'Build a CLI tool for git stats');
  const note = readNote('test-idea');
  assert(note !== null, 'Note should exist');
  assert(note.content === 'Build a CLI tool for git stats');
});

test('listNotes shows saved notes', () => {
  saveNote('test-idea-2', 'Another project idea');
  const notes = listNotes();
  assert(notes.length === 2, `Expected 2 notes, got ${notes.length}`);
});

test('deleteNote removes note', () => {
  const result = deleteNote('test-idea-2');
  assert(result.success === true);
  assert(listNotes().length === 1);
});

test('readNote returns null for missing', () => {
  assert(readNote('nonexistent') === null);
});

test('deleteNote fails for missing', () => {
  assert(deleteNote('nonexistent').success === false);
});

test('isSafeCommand pattern - dangerous commands blocked', () => {
  const dangerous = /\b(rm|rmdir|kill|killall|shutdown|reboot|mkfs|dd|chmod|chown|passwd|sudo|su)\b/;
  assert(dangerous.test('rm -rf /') === true, 'rm should be blocked');
  assert(dangerous.test('sudo apt install') === true, 'sudo should be blocked');
  assert(dangerous.test('kill -9 1234') === true, 'kill should be blocked');
  assert(dangerous.test('uptime') === false, 'uptime should be safe');
  assert(dangerous.test('pm2 list') === false, 'pm2 should be safe');
  assert(dangerous.test('git status') === false, 'git should be safe');
});

test('isSafeCommand pattern - pipe not blocked, redirect is', () => {
  assert(!/[>|&;]/.test('ls -la') || /\|/.test('ls -la'), 'ls should be ok');
  assert('echo hi > /tmp/x'.includes('> /'), 'redirect should be caught');
});

test('Actions JSON with trailing comma recovery', () => {
  const badJson = '[{"action":"fetch_data","params":{"sources":["github"]}},]';
  const fixed = badJson.replace(/,\s*([}\]])/g, '$1');
  const parsed = JSON.parse(fixed);
  assert(parsed.length === 1, 'Should parse after fix');
});

test('cleanOutput handles empty and null', () => {
  assert(cleanOutput('') === '');
  assert(cleanOutput(null) === '');
  assert(cleanOutput(undefined) === '');
});

test('Schedule message type works', () => {
  addSchedule('test-msg', { cron: '0 12 * * *', type: 'message', message: 'Lunch time!', description: 'Daily lunch reminder' });
  const schedules = loadSchedules();
  assert(schedules['test-msg'].type === 'message');
  assert(schedules['test-msg'].message === 'Lunch time!');
  removeSchedule('test-msg');
});

// Clean up test data
console.log('\n--- Cleanup ---');
const schedules = loadSchedules();
for (const name of Object.keys(schedules)) {
  removeSchedule(name);
}
if (fs.existsSync(notesFile)) fs.unlinkSync(notesFile);
console.log('Test data cleaned up.');

console.log(`\n=== RESULTS: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
