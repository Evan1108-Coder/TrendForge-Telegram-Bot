const fs = require('fs');
const path = require('path');

const PREFS_FILE = path.join(__dirname, '..', 'preferences.json');

const DEFAULT_PREFS = {
  interests: ['AI', 'web development', 'open source tools', 'developer productivity'],
  languages: ['JavaScript', 'TypeScript', 'Python'],
  avoidTopics: [],
  ideaStyle: 'practical',
  dailyReportTime: '06:00',
  timezone: 'Asia/Hong_Kong',
  reportEnabled: true,
  reportCron: '0 6 * * *',
  reportScheduleText: 'Daily at 06:00',
  model: 'minimax-m2.5-lightning',
  paused: false,
  enabledSources: ['github', 'hn', 'reddit', 'ph', 'devto'],
  maxGitHubRepos: 10,
  maxHNStories: 10,
  maxRedditPosts: 10,
  maxPHProducts: 5,
  maxDevToArticles: 5,
};

function loadPreferences() {
  try {
    if (fs.existsSync(PREFS_FILE)) {
      const data = JSON.parse(fs.readFileSync(PREFS_FILE, 'utf-8'));
      return { ...DEFAULT_PREFS, ...data };
    }
  } catch (err) {
    console.error('Failed to load preferences, using defaults:', err.message);
  }
  return { ...DEFAULT_PREFS };
}

function savePreferences(prefs) {
  fs.writeFileSync(PREFS_FILE, JSON.stringify(prefs, null, 2), 'utf-8');
}

function updatePreferences(updates) {
  const current = loadPreferences();
  const updated = { ...current, ...updates };
  savePreferences(updated);
  return updated;
}

module.exports = { loadPreferences, savePreferences, updatePreferences, DEFAULT_PREFS };
