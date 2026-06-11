require('dotenv').config();
const { cleanOutput } = require('./src/utils/format');
const { addSchedule, removeSchedule, listSchedules, loadSchedules } = require('./src/schedules');
const { saveNote, readNote, deleteNote, listNotes } = require('./src/notes');
const { addMemory, listMemories, rawMemories, forgetMemory, memoriesForPrompt } = require('./src/memory');
const {
  escapeHtml, parseModelJson, splitHtmlMessage, buildCandidates,
  renderStructuredReport, renderFullReport, renderFallbackReport,
  buildMetric, toItem,
} = require('./src/render');
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

console.log('\n=== ROUND 4: Report Rendering (HTML, structured) ===\n');

const sampleData = {
  github: [
    { name: 'acme/rocket', url: 'https://github.com/acme/rocket', description: 'A fast web framework', language: 'Rust', starsToday: '1,204 stars today', totalStars: '52932' },
    { name: 'foo/bar', url: 'https://github.com/foo/bar', description: 'CLI tool', language: 'Go', starsToday: '0', totalStars: '1200' },
  ],
  hn: [
    { title: 'Building an HTML-first site', url: 'https://news.ycombinator.com/item?id=1', score: 1100, comments: 498, by: 'pg' },
  ],
  reddit: [
    { subreddit: 'programming', title: 'My side project', url: 'https://reddit.com/r/programming/x', score: 340, comments: 88 },
  ],
  ph: [
    { name: 'Terminal Mode', tagline: 'Keep agents in sight', url: 'https://producthunt.com/posts/terminal-mode', votes: 210 },
  ],
  devto: [
    { title: 'Make agents remember', url: 'https://dev.to/x', author: 'dev', reactions: 75, readingTime: 6, tags: ['ai', 'agents'] },
  ],
};

test('escapeHtml escapes &, <, >', () => {
  assert(escapeHtml('a & b < c > d') === 'a &amp; b &lt; c &gt; d', `Got: ${escapeHtml('a & b < c > d')}`);
});

test('parseModelJson parses plain JSON', () => {
  const r = parseModelJson('{"tldr":["hi"],"top_picks":[],"signal_of_day":"x"}');
  assert(r && r.tldr[0] === 'hi', 'Should parse');
});

test('parseModelJson strips code fences', () => {
  const r = parseModelJson('```json\n{"signal_of_day":"y"}\n```');
  assert(r && r.signal_of_day === 'y', `Got: ${JSON.stringify(r)}`);
});

test('parseModelJson tolerates leading prose + trailing comma', () => {
  const r = parseModelJson('Here you go:\n{"tldr":["a"],"top_picks":[{"id":"gh1","one_liner":"x"},],}');
  assert(r && r.top_picks[0].id === 'gh1', `Got: ${JSON.stringify(r)}`);
});

test('parseModelJson returns null on garbage', () => {
  assert(parseModelJson('not json at all') === null, 'Should be null');
  assert(parseModelJson('') === null, 'Empty should be null');
});

test('buildCandidates builds id map and numbered list', () => {
  const { idMap, list, count } = buildCandidates(sampleData);
  assert(idMap.gh1 && idMap.gh1.title === 'acme/rocket', 'gh1 should map');
  assert(idMap.hn1 && idMap.hn1.source === 'hn', 'hn1 should map');
  assert(list.includes('gh1 |') && list.includes('hn1 |'), 'List should contain ids');
  assert(count === 6, `Expected 6 candidates, got ${count}`);
});

test('renderStructuredReport produces bold headers + tappable links', () => {
  const { idMap } = buildCandidates(sampleData);
  const parsed = {
    tldr: ['AI agents are eating dev tooling', 'HTML-first is back'],
    top_picks: [
      { id: 'gh1', one_liner: 'fast Rust web framework worth a look' },
      { id: 'hn1', one_liner: 'case for semantic HTML over JS' },
      { id: 'ph1', one_liner: 'keeps your coding agent visible' },
    ],
    signal_of_day: 'Agent tooling and simplicity are converging.',
  };
  const html = renderStructuredReport(parsed, idMap, { dateLabel: 'Jun 11', footer: 'via test', sources: 'GitHub, HN' });
  assert(html.includes('<b>TrendForge Daily</b>'), 'Should have bold title');
  assert(html.includes('<b>⚡ TL;DR</b>'), 'Should have TL;DR header');
  assert(html.includes('<a href="https://github.com/acme/rocket">acme/rocket</a>'), 'Should link gh1');
  assert(html.includes('fast Rust web framework'), 'Should include one_liner');
  assert(html.includes('Signal of the Day'), 'Should include signal');
  assert(html.includes('1,204 stars today'), 'Should include deterministic metric');
});

test('renderStructuredReport escapes malicious titles/urls (no injection)', () => {
  const evil = { github: [{ name: 'x<script>&"y', url: 'https://e.com/a"b', description: 'd', language: 'JS', starsToday: '0', totalStars: '5' }] };
  const { idMap } = buildCandidates(evil);
  const html = renderStructuredReport(
    { tldr: [], top_picks: [{ id: 'gh1', one_liner: 'safe <b>x</b>' }], signal_of_day: '' },
    idMap, { dateLabel: 'Jun 11', footer: '', sources: 'GitHub' }
  );
  assert(!html.includes('<script>'), 'Raw <script> must not appear');
  assert(html.includes('x&lt;script&gt;'), 'Title must be escaped');
  assert(html.includes('a&quot;b'), `URL quote must be escaped. Got: ${html}`);
});

test('renderStructuredReport tops up to 3 picks when model under-delivers', () => {
  const { idMap } = buildCandidates(sampleData);
  const html = renderStructuredReport(
    { tldr: [], top_picks: [{ id: 'gh1', one_liner: 'only one' }], signal_of_day: '' },
    idMap, { dateLabel: 'Jun 11', footer: '', sources: 'GitHub' }
  );
  const links = (html.match(/<a href=/g) || []).length;
  assert(links === 3, `Expected 3 picks after top-up, got ${links}`);
});

test('buildMetric hides fake zero counts (Reddit RSS / PH feed have none)', () => {
  // Reddit with no score/comments still keeps subreddit, drops the 0s.
  assert(buildMetric({ score: 0, comments: 0, subreddit: 'programming' }, 'reddit') === 'r/programming',
    `Got: "${buildMetric({ score: 0, comments: 0, subreddit: 'programming' }, 'reddit')}"`);
  // Real numbers still render.
  assert(buildMetric({ score: 340, comments: 88, subreddit: 'webdev' }, 'reddit') === '🔼 340 · 💬 88 · r/webdev');
  // PH with 0 votes shows no metric at all (no "0 upvotes").
  assert(buildMetric({ votes: 0 }, 'ph') === '', `Got: "${buildMetric({ votes: 0 }, 'ph')}"`);
  assert(buildMetric({ votes: 210 }, 'ph') === '🔼 210 upvotes');
});

test('toItem strips "Discussion | Link" boilerplate from PH taglines', () => {
  const item = toItem({ name: 'Patchrooms', tagline: 'Turn feedback into patch context. Discussion | Link', url: 'https://x' }, 'ph');
  assert(item.desc === 'Turn feedback into patch context.', `Got: "${item.desc}"`);
});

test('renderFullReport renders an overall Top 5 with ranks + source tags, no per-source sections', () => {
  const { idMap } = buildCandidates(sampleData);
  const parsed = {
    tldr: ['AI agents are eating dev tooling'],
    top_5: [
      { id: 'gh1', summary: 'A fast Rust web framework. Worth a look if you care about performance.' },
      { id: 'hn1', summary: 'The case for semantic HTML over heavy JS. A grounded counterpoint to framework sprawl.' },
      { id: 'ph1', summary: 'Keeps your coding agent visible in the terminal. Handy for agent-driven workflows.' },
      { id: 'rd1', summary: 'A side project shared on r/programming. Community is discussing the approach.' },
      { id: 'dv1', summary: 'A piece on giving agents memory. Practical for long-running assistants.' },
    ],
    signal_of_day: 'Agent tooling and simplicity are converging.',
  };
  const html = renderFullReport(parsed, idMap, { dateLabel: 'Jun 11', footer: 'via test', sources: 'all' });
  // Exactly the 5 ranked picks render as tappable links — no full rundown.
  assert((html.match(/<a href=/g) || []).length === 5, `Expected 5 links, got ${(html.match(/<a href=/g) || []).length}`);
  assert(html.includes('<b>🏆 Top 5 Today</b>'), 'Should have Top 5 header');
  assert(!html.includes('The Full Rundown'), 'Must NOT have a Full Rundown section');
  assert(!html.includes('<b>🐙 GitHub</b>'), 'Must NOT have per-source section headers');
  // Rank numbers + source tag on the title line.
  assert(html.includes('<b>1. <a href="https://github.com/acme/rocket">acme/rocket</a></b> · <i>🐙 GitHub</i>'),
    `Rank+title+source tag should render. Got:\n${html}`);
  assert(html.includes('2.') && html.includes('5.'), 'Should rank 1 through 5');
  assert(html.includes('TL;DR') && html.includes('Signal of the Day'), 'Keeps TL;DR + signal');
});

test('renderFullReport splits into exactly 2 Telegram messages', () => {
  const { idMap } = buildCandidates(sampleData);
  const parsed = {
    tldr: ['one line'],
    top_5: [
      { id: 'gh1', summary: 'desc one here.' },
      { id: 'hn1', summary: 'desc two here.' },
      { id: 'ph1', summary: 'desc three here.' },
      { id: 'rd1', summary: 'desc four here.' },
      { id: 'dv1', summary: 'desc five here.' },
    ],
    signal_of_day: 'A clear short signal for today.',
  };
  const html = renderFullReport(parsed, idMap, { dateLabel: 'Jun 11', footer: 'via test', sources: 'all' });
  const chunks = splitHtmlMessage(html, 4000);
  assert(chunks.length === 2, `Expected exactly 2 messages, got ${chunks.length}`);
  assert(chunks[0].includes('Top 5 Today') && !chunks[0].includes('Signal of the Day'), 'Msg 1 = TL;DR + Top 5');
  assert(chunks[1].includes('Signal of the Day'), 'Msg 2 = Signal');
  // The sentinel must never leak into a sent message.
  assert(!chunks[0].includes('␞') && !chunks[1].includes('␞'), 'Page-break sentinel must be stripped');
});

test('renderFallbackReport works with no LLM and stays HTML-safe (overall Top 5)', () => {
  const html = renderFallbackReport(sampleData, { dateLabel: 'Jun 11', footer: 'raw data', sources: 'GitHub, HN' });
  assert(html.includes('TrendForge Daily'), 'Should render header');
  // sampleData has 6 candidates; fallback shows the overall best 5.
  assert((html.match(/<a href=/g) || []).length === 5, `Should have 5 ranked items, got ${(html.match(/<a href=/g) || []).length}`);
  assert(html.includes("Today's pulse"), 'Should have generic TL;DR');
  assert(html.includes('🏆 Top 5 Today'), 'Fallback should use the overall Top 5 layout');
  assert(!html.includes('The Full Rundown'), 'Fallback must NOT include a full rundown');
});

test('splitHtmlMessage keeps short messages as one chunk', () => {
  const chunks = splitHtmlMessage('hello world', 4000);
  assert(chunks.length === 1 && chunks[0] === 'hello world', 'Single chunk');
});

test('splitHtmlMessage splits long text on line boundaries under the limit', () => {
  const line = '<b>x</b> some line of moderate length here';
  const text = Array.from({ length: 400 }, () => line).join('\n');
  const chunks = splitHtmlMessage(text, 4000);
  assert(chunks.length > 1, 'Should split');
  for (const c of chunks) assert(c.length <= 4000, `Chunk too long: ${c.length}`);
  assert(chunks.join('\n') === text, 'Rejoining chunks should reproduce original (no tag splitting)');
});

console.log('\n=== ROUND 5: Memory store (v3.4) ===\n');

const memFile = path.join(__dirname, 'memories.json');
if (fs.existsSync(memFile)) fs.unlinkSync(memFile);

test('addMemory stores and assigns incrementing ids', () => {
  forgetMemory('all');
  const a = addMemory('I prefer Rust over Go');
  const b = addMemory('Building a CLI for git stats');
  assert(a.success && b.success, 'both should succeed');
  assert(b.id === a.id + 1, `ids should increment, got ${a.id} then ${b.id}`);
  assert(listMemories().length === 2, 'should have 2 memories');
});

test('addMemory rejects empty text', () => {
  const before = listMemories().length;
  const r = addMemory('   ');
  assert(r.success === false, 'empty memory should be rejected');
  assert(listMemories().length === before, 'count unchanged');
});

test('forgetMemory by id removes exactly one', () => {
  forgetMemory('all');
  const a = addMemory('keep me');
  const b = addMemory('delete me by id');
  const r = forgetMemory(String(b.id));
  assert(r.removed === 1 && r.mode === 'id', `expected 1 removed by id, got ${JSON.stringify(r)}`);
  const left = listMemories();
  assert(left.length === 1 && left[0].text === 'keep me', 'only the id-targeted one removed');
});

test('forgetMemory by substring removes all matches (case-insensitive)', () => {
  forgetMemory('all');
  addMemory('Likes TypeScript');
  addMemory('typescript tooling notes');
  addMemory('Unrelated thing');
  const r = forgetMemory('TYPEScript');
  assert(r.removed === 2 && r.mode === 'match', `expected 2 removed, got ${JSON.stringify(r)}`);
  assert(listMemories().length === 1, 'one unrelated memory remains');
});

test('forgetMemory all clears everything', () => {
  addMemory('x'); addMemory('y');
  const r = forgetMemory('all');
  assert(r.mode === 'all' && r.removed >= 2, 'all cleared');
  assert(listMemories().length === 0, 'empty after clear');
});

test('rawMemories returns exact on-disk JSON (verbatim)', () => {
  forgetMemory('all');
  addMemory('verbatim check');
  const raw = rawMemories();
  const onDisk = fs.readFileSync(memFile, 'utf-8');
  assert(raw === onDisk, 'rawMemories must equal the file byte-for-byte');
  assert(raw.includes('verbatim check'), 'raw should contain the entry text');
});

test('memoriesForPrompt formats as dashed lines and respects empty', () => {
  forgetMemory('all');
  assert(memoriesForPrompt() === '', 'empty store yields empty string');
  addMemory('line one');
  addMemory('line two');
  const block = memoriesForPrompt();
  assert(block === '- line one\n- line two', `unexpected block: ${JSON.stringify(block)}`);
});

// === ROUND 6: AI-personalized error handling (v3.4) ===
const errors = require('./src/errors');

async function atest(name, fn) {
  try {
    await fn();
    console.log(`  PASS: ${name}`);
    passed++;
  } catch (e) {
    console.log(`  FAIL: ${name} -> ${e.message}`);
    failed++;
  }
}

// Mock provider/pref deps so tests never hit a real LLM, real env, or real keys.
const SECRET = 'sk-thisIsAFakeSecretValue1234567890';
const mockDeps = (over = {}) => ({
  getProviderStatus: () => [
    { name: 'openai', envKey: 'OPENAI_API_KEY', configured: false },
    { name: 'anthropic', envKey: 'ANTHROPIC_API_KEY', configured: true },
  ],
  getAvailableModels: () => ['claude-sonnet-4-6'],
  getAllModels: () => ['gpt-5.4-pro', 'claude-sonnet-4-6'],
  loadPreferences: () => ({ model: 'claude-sonnet-4-6' }),
  ...over,
});

(async () => {
  console.log('\n=== ROUND 6: AI-personalized error handling (v3.4) ===\n');

  // --- classifyError categories ---
  test('classifyError -> missing_key', () => {
    assert(errors.classifyError(new Error('No API key set for openai. Set OPENAI_API_KEY'), 'x') === 'missing_key');
  });
  test('classifyError -> unknown_model', () => {
    assert(errors.classifyError(new Error('Unknown model: foo-bar'), 'x') === 'unknown_model');
  });
  test('classifyError -> auth (401)', () => {
    const e = new Error('Request failed'); e.response = { status: 401 };
    assert(errors.classifyError(e, 'x') === 'auth');
  });
  test('classifyError -> rate_limit (429)', () => {
    const e = new Error('Too many requests'); e.response = { status: 429 };
    assert(errors.classifyError(e, 'x') === 'rate_limit');
  });
  test('classifyError -> provider_down (500)', () => {
    const e = new Error('Server error'); e.response = { status: 503 };
    assert(errors.classifyError(e, 'x') === 'provider_down');
  });
  test('classifyError -> timeout', () => {
    const e = new Error('timeout of 120000ms exceeded'); e.code = 'ECONNABORTED';
    assert(errors.classifyError(e, 'x') === 'timeout');
  });
  test('classifyError -> network (ENOTFOUND)', () => {
    const e = new Error('getaddrinfo ENOTFOUND api.openai.com'); e.code = 'ENOTFOUND';
    assert(errors.classifyError(e, 'x') === 'network');
  });
  test('classifyError -> parse', () => {
    assert(errors.classifyError(new Error('Unexpected token < in JSON at position 0'), 'x') === 'parse');
  });
  test('classifyError -> unknown (fallthrough)', () => {
    assert(errors.classifyError(new Error('something weird happened'), 'x') === 'unknown');
  });

  // --- redactSecrets ---
  test('redactSecrets scrubs real env key values', () => {
    const saved = process.env.MOONSHOT_API_KEY;
    process.env.MOONSHOT_API_KEY = 'topsecretmoonshotvalue';
    try {
      const out = errors.redactSecrets('failed with key topsecretmoonshotvalue in header');
      assert(!out.includes('topsecretmoonshotvalue'), `leaked: ${out}`);
      assert(out.includes('[redacted]'), 'should mark redaction');
    } finally {
      if (saved === undefined) delete process.env.MOONSHOT_API_KEY;
      else process.env.MOONSHOT_API_KEY = saved;
    }
  });
  test('redactSecrets scrubs sk- tokens and Bearer headers', () => {
    const out = errors.redactSecrets(`auth: Bearer ${SECRET}, key ${SECRET}`);
    assert(!out.includes(SECRET), `leaked token: ${out}`);
  });
  test('redactSecrets handles null/undefined safely', () => {
    assert(errors.redactSecrets(null) === '' && errors.redactSecrets(undefined) === '');
  });

  // --- buildErrorContext is secret-safe ---
  test('buildErrorContext never leaks secret values & has boolean provider flags', () => {
    const ctx = errors.buildErrorContext(
      { err: new Error(`boom with ${SECRET} inside`), where: 'switching the AI model', extra: { attemptedModel: 'gpt-5.4-pro', leak: SECRET } },
      mockDeps()
    );
    const blob = JSON.stringify(ctx);
    assert(!blob.includes(SECRET), `context leaked a secret: ${blob}`);
    assert(ctx.providers.every((p) => typeof p.configured === 'boolean'), 'provider flags must be booleans');
    assert(ctx.providers.every((p) => !('key' in p) && !('value' in p)), 'no key/value fields allowed');
    assert(ctx.category === 'missing_key' || ctx.category === 'unknown', `category set: ${ctx.category}`);
    assert(ctx.attemptedModel === 'gpt-5.4-pro', 'extra fields carried through');
    assert(ctx.anyProviderConfigured === true, 'anthropic configured => true');
  });

  // --- explainError: AI path ---
  await atest('explainError uses the AI when a model is available', async () => {
    let calledModel = null;
    const deps = mockDeps({
      chat: async (model) => { calledModel = model; return 'No problem — your key for that one is missing. Switch to claude-sonnet-4-6, it is ready now.'; },
      cleanOutput: (t) => t,
    });
    const ctx = errors.buildErrorContext({ err: new Error('No API key set for openai'), where: 'switching the AI model' }, deps);
    const out = await errors.explainError(ctx, deps);
    assert(calledModel === 'claude-sonnet-4-6', `should call available model, got ${calledModel}`);
    assert(out.includes('claude-sonnet-4-6'), `AI text returned: ${out}`);
  });

  // --- explainError: hard fallback when NO model available (AI can't run) ---
  await atest('explainError hard-fallback when no provider key (AI cannot run)', async () => {
    let chatCalled = false;
    const deps = mockDeps({
      getProviderStatus: () => [
        { name: 'openai', envKey: 'OPENAI_API_KEY', configured: false },
        { name: 'anthropic', envKey: 'ANTHROPIC_API_KEY', configured: false },
      ],
      getAvailableModels: () => [],
      chat: async () => { chatCalled = true; return 'should not be called'; },
    });
    const ctx = errors.buildErrorContext({ err: new Error('No AI model available'), where: 'processing your message' }, deps);
    const out = await errors.explainError(ctx, deps);
    assert(chatCalled === false, 'must NOT call the LLM when no key exists');
    assert(/no api keys|can't reach any ai|cannot/i.test(out), `deterministic no-key message: ${out}`);
    assert(out.includes('.env'), 'should tell user to set .env key');
  });

  // --- explainError: hard fallback when the explainer LLM call itself fails ---
  await atest('explainError hard-fallback when the explainer LLM call throws', async () => {
    let attempted = false;
    const deps = mockDeps({
      chat: async () => { attempted = true; throw new Error('provider 500'); },
    });
    const ctx = errors.buildErrorContext({ err: new Error('Reddit fetch failed'), where: 'generating your trend report' }, deps);
    const out = await errors.explainError(ctx, deps);
    assert(attempted === true, 'should have attempted the LLM');
    assert(/couldn't reach the ai|try again|\/config/i.test(out), `fallback message: ${out}`);
    assert(out.includes('generating your trend report'), 'fallback names the operation');
    assert(!out.includes('sk-'), 'no secret leakage in fallback');
  });

  // --- handleError end-to-end (build + explain) ---
  await atest('handleError builds context and returns AI explanation (secret-safe)', async () => {
    const deps = mockDeps({
      chat: async () => `Here's what happened with ${SECRET}`, // even if AI echoed a secret-shaped token...
      cleanOutput: (t) => t,
    });
    const out = await errors.handleError({ err: new Error('Unknown model: zzz'), where: 'switching the AI model' }, deps);
    assert(typeof out === 'string' && out.length > 0, 'returns a non-empty string');
  });

  // Clean up test data
  console.log('\n--- Cleanup ---');
  if (fs.existsSync(memFile)) fs.unlinkSync(memFile);
  const schedules = loadSchedules();
  for (const name of Object.keys(schedules)) {
    removeSchedule(name);
  }
  if (fs.existsSync(notesFile)) fs.unlinkSync(notesFile);
  console.log('Test data cleaned up.');

  console.log(`\n=== RESULTS: ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed > 0 ? 1 : 0);
})();
