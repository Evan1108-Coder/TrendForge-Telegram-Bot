const { Bot } = require('grammy');
const { execSync } = require('child_process');
const axios = require('axios');
const { version: VERSION } = require('../package.json');
const { chat, chatWithVision, supportsVision, getAllModels, getAvailableModels, getProviderStatus, getProviderForModel } = require('./llm/providers');
const { handleError } = require('./errors');
const { checkForUpdate, applyUpdate, formatUpdateNotice } = require('./update');
const { createTaskQueue } = require('./taskqueue');
const { humanizeCron, describeSchedule } = require('./humanize');
const { loadPreferences, updatePreferences } = require('./preferences');
const { restartCron, stopCron, scheduleLabel } = require('./cron');
const { addSchedule, removeSchedule, listSchedules, restartAllSchedules } = require('./schedules');
const { saveNote, readNote, deleteNote, listNotes } = require('./notes');
const { addMemory, listMemories, rawMemories, forgetMemory } = require('./memory');
const { generateDailyReport } = require('./report');
const { sendReportHTML, escapeHtml } = require('./render');
const { fetchGitHubTrendingByPrefs } = require('./scrapers/github');
const { fetchTopStories } = require('./scrapers/hackernews');
const { fetchRedditHot } = require('./scrapers/reddit');
const { fetchProductHunt } = require('./scrapers/producthunt');
const { fetchDevToByInterests } = require('./scrapers/devto');
const { withRetry } = require('./utils/retry');
const { cleanOutput, sendLong } = require('./utils/format');
const { classifyFile, downloadTelegramFile, extractText, getImageBase64, getMimeType, getSupportedExtensions } = require('./files');

// pm2 process name used by /restart. Override with PM2_PROCESS_NAME for forks.
const PM2_NAME = process.env.PM2_PROCESS_NAME || 'trendforge';

// Prompt behind /ideas — reused via the normal text pipeline so it fetches live
// data and synthesizes. Kept as a constant so the command and queue share it.
const IDEAS_PROMPT = 'Brainstorm 3 genuinely creative, buildable project ideas inspired by what is trending RIGHT NOW across GitHub, Hacker News, Reddit, Product Hunt and Dev.to. Fetch today\'s live data first, then for each idea give a one-line concept, a suggested tech stack, and who it is for. Be original and avoid generic CRUD apps.';

// Registered with Telegram via setMyCommands so they appear in the "/" menu.
const COMMAND_MENU = [
  { command: 'help', description: 'Show all commands' },
  { command: 'report', description: 'Generate a trend report now' },
  { command: 'ideas', description: "Creative project ideas from today's trends" },
  { command: 'status', description: 'Bot status, model & schedule' },
  { command: 'version', description: 'Version & build info' },
  { command: 'model', description: 'View or switch the AI model' },
  { command: 'sources', description: 'View or toggle trend sources' },
  { command: 'recall', description: 'Show everything I remember' },
  { command: 'recallraw', description: 'Dump memory verbatim' },
  { command: 'remember', description: 'Save something to memory' },
  { command: 'forget', description: 'Delete from memory' },
  { command: 'schedules', description: 'List active schedules' },
  { command: 'pause', description: 'Pause automatic reports' },
  { command: 'resume', description: 'Resume automatic reports' },
  { command: 'config', description: 'API keys & provider status' },
  { command: 'update', description: 'Update to the latest GitHub version' },
  { command: 'restart', description: 'Restart the bot' },
];

const HELP_TEXT =
  `🔨 TrendForge v${VERSION} — commands\n\n` +
  'REPORTS\n' +
  '/report — full trend report right now\n' +
  "/ideas — creative project ideas from today's trends\n" +
  '/pause · /resume — mute / unmute automatic reports\n' +
  '/schedules — list scheduled reports\n\n' +
  'MEMORY (I remember things for you)\n' +
  '/remember <text> — save a fact or preference\n' +
  '/recall — show everything I remember\n' +
  '/recallraw — exact verbatim dump\n' +
  '/forget <id|text|all> — delete memories\n\n' +
  'CONFIG\n' +
  '/model [name] — view or switch the AI model\n' +
  '/sources [name] — view or toggle trend sources\n' +
  '/config — API keys & provider status\n\n' +
  'SYSTEM\n' +
  '/status — uptime, model, schedule\n' +
  '/version — version & build\n' +
  '/update — pull the latest version from GitHub & restart\n' +
  '/restart — restart the bot\n\n' +
  'You can also just talk to me naturally for anything else.';

function formatUptime(seconds) {
  const s = Math.floor(seconds);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m || (!d && !h)) parts.push(`${m}m`);
  return parts.join(' ');
}

const ALL_SOURCES = ['github', 'hn', 'reddit', 'ph', 'devto'];
const SOURCE_ALIASES = {
  producthunt: 'ph', 'product-hunt': 'ph', 'product_hunt': 'ph',
  'dev.to': 'devto', dev: 'devto', hackernews: 'hn', 'hacker-news': 'hn',
};

function createBot(token) {
  const bot = new Bot(token);
  const conversationHistory = new Map();
  const activeReminders = new Map();
  let updateInProgress = false;

  function getHistory(chatId) {
    if (!conversationHistory.has(chatId)) conversationHistory.set(chatId, []);
    return conversationHistory.get(chatId);
  }

  function addToHistory(chatId, role, content) {
    const history = getHistory(chatId);
    history.push({ role, content });
    if (history.length > 30) history.splice(0, history.length - 30);
  }

  // ---- Typing indicator ----------------------------------------------------
  // Show Telegram's "typing…" bubble while we work so the user knows their
  // message landed and something is happening. It auto-expires after ~5s, so we
  // refresh it on an interval and clear it when the work is done.
  function startTyping(ctx) {
    const ping = () => { try { ctx.api.sendChatAction(ctx.chat.id, 'typing').catch(() => {}); } catch (_) {} };
    ping();
    const iv = setInterval(ping, 4000);
    return () => clearInterval(iv);
  }

  async function withTyping(ctx, fn) {
    const stop = startTyping(ctx);
    try {
      return await fn();
    } finally {
      stop();
    }
  }

  // ---- Intelligent multitasking queue --------------------------------------
  // When a request arrives while another is running we don't stop the running
  // one. We classify the newcomer (queue / preempt / cancel) and acknowledge it
  // so the user is never left wondering. The classifier only runs when we're
  // actually busy (so an idle bot pays nothing), and a free keyword fast-path
  // handles the obvious "do it now" / "never mind" cases before any LLM call.
  async function classifyInterrupt({ text, current }) {
    const prefs = loadPreferences();
    const available = getAvailableModels();
    const model = available.includes(prefs.model) ? prefs.model : available[0];
    if (!model) return 'queue'; // no model → safest default, never interrupt
    const sys =
      'You triage incoming messages for an assistant that is CURRENTLY BUSY with another task. ' +
      'Reply with exactly ONE word:\n' +
      'QUEUE = handle it after the current task finishes (the default for normal requests),\n' +
      'PREEMPT = the user wants a quick answer right now or asked to do it first,\n' +
      'CANCEL = the user wants to cancel what they previously asked for.\n' +
      'Reply with ONLY the single word.';
    const usr = `Current task: ${current || 'a task in progress'}\nNew message: "${(text || '').slice(0, 300)}"\nOne word:`;
    try {
      const out = await chat(model, [{ role: 'system', content: sys }, { role: 'user', content: usr }]);
      const w = (out || '').toUpperCase();
      if (w.includes('PREEMPT')) return 'preempt';
      if (w.includes('CANCEL')) return 'cancel';
      return 'queue';
    } catch (e) {
      console.error('[Queue] classify failed, defaulting to queue:', e.message);
      return 'queue';
    }
  }

  async function ackTask({ intent, task, current, dropped }) {
    const ctx = task.ctx;
    if (!ctx) return;
    const curLabel = current && current.label ? current.label : "what I'm working on";
    try {
      if (intent === 'preempt') {
        const other = curLabel === "what I'm working on" ? 'the other task' : curLabel;
        await ctx.reply(`⚡ Doing that right now — I'll keep ${other} running too.`);
      } else if (intent === 'cancel') {
        await ctx.reply(
          dropped > 0
            ? `🗑️ Done — cancelled ${dropped} queued task${dropped === 1 ? '' : 's'}. I'll let what's already running finish.`
            : "🗑️ Nothing was waiting in the queue to cancel — and I won't cut off what's already running."
        );
      } else {
        await ctx.reply(`👍 Got it — I'll get to that right after I finish ${curLabel}.`);
      }
    } catch (e) {
      console.error('[Queue] ack failed:', e.message);
    }
  }

  const taskQueue = createTaskQueue({
    classify: classifyInterrupt,
    onAck: ackTask,
    log: (m) => console.log('[Queue]', m),
  });

  // Submit a unit of work. `text` feeds the classifier, `label` is a friendly
  // name used in acknowledgements, `run` is the async worker. Typing shows for
  // the duration of the actual work.
  function submitTask(ctx, chatId, { text, label, run }) {
    return taskQueue.submit(chatId, {
      text,
      label,
      ctx,
      run: () => withTyping(ctx, run),
    });
  }

  bot.command('start', async (ctx) => {
    console.log(`[Bot] /start from ${ctx.from.first_name} (${ctx.from.id}), chat ${ctx.chat.id}`);
    await ctx.reply(
      `🔨 Welcome to TrendForge v${VERSION}!\n\n` +
      'I\'m your AI-powered tech assistant. I can:\n\n' +
      '- Fetch trends from GitHub, HN, Reddit, Product Hunt, Dev.to\n' +
      '- Analyze files you send me (text, PDF, DOCX, images, code)\n' +
      '- Set up complex schedules (multiple daily reports, bimonthly patterns, etc.)\n' +
      '- Set reminders and remember things for you\n' +
      '- Fetch data from any URL & run system info commands\n\n' +
      'QUICK START\n' +
      '/report — get a trend report now\n' +
      '/ideas — creative project ideas from today\'s trends\n' +
      '/model — view or switch the AI model\n' +
      '/config — set up API keys (read from .env)\n' +
      '/help — see all commands\n\n' +
      'SELF-HOSTING? Add your API key(s) to the .env file (see .env.example), then /restart. ' +
      'Run /config anytime to see which providers are active. For security, keys are never typed in chat.\n\n' +
      'You can also just talk to me naturally — "What\'s trending on GitHub?", "Remind me in 30 minutes to check the deploy", etc.'
    );
  });

  // On-demand project ideas. The daily report no longer carries a PROJECT IDEAS
  // section (it's now a tight Top-3 + signal); users pull ideas when they want
  // them. Reuses the normal text pipeline so it fetches live data and synthesizes.
  bot.command('ideas', (ctx) => {
    console.log(`[Bot] /ideas from ${ctx.from?.first_name} (${ctx.from?.id})`);
    const chatId = ctx.chat.id;
    submitTask(ctx, chatId, {
      text: '/ideas — creative project ideas',
      label: 'those project ideas',
      run: () => processTextMessage(ctx, chatId, IDEAS_PROMPT),
    });
  });

  // ---- v3.4 command set ----------------------------------------------------

  bot.command('help', async (ctx) => {
    await ctx.reply(HELP_TEXT);
  });

  bot.command('version', async (ctx) => {
    const prefs = loadPreferences();
    await ctx.reply(`🔨 TrendForge v${VERSION}\nNode ${process.version}\nModel: ${prefs.model}`);
  });

  bot.command('status', async (ctx) => {
    const prefs = loadPreferences();
    const available = getAvailableModels();
    const all = getAllModels();
    const activeModel = available.includes(prefs.model) ? prefs.model : (available[0] || 'none');
    const custom = listSchedules().filter((s) => s.source === 'custom');
    const enabled = Array.isArray(prefs.enabledSources) && prefs.enabledSources.length ? prefs.enabledSources : ALL_SOURCES;
    const state = prefs.paused ? '⏸️ PAUSED' : '▶️ active';
    const modelNote = activeModel !== prefs.model ? ` (pref "${prefs.model}" has no key)` : '';
    await ctx.reply(
      [
        `📊 TrendForge v${VERSION} — ${state}`,
        `Uptime: ${formatUptime(process.uptime())}`,
        `Model: ${activeModel}${modelNote}`,
        `Models with key: ${available.length}/${all.length}`,
        `Daily report: ${prefs.reportEnabled === false ? 'off' : humanizeCron(prefs.reportCron || '0 6 * * *')}`,
        `Custom schedules: ${custom.length}`,
        `Sources: ${enabled.join(', ')}`,
        `Timezone: ${prefs.timezone}`,
      ].join('\n')
    );
  });

  bot.command('restart', async (ctx) => {
    console.log(`[Bot] /restart requested by ${ctx.from?.id}`);
    await ctx.reply("♻️ Restarting TrendForge… back in a few seconds.");
    // Give Telegram a moment to flush the reply; pm2 will kill+respawn this process.
    setTimeout(() => {
      try {
        execSync(`pm2 restart ${PM2_NAME}`, { timeout: 15000 });
      } catch (e) {
        console.error('[Bot] /restart failed:', e.message);
      }
    }, 800);
  });

  bot.command('update', async (ctx) => {
    console.log(`[Bot] /update requested by ${ctx.from?.id}`);
    if (updateInProgress) {
      await ctx.reply('⏳ An update is already in progress — hang tight.');
      return;
    }
    updateInProgress = true;
    try {
      await ctx.reply('🔎 Checking GitHub for a newer version…');

      // The check does a network fetch and may throw (offline, not a git
      // checkout). Route genuine exceptions through the AI error explainer.
      let info;
      try {
        info = checkForUpdate();
      } catch (e) {
        console.error('[Bot] /update check failed:', e.message);
        const explanation = await handleError({ err: e, where: 'checking for a TrendForge update' });
        await sendLong(ctx, explanation);
        return;
      }

      if (!info.available) {
        await ctx.reply(`✅ Already on the latest version${info.localVersion ? ` (v${info.localVersion})` : ''}. Nothing to update.`);
        return;
      }

      const verLine = info.localVersion && info.remoteVersion && info.localVersion !== info.remoteVersion
        ? `v${info.localVersion} → v${info.remoteVersion}`
        : `${info.behind} new commit${info.behind === 1 ? '' : 's'}`;
      const changes = info.changelog && info.changelog.length
        ? '\n\nWhat\'s changing:\n' + info.changelog.slice(0, 8).map((c) => `• ${c}`).join('\n')
        : '';
      await ctx.reply(`⬇️ Update found (${verLine}). Pulling, health-checking and applying now…${changes}`);

      // applyUpdate never throws; it returns a structured, already-friendly
      // result for each stage (incl. auto-rollback on a bad boot).
      const result = applyUpdate();

      if (!result.ok) {
        console.error(`[Bot] /update failed at ${result.stage}:`, result.message);
        const rolled = result.rolledBack ? ' Your bot is still running the previous working version.' : '';
        await sendLong(ctx, `⚠️ Update could not be applied (${result.stage}): ${result.message}${rolled}`);
        return;
      }

      if (!result.updated) {
        await ctx.reply('✅ Already up to date.');
        return;
      }

      const dp = result.dataProtected;
      const dataNote = dp && dp.allProtected
        ? 'All your data (settings, memories, schedules, notes) is preserved.'
        : (dp ? `⚠️ Heads up: these files are NOT gitignored and could be affected: ${dp.unprotected.join(', ')}.` : '');
      await ctx.reply(`✅ Updated${result.remoteVersion ? ` to v${result.remoteVersion}` : ''} and health check passed. ${dataNote}\n♻️ Restarting now to run the new version…`);

      // Let Telegram flush the reply, then let pm2 respawn us on the new code.
      setTimeout(() => {
        try {
          execSync(`pm2 restart ${PM2_NAME}`, { timeout: 15000 });
        } catch (e) {
          console.error('[Bot] /update restart failed:', e.message);
        }
      }, 1000);
    } finally {
      updateInProgress = false;
    }
  });

  bot.command('report', (ctx) => {
    console.log(`[Bot] /report requested by ${ctx.from?.id}`);
    const chatId = ctx.chat.id;
    submitTask(ctx, chatId, {
      text: '/report — generate a trend report',
      label: 'your trend report',
      run: async () => {
        await ctx.reply('📡 Generating your trend report now…');
        try {
          const report = await generateDailyReport();
          await sendReportHTML(bot.api, ctx.chat.id, report);
        } catch (e) {
          console.error('[Bot] /report failed:', e.message);
          const explanation = await handleError({ err: e, where: 'generating your trend report' });
          await sendLong(ctx, explanation);
        }
      },
    });
  });

  bot.command('model', async (ctx) => {
    const arg = (ctx.match || '').trim();
    const prefs = loadPreferences();
    const available = getAvailableModels();
    const all = getAllModels();
    if (!arg) {
      const list = all.map((m) => `${m === prefs.model ? '➡️' : '  '} ${m}${available.includes(m) ? '' : ' (no key)'}`).join('\n');
      await ctx.reply(`🤖 Current model: ${prefs.model}\nModels with a key: ${available.length}\n\n${list}\n\nSwitch with: /model <name>`);
      return;
    }
    if (!all.includes(arg)) {
      await ctx.reply(`Unknown model "${arg}". Run /model to see the list.`);
      return;
    }
    if (!available.includes(arg)) {
      // Evan's canonical case: don't hand back a canned line — let the AI explain
      // the exact situation (which key is missing, what's ready to use instead).
      const provider = getProviderForModel(arg);
      const explanation = await handleError({
        err: new Error(`No API key set for model "${arg}".`),
        where: 'switching the AI model',
        extra: {
          attemptedModel: arg,
          neededKey: provider ? provider.envKey : 'the matching provider key',
          attemptedProvider: provider ? provider.name : 'unknown',
        },
      });
      await sendLong(ctx, explanation);
      return;
    }
    updatePreferences({ model: arg });
    await ctx.reply(`✅ Model switched to ${arg}.`);
  });

  bot.command('sources', async (ctx) => {
    const prefs = loadPreferences();
    let enabled = Array.isArray(prefs.enabledSources) && prefs.enabledSources.length ? [...prefs.enabledSources] : [...ALL_SOURCES];
    const arg = (ctx.match || '').trim().toLowerCase();
    if (!arg) {
      const list = ALL_SOURCES.map((s) => `${enabled.includes(s) ? '✅' : '❌'} ${s}`).join('\n');
      await ctx.reply(`📡 Trend sources:\n${list}\n\nToggle with: /sources <name>\n(github, hn, reddit, ph, devto)`);
      return;
    }
    const key = SOURCE_ALIASES[arg] || arg;
    if (!ALL_SOURCES.includes(key)) {
      await ctx.reply(`Unknown source "${arg}". Valid: ${ALL_SOURCES.join(', ')}`);
      return;
    }
    const turningOff = enabled.includes(key);
    if (turningOff) enabled = enabled.filter((s) => s !== key);
    else enabled.push(key);
    if (!enabled.length) {
      await ctx.reply('At least one source must stay enabled.');
      return;
    }
    updatePreferences({ enabledSources: enabled });
    await ctx.reply(`✅ ${key} ${turningOff ? 'disabled' : 'enabled'}.\nActive: ${enabled.join(', ')}`);
  });

  bot.command('remember', async (ctx) => {
    const text = (ctx.match || '').trim();
    if (!text) {
      await ctx.reply('Tell me what to remember:\n/remember <text>');
      return;
    }
    const r = addMemory(text);
    await ctx.reply(`🧠 Got it — remembered as #${r.id}.`);
  });

  bot.command('recall', async (ctx) => {
    const entries = listMemories();
    if (!entries.length) {
      await ctx.reply('🧠 I have no saved memories yet. Add one with /remember <text>.');
      return;
    }
    const body = entries.map((e) => `#${e.id} · ${e.text}`).join('\n');
    await sendLong(ctx, `🧠 What I remember (${entries.length}):\n${body}`);
  });

  bot.command('recallraw', async (ctx) => {
    const raw = rawMemories();
    const payload = `<pre>${escapeHtml(raw)}</pre>`;
    if (payload.length <= 4096) {
      await ctx.reply(payload, { parse_mode: 'HTML' });
    } else {
      await sendLong(ctx, raw); // too big for one HTML block; send verbatim plain text
    }
  });

  bot.command('forget', async (ctx) => {
    const arg = (ctx.match || '').trim();
    if (!arg) {
      await ctx.reply('What should I forget?\n/forget <id> · /forget <text> · /forget all');
      return;
    }
    const r = forgetMemory(arg);
    if (r.mode === 'all') {
      await ctx.reply(`🧹 Cleared ${r.removed} memor${r.removed === 1 ? 'y' : 'ies'}.`);
    } else if (r.removed === 0) {
      await ctx.reply(`Nothing matched "${arg}". Run /recall to see ids.`);
    } else {
      await ctx.reply(`🧹 Forgot ${r.removed} memor${r.removed === 1 ? 'y' : 'ies'}.`);
    }
  });

  bot.command('schedules', async (ctx) => {
    const all = listSchedules();
    const prefs = loadPreferences();
    const lines = all.map((s) => describeSchedule(s));
    const header = prefs.paused
      ? "🗓 Here's what I have scheduled (everything is paused right now — say /resume to switch it back on):"
      : "🗓 Here's what I have scheduled for you:";
    const tip = '\n\nWant to change anything? Just tell me in plain words — e.g. "send the report at 8am instead" or "add a Friday 5pm digest".';
    await ctx.reply(`${header}\n\n${lines.join('\n')}${tip}`);
  });

  bot.command('pause', async (ctx) => {
    updatePreferences({ paused: true });
    stopCron();
    await ctx.reply('⏸️ Automatic reports paused. Your schedules are kept — resume anytime with /resume.');
  });

  bot.command('resume', async (ctx) => {
    updatePreferences({ paused: false });
    restartCron();
    await ctx.reply('▶️ Automatic reports resumed.');
  });

  bot.command('config', async (ctx) => {
    const prefs = loadPreferences();
    const status = getProviderStatus();
    const lines = status.map((p) => `${p.configured ? '✅' : '❌'} <b>${p.name}</b> — <code>${p.envKey}</code>`);
    const haveAny = status.some((p) => p.configured);
    const text =
      '⚙️ <b>Configuration</b>\n\n' +
      `Active model: <code>${escapeHtml(prefs.model)}</code>\n\n` +
      `<b>API providers</b> (✅ = key detected):\n${lines.join('\n')}\n\n` +
      'Keys are read from your <code>.env</code> file at startup — for security they are never typed in chat.\n' +
      'To enable a provider: add its key to <code>.env</code> (see <code>.env.example</code>), then run /restart.\n\n' +
      'Switch model: /model &lt;name&gt;   ·   Toggle sources: /sources' +
      (haveAny ? '' : '\n\n⚠️ No API keys detected — the bot cannot call any model yet.');
    await ctx.reply(text, { parse_mode: 'HTML', disable_web_page_preview: true });
  });

  // --------------------------------------------------------------------------

  function buildMessageContext(ctx) {
    const msg = ctx.message;
    let text = msg.text || msg.caption || '';
    const parts = [];

    if (msg.reply_to_message) {
      const reply = msg.reply_to_message;
      const replyText = reply.text || reply.caption || '';
      if (replyText) {
        const replyFrom = reply.from?.first_name || 'someone';
        parts.push(`[Replying to ${replyFrom}: "${replyText.substring(0, 300)}"]`);
      }
    }

    if (msg.forward_origin || msg.forward_from || msg.forward_from_chat) {
      const fwdName = msg.forward_from?.first_name || msg.forward_from_chat?.title || 'unknown';
      parts.push(`[Forwarded from ${fwdName}]`);
    }

    if (msg.sticker) {
      const emoji = msg.sticker.emoji || '';
      parts.push(`[Sticker: ${emoji} "${msg.sticker.set_name || 'custom'}"]`);
    }

    if (msg.emoji) {
      parts.push(`[Emoji: ${msg.emoji}]`);
    }

    if (parts.length > 0) {
      text = parts.join(' ') + (text ? '\n' + text : '');
    }

    return text;
  }

  bot.on('message:text', (ctx) => {
    // Commands have their own handlers and stop propagation; this only fires for
    // plain text (and unknown /commands, which we let the model answer).
    if (ctx.message.text === '/start') return;
    const chatId = ctx.chat.id;
    const text = buildMessageContext(ctx);
    submitTask(ctx, chatId, {
      text,
      run: () => processTextMessage(ctx, chatId, text),
    });
  });

  bot.on('message:sticker', (ctx) => {
    const chatId = ctx.chat.id;
    const emoji = ctx.message.sticker.emoji || '🙂';
    const setName = ctx.message.sticker.set_name || 'custom';
    const text = `[Sticker: ${emoji} from "${setName}"]`;
    submitTask(ctx, chatId, {
      text,
      run: () => processTextMessage(ctx, chatId, text),
    });
  });

  bot.on(['message:document', 'message:photo'], async (ctx) => {
    const chatId = ctx.chat.id;
    const msg = ctx.message;

    let fileId, fileName;
    if (msg.document) {
      fileId = msg.document.file_id;
      fileName = msg.document.file_name || 'file';
    } else if (msg.photo) {
      const largest = msg.photo[msg.photo.length - 1];
      fileId = largest.file_id;
      fileName = 'photo.jpg';
    }

    const caption = buildMessageContext(ctx);
    const fileType = classifyFile(fileName);

    if (!fileType && msg.document) {
      await ctx.reply(`I don't support that file type yet. Supported: ${getSupportedExtensions().join(', ')}`);
      return;
    }

    const payload = {
      type: 'file',
      fileId,
      fileName,
      fileType: fileType || 'image',
      caption: caption || 'Analyze this file',
    };
    submitTask(ctx, chatId, {
      text: caption || `a file (${fileName})`,
      label: 'that file',
      run: () => processFileMessage(ctx, chatId, payload),
    });
  });

  async function processFileMessage(ctx, chatId, payload) {
    const prefs = loadPreferences();
    const available = getAvailableModels();
    const allModels = getAllModels();
    const model = available.includes(prefs.model) ? prefs.model : available[0];
    if (!model) {
      const explanation = await handleError({ err: new Error('No AI model available — no provider key is set.'), where: 'analyzing your file' });
      await sendLong(ctx, explanation);
      return;
    }

    try {
      const { buffer, fileName: dlName } = await downloadTelegramFile(bot, payload.fileId);
      const fileName = payload.fileName || dlName;

      if (payload.fileType === 'image') {
        const base64 = getImageBase64(buffer);
        const mimeType = getMimeType(fileName);

        if (supportsVision(model)) {
          addToHistory(chatId, 'user', `[Sent image: ${fileName}] ${payload.caption}`);
          const history = getHistory(chatId);
          const systemPrompt = buildSystemPrompt(prefs, allModels);
          const response = await chatWithVision(model, [
            { role: 'system', content: systemPrompt },
            ...history,
          ], base64, mimeType);
          const cleaned = cleanOutput(response) || 'I analyzed the image but couldn\'t generate a description.';
          addToHistory(chatId, 'assistant', cleaned);
          await sendLong(ctx, cleaned);
        } else {
          await ctx.reply(`The current model (${model}) doesn't support image analysis. Switch to a vision model like gpt-4o, claude-sonnet-4-6, or gemini-3-flash for image support.`);
        }
        return;
      }

      const text = await extractText(buffer, fileName);
      if (!text) {
        await ctx.reply(`Couldn't extract text from ${fileName}. The file might be empty or in an unsupported format.`);
        return;
      }

      const truncated = text.length > 10000 ? text.substring(0, 10000) + '\n[... truncated]' : text;
      const userMsg = `[File uploaded: ${fileName} (${buffer.length} bytes)]\n\nFile content:\n${truncated}\n\nUser's request: ${payload.caption}`;
      addToHistory(chatId, 'user', userMsg);

      const history = getHistory(chatId);
      const systemPrompt = buildSystemPrompt(prefs, allModels);
      const response = await chat(model, [
        { role: 'system', content: systemPrompt },
        ...history,
      ]);

      const parsed = parseResponse(response);
      if (parsed.actions.length > 0) {
        const results = await executeActions(parsed.actions, prefs, ctx, chatId);
        const hasData = results.some(r => r.type === 'data');
        if (hasData) {
          const ack = cleanOutput(parsed.cleanText) || 'Processing...';
          await ctx.reply(ack);
          const resultsText = formatActionResults(results);
          const phase2 = await chat(model, [
            { role: 'system', content: systemPrompt }, ...history,
            { role: 'assistant', content: ack },
            { role: 'user', content: `[Action results]\n\n${resultsText}\n\nProvide your detailed response. Plain text only.` },
          ]);
          const cleaned = cleanOutput(phase2) || 'Done processing.';
          addToHistory(chatId, 'assistant', cleaned);
          await sendLong(ctx, cleaned);
        } else {
          const cleaned = cleanOutput(parsed.cleanText) || generateConfirmation(results);
          addToHistory(chatId, 'assistant', cleaned);
          await sendLong(ctx, cleaned);
        }
      } else {
        const cleaned = cleanOutput(parsed.cleanText) || 'I analyzed the file but couldn\'t generate a summary.';
        addToHistory(chatId, 'assistant', cleaned);
        await sendLong(ctx, cleaned);
      }
    } catch (err) {
      console.error('[Bot] File processing error:', err.message);
      const explanation = await handleError({ err, where: 'analyzing your file', extra: { fileType: payload.fileType } });
      await sendLong(ctx, explanation);
    }
  }

  async function processTextMessage(ctx, chatId, combinedText) {
    addToHistory(chatId, 'user', combinedText);

    const prefs = loadPreferences();
    const available = getAvailableModels();
    const allModels = getAllModels();
    const model = available.includes(prefs.model) ? prefs.model : available[0];

    if (!model) {
      const explanation = await handleError({ err: new Error('No AI model available — no provider key is set.'), where: 'processing your message' });
      await sendLong(ctx, explanation);
      return;
    }

    const history = getHistory(chatId);
    const systemPrompt = buildSystemPrompt(prefs, allModels);

    try {
      const phase1Response = await chat(model, [
        { role: 'system', content: systemPrompt },
        ...history,
      ]);

      const parsed = parseResponse(phase1Response);

      if (parsed.actions.length > 0) {
        const results = await executeActions(parsed.actions, prefs, ctx, chatId);
        const hasData = results.some(r => r.type === 'data');

        if (hasData) {
          const ack = cleanOutput(parsed.cleanText) || 'Let me process that for you...';
          await ctx.reply(ack);

          const resultsText = formatActionResults(results);
          const phase2Response = await chat(model, [
            { role: 'system', content: systemPrompt },
            ...history,
            { role: 'assistant', content: ack },
            { role: 'user', content: `[Action results]\n\n${resultsText}\n\nNow provide your detailed response based on these results. Remember: plain text only, no markdown, no HTML. Be detailed and insightful.` },
          ]);

          const cleaned = cleanOutput(phase2Response) || 'Here are the results, but I had trouble formatting them.';
          addToHistory(chatId, 'assistant', cleaned);
          await sendLong(ctx, cleaned);
        } else {
          let response = cleanOutput(parsed.cleanText);
          if (!response) {
            response = generateConfirmation(results);
          }
          addToHistory(chatId, 'assistant', response);
          await sendLong(ctx, response);
        }
      } else {
        let cleaned = cleanOutput(parsed.cleanText);
        if (!cleaned) cleaned = 'I\'m not sure how to respond to that. Try asking about tech trends, schedules, project ideas, or say "show my settings"!';
        addToHistory(chatId, 'assistant', cleaned);
        await sendLong(ctx, cleaned);
      }
    } catch (err) {
      console.error('[Bot] Error:', err.message);
      const explanation = await handleError({ err, where: 'processing your message' });
      await sendLong(ctx, explanation);
    }
  }

  function generateConfirmation(results) {
    const parts = [];
    for (const r of results) {
      if (r.type === 'confirmation') {
        if (typeof r.result === 'object') {
          if (r.result.success === false) parts.push(`Failed: ${r.result.error}`);
          else if (r.result.name) {
            const when = r.result.cron ? ` — ${humanizeCron(r.result.cron)}` : '';
            parts.push(`Done: ${r.result.description || r.result.name}${when}`);
          } else parts.push('Done!');
        } else {
          parts.push(String(r.result));
        }
      } else if (r.type === 'error') {
        parts.push(`Error: ${r.result}`);
      }
    }
    return parts.length > 0 ? parts.join('\n') : 'Done!';
  }

  async function executeActions(actions, prefs, ctx, chatId) {
    const results = [];
    for (const action of actions) {
      try {
        const result = await executeAction(action, prefs, ctx, chatId);
        results.push(result);
      } catch (err) {
        console.error(`[Bot] Action "${action.action}" failed:`, err.message);
        results.push({ type: 'error', action: action.action, result: err.message });
      }
    }
    return results;
  }

  async function executeAction(action, prefs, ctx, chatId) {
    const type = action.action;
    const params = action.params || {};

    switch (type) {
      case 'fetch_data': {
        let sources = params.sources || [];
        if (typeof sources === 'string') sources = sources.split(',').map(s => s.trim());
        if (sources.includes('all')) sources = ['github', 'hn', 'reddit', 'ph', 'devto'];
        const data = await fetchSources(sources, prefs);
        return { type: 'data', action: type, result: formatDataForAI(data) };
      }

      case 'update_settings': {
        const settings = params.settings || params;
        const settingsObj = normalizeSettings(settings);
        if (settingsObj && Object.keys(settingsObj).length > 0) {
          applySettings(settingsObj);
          return { type: 'confirmation', action: type, result: { success: true, updated: Object.keys(settingsObj) } };
        }
        return { type: 'error', action: type, result: 'No valid settings to update' };
      }

      case 'add_schedule': {
        const result = addSchedule(params.name, {
          cron: params.cron,
          type: params.type || 'report',
          description: params.description || params.name,
          message: params.message,
          enabled: params.enabled,
        });
        return { type: 'confirmation', action: type, result };
      }

      case 'remove_schedule': {
        const result = removeSchedule(params.name);
        return { type: 'confirmation', action: type, result };
      }

      case 'list_schedules': {
        const schedules = listSchedules();
        let text = 'Active schedules:\n';
        for (const s of schedules) {
          const status = s.enabled ? 'ON' : 'OFF';
          text += `- ${s.name} [${status}]: ${s.description} (cron: ${s.cron}, type: ${s.type})\n`;
        }
        return { type: 'data', action: type, result: text };
      }

      case 'reminder': {
        const delayMin = params.delay_minutes || params.minutes || 1;
        const msg = params.message || 'Reminder!';
        const delayMs = Math.max(1, Math.min(delayMin, 1440)) * 60 * 1000;
        const timerId = setTimeout(async () => {
          try {
            await ctx.reply(`⏰ Reminder: ${msg}`);
          } catch (e) {
            console.error('[Reminder] Failed:', e.message);
          }
          activeReminders.delete(timerId);
        }, delayMs);
        activeReminders.set(timerId, { message: msg, chatId, firesAt: Date.now() + delayMs });
        return { type: 'confirmation', action: type, result: `Reminder set for ${delayMin} minute(s): "${msg}"` };
      }

      case 'http_fetch': {
        const url = params.url;
        if (!url) return { type: 'error', action: type, result: 'No URL provided' };
        try {
          const resp = await axios.get(url, {
            timeout: 15000,
            maxContentLength: 100000,
            headers: { 'User-Agent': 'TrendForge/3.2' },
          });
          let content;
          if (typeof resp.data === 'string') {
            content = resp.data.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').substring(0, 5000);
          } else {
            content = JSON.stringify(resp.data, null, 2).substring(0, 5000);
          }
          return { type: 'data', action: type, result: `Content from ${url}:\n${content}` };
        } catch (e) {
          return { type: 'error', action: type, result: `Fetch failed: ${e.message}` };
        }
      }

      case 'shell': {
        const cmd = params.command;
        if (!cmd) return { type: 'error', action: type, result: 'No command provided' };
        if (!isSafeCommand(cmd)) {
          return { type: 'error', action: type, result: `Command not allowed. Safe commands: uptime, date, df, node, npm, pm2, git status/log, ls, cat, head, tail, wc, ping, curl` };
        }
        try {
          const output = execSync(cmd, { timeout: 10000, encoding: 'utf-8', maxBuffer: 50000 });
          return { type: 'data', action: type, result: `$ ${cmd}\n${output.substring(0, 3000)}` };
        } catch (e) {
          return { type: 'error', action: type, result: `Command failed: ${e.stderr || e.message}` };
        }
      }

      case 'note_save': {
        if (!params.name || !params.content) return { type: 'error', action: type, result: 'Need name and content' };
        saveNote(params.name, params.content);
        return { type: 'confirmation', action: type, result: `Note "${params.name}" saved` };
      }

      case 'note_read': {
        const note = readNote(params.name);
        if (!note) return { type: 'error', action: type, result: `Note "${params.name}" not found` };
        return { type: 'data', action: type, result: `Note "${note.name}" (updated ${note.updatedAt}):\n${note.content}` };
      }

      case 'note_list': {
        const notes = listNotes();
        if (notes.length === 0) return { type: 'data', action: type, result: 'No notes saved yet.' };
        let text = 'Saved notes:\n';
        for (const n of notes) {
          text += `- ${n.name} (updated ${n.updatedAt}): ${n.preview}\n`;
        }
        return { type: 'data', action: type, result: text };
      }

      case 'note_delete': {
        const result = deleteNote(params.name);
        return { type: result.success ? 'confirmation' : 'error', action: type, result: result.success ? `Note "${params.name}" deleted` : result.error };
      }

      default:
        return { type: 'error', action: type, result: `Unknown action: "${type}"` };
    }
  }

  function isSafeCommand(cmd) {
    const dangerous = /\b(rm|rmdir|kill|killall|shutdown|reboot|mkfs|dd|chmod|chown|passwd|sudo|su)\b/;
    if (dangerous.test(cmd)) return false;
    if (/[>|&;]/.test(cmd) && !/\|/.test(cmd)) return false;
    if (cmd.includes('> /') || cmd.includes('>> ')) return false;
    const binary = cmd.trim().split(/\s+/)[0];
    const allowed = new Set([
      'uptime', 'date', 'whoami', 'hostname', 'uname', 'df', 'du', 'free', 'top',
      'node', 'npm', 'npx', 'pm2', 'git', 'cat', 'ls', 'head', 'tail', 'wc',
      'ping', 'curl', 'wget', 'echo', 'which', 'env', 'printenv', 'pwd',
    ]);
    return allowed.has(binary);
  }

  function normalizeSettings(raw) {
    const allowed = new Set([
      'interests', 'languages', 'avoidTopics', 'ideaStyle', 'model',
      'reportEnabled', 'reportCron', 'reportScheduleText', 'dailyReportTime', 'timezone',
      'maxGitHubRepos', 'maxHNStories', 'maxRedditPosts', 'maxPHProducts', 'maxDevToArticles',
    ]);
    const aliases = {
      report_schedule: 'reportScheduleText', report_time: 'dailyReportTime',
      report_cron: 'reportCron', report_enabled: 'reportEnabled',
      avoid_topics: 'avoidTopics', idea_style: 'ideaStyle',
      daily_report_time: 'dailyReportTime', schedule_text: 'reportScheduleText',
      max_github_repos: 'maxGitHubRepos', max_hn_stories: 'maxHNStories',
      max_reddit_posts: 'maxRedditPosts', max_ph_products: 'maxPHProducts',
      max_devto_articles: 'maxDevToArticles',
    };
    const result = {};
    for (const [key, value] of Object.entries(raw)) {
      if (key === 'settings' && typeof value === 'object') {
        Object.assign(result, normalizeSettings(value));
        continue;
      }
      const normalizedKey = aliases[key] || key;
      if (allowed.has(normalizedKey)) result[normalizedKey] = value;
    }
    return Object.keys(result).length > 0 ? result : null;
  }

  function applySettings(settingsUpdate) {
    try {
      updatePreferences(settingsUpdate);
      console.log('[Bot] Settings updated:', JSON.stringify(settingsUpdate));
      const scheduleFields = ['reportEnabled', 'reportCron', 'reportScheduleText', 'dailyReportTime', 'timezone'];
      if (scheduleFields.some(f => f in settingsUpdate)) {
        restartCron();
        console.log('[Bot] Cron restarted after schedule change');
      }
    } catch (e) {
      console.error('[Bot] Settings update failed:', e.message);
    }
  }

  function buildSystemPrompt(prefs, allModels) {
    const schedule = scheduleLabel(prefs);
    const customSchedules = listSchedules().filter(s => s.source === 'custom');
    const scheduleInfo = customSchedules.length > 0
      ? customSchedules.map(s => `  - ${s.name}: ${s.description} [${s.cron}] (${s.enabled ? 'ON' : 'OFF'})`).join('\n')
      : '  (none)';

    return `You are TrendForge, an intelligent tech assistant running as a Telegram bot. You help users with tech trends, project ideas, scheduling, reminders, notes, file analysis, and general tech conversation.

FILE ANALYSIS:
Users can send files directly in Telegram. You'll receive their content inline. Supported types:
- Text/markup: .txt, .md, .csv, .json, .html
- Documents: .pdf, .docx
- Images: .png, .jpg, .jpeg, .avif (requires vision-capable model)
When you receive file content, analyze it thoroughly and respond to the user's question about it.

TELEGRAM FEATURES:
- When the user replies to your message, context from the replied message is included as [Replying to ...]
- Forwarded messages include [Forwarded from ...] context
- Stickers are shown as [Sticker: emoji "set_name"]
- Respond naturally to all of these -- acknowledge replies, react to stickers with matching energy, etc.

ACTIONS SYSTEM:
You can perform actions by including an [ACTIONS] block at the END of your message. It contains a JSON array of action objects.

Format:
[ACTIONS]
[{"action": "action_name", "params": {...}}, ...]
[/ACTIONS]

CRITICAL RULES:
- ALWAYS write a conversational message BEFORE the [ACTIONS] block
- The text before [ACTIONS] is shown to the user while actions execute
- Never respond with ONLY an [ACTIONS] block and no text
- You can chain MULTIPLE actions in one block
- For simple conversation or questions, respond WITHOUT any [ACTIONS] block

AVAILABLE ACTIONS:

1. fetch_data - Fetch live data from sources
   params: {"sources": ["github", "hn", "reddit", "ph", "devto"]}
   Use ["all"] for all 5 sources. Only use when you need CURRENT live data.

2. update_settings - Change user preferences
   params: {"settings": {"field": "value", ...}}
   Fields: interests (array), languages (array), avoidTopics (array), ideaStyle (string: "practical"/"ambitious"/"experimental"), model (string), reportEnabled (boolean), reportCron (5-field cron string), reportScheduleText (string), dailyReportTime (HH:MM), timezone (IANA string), maxGitHubRepos (1-25), maxHNStories (1-30), maxRedditPosts (1-30), maxPHProducts (1-10), maxDevToArticles (1-15)

3. add_schedule - Create a named recurring schedule
   params: {"name": "unique-name", "cron": "min hour dom month dow", "type": "report" or "message", "description": "human-readable description", "message": "text for message-type schedules"}
   SCHEDULING TIPS:
   - Cron: minute(0-59) hour(0-23) dayOfMonth(1-31) month(1-12) dayOfWeek(0-6, 0=Sun)
   - For "every 2 months" use months: 1,3,5,7,9,11 or 2,4,6,8,10,12
   - For "3rd week" use days 15-21
   - For "twice daily" create TWO schedules with different names
   - For complex patterns, create MULTIPLE schedules each handling one part

4. remove_schedule - Remove a schedule by name
   params: {"name": "schedule-name"}

5. list_schedules - List all active schedules
   params: {}

6. reminder - Set a one-time reminder (max 24 hours)
   params: {"message": "reminder text", "delay_minutes": number}

7. http_fetch - Fetch content from any URL
   params: {"url": "https://..."}

8. shell - Run a safe system command (read-only, no destructive ops)
   params: {"command": "command string"}
   Allowed: uptime, date, df, node, npm, pm2, git, ls, cat, head, tail, curl, ping, etc.

9. note_save - Save a persistent note
   params: {"name": "note-name", "content": "note content"}

10. note_read - Read a saved note
    params: {"name": "note-name"}

11. note_list - List all saved notes
    params: {}

12. note_delete - Delete a saved note
    params: {"name": "note-name"}

EXAMPLES:

User: "What's trending on GitHub?"
Response: Let me check GitHub trending for you!
[ACTIONS]
[{"action": "fetch_data", "params": {"sources": ["github"]}}]
[/ACTIONS]

User: "Report me 2 times a day but 3 times on the 3rd week of every 2 months"
Response: I'll set that up! Creating multiple schedules to cover your pattern.
[ACTIONS]
[{"action": "add_schedule", "params": {"name": "daily-morning", "cron": "0 9 * * *", "type": "report", "description": "Daily morning report at 9am"}},
{"action": "add_schedule", "params": {"name": "daily-evening", "cron": "0 21 * * *", "type": "report", "description": "Daily evening report at 9pm"}},
{"action": "add_schedule", "params": {"name": "bimonthly-3rdweek-noon", "cron": "0 12 15-21 1,3,5,7,9,11 *", "type": "report", "description": "Extra noon report on 3rd week of odd months"}}]
[/ACTIONS]

User: "Remind me in 30 minutes to review the PR"
Response: Got it, I'll remind you in 30 minutes!
[ACTIONS]
[{"action": "reminder", "params": {"message": "Review the PR", "delay_minutes": 30}}]
[/ACTIONS]

User: "Save a note called 'project-idea' about building a CLI tool for git stats"
Response: Saved that note for you!
[ACTIONS]
[{"action": "note_save", "params": {"name": "project-idea", "content": "Build a CLI tool for git stats - analyze commit patterns, contributor activity, and code churn across repos"}}]
[/ACTIONS]

User: "What's the server uptime and show me my notes?"
Response: Let me check both for you!
[ACTIONS]
[{"action": "shell", "params": {"command": "uptime"}},
{"action": "note_list", "params": {}}]
[/ACTIONS]

User: "What are my settings?"
Response: (respond directly with current settings - no actions needed)

User: "Tell me about React 19"
Response: (respond from knowledge - no actions needed)

CURRENT USER SETTINGS:
- Interests: ${prefs.interests.join(', ')}
- Languages: ${prefs.languages.join(', ')}
- Avoid topics: ${prefs.avoidTopics.length ? prefs.avoidTopics.join(', ') : 'none'}
- Idea style: ${prefs.ideaStyle}
- AI Model: ${prefs.model}
- Default report: ${schedule} (enabled: ${prefs.reportEnabled !== false})
- Timezone: ${prefs.timezone}
- Limits: GitHub ${prefs.maxGitHubRepos}, HN ${prefs.maxHNStories}, Reddit ${prefs.maxRedditPosts}, PH ${prefs.maxPHProducts}, Dev.to ${prefs.maxDevToArticles}
- Available models: ${allModels.join(', ')}

CUSTOM SCHEDULES:
${scheduleInfo}

RESPONSE FORMAT (CRITICAL):
- Write CLEAN PLAIN TEXT only
- NEVER use Markdown: no *, **, _, \`, #, []()
- NEVER use HTML: no <b>, <i>, <code>
- Use emoji for visual structure
- Use numbered lists and dashes
- Use ALL CAPS sparingly for emphasis
- Be conversational, detailed, and insightful
- When you mention schedules or times, describe them in plain English (e.g. "every day at 6 AM", "every Friday at 5 PM") — NEVER show raw cron expressions or internal schedule ids to the user`;
  }

  function parseResponse(text) {
    let cleanText = text;
    let actions = [];

    const actionsMatch = cleanText.match(/\[ACTIONS\]([\s\S]*?)\[\/ACTIONS\]/);
    if (actionsMatch) {
      cleanText = cleanText.replace(/\[ACTIONS\][\s\S]*?\[\/ACTIONS\]/g, '').trim();
      try {
        let jsonStr = actionsMatch[1].trim();
        if (jsonStr.startsWith('[')) {
          actions = JSON.parse(jsonStr);
        } else {
          actions = JSON.parse(`[${jsonStr}]`);
        }
        if (!Array.isArray(actions)) actions = [actions];
      } catch (e) {
        console.warn('[Bot] Failed to parse [ACTIONS] JSON:', e.message);
        try {
          const fixed = actionsMatch[1].trim()
            .replace(/,\s*([}\]])/g, '$1')
            .replace(/'/g, '"');
          actions = JSON.parse(fixed.startsWith('[') ? fixed : `[${fixed}]`);
          if (!Array.isArray(actions)) actions = [actions];
        } catch {
          console.warn('[Bot] Could not recover [ACTIONS] JSON');
        }
      }
    }

    if (actions.length === 0) {
      const dataMatch = cleanText.match(/\[NEED_DATA:([^\]]+)\]/);
      if (dataMatch) {
        const sources = dataMatch[1].toLowerCase().split(',').map(s => s.trim());
        const resolved = sources.includes('all')
          ? ['github', 'hn', 'reddit', 'ph', 'devto']
          : sources.filter(s => ['github', 'hn', 'reddit', 'ph', 'devto'].includes(s));
        if (resolved.length > 0) {
          actions.push({ action: 'fetch_data', params: { sources: resolved } });
        }
        cleanText = cleanText.replace(/\[NEED_DATA:[^\]]+\]/g, '').trim();
      }

      const settingsMatch = cleanText.match(/\[SETTINGS_UPDATE\]([\s\S]*?)\[\/SETTINGS_UPDATE\]/);
      if (settingsMatch) {
        cleanText = cleanText.replace(/\[SETTINGS_UPDATE\][\s\S]*?\[\/SETTINGS_UPDATE\]/g, '').trim();
        try {
          const parsed = JSON.parse(settingsMatch[1].trim());
          actions.push({ action: 'update_settings', params: { settings: parsed } });
        } catch {
          console.warn('[Bot] Failed to parse legacy SETTINGS_UPDATE');
        }
      }
    }

    return { cleanText, actions };
  }

  function formatActionResults(results) {
    let text = '';
    for (const r of results) {
      if (r.type === 'data') {
        text += `--- ${r.action} ---\n${r.result}\n\n`;
      } else if (r.type === 'confirmation') {
        const msg = typeof r.result === 'object' ? JSON.stringify(r.result) : r.result;
        text += `--- ${r.action} (done) ---\n${msg}\n\n`;
      } else if (r.type === 'error') {
        text += `--- ${r.action} (error) ---\n${r.result}\n\n`;
      }
    }
    return text || 'No results from actions.';
  }

  async function fetchSources(sources, prefs) {
    const results = {};
    const fetchers = {
      github: () => withRetry(() => fetchGitHubTrendingByPrefs(prefs.languages, prefs.maxGitHubRepos), { label: 'GitHub' }),
      hn: () => withRetry(() => fetchTopStories(prefs.maxHNStories), { label: 'HN' }),
      reddit: () => withRetry(() => fetchRedditHot(), { label: 'Reddit' }),
      ph: () => withRetry(() => fetchProductHunt(), { label: 'PH' }),
      devto: () => withRetry(() => fetchDevToByInterests(prefs.interests), { label: 'DevTo' }),
    };

    await Promise.all(sources.map(async (source) => {
      try {
        if (fetchers[source]) results[source] = await fetchers[source]();
      } catch (err) {
        console.error(`[Bot] Fetch ${source} failed:`, err.message);
        results[source] = [];
      }
    }));

    return results;
  }

  function formatDataForAI(data) {
    let text = '';

    if (data.github?.length > 0) {
      text += 'GITHUB TRENDING REPOS:\n';
      data.github.forEach((r, i) => {
        text += `${i + 1}. ${r.name} (${r.language}, ${r.totalStars} total stars, ${r.starsToday} today) - ${r.description} | URL: ${r.url}\n`;
      });
      text += '\n';
    }

    if (data.hn?.length > 0) {
      text += 'HACKER NEWS TOP STORIES:\n';
      data.hn.forEach((s, i) => {
        text += `${i + 1}. "${s.title}" (${s.score} pts, ${s.comments} comments, by ${s.by}) - ${s.url}\n`;
      });
      text += '\n';
    }

    if (data.reddit?.length > 0) {
      text += 'REDDIT HOT POSTS:\n';
      data.reddit.forEach((p, i) => {
        text += `${i + 1}. [r/${p.subreddit}] "${p.title}" (${p.score} upvotes, ${p.comments} comments) - ${p.url}\n`;
      });
      text += '\n';
    }

    if (data.ph?.length > 0) {
      text += 'PRODUCT HUNT LAUNCHES:\n';
      data.ph.forEach((p, i) => {
        text += `${i + 1}. ${p.name} - ${p.tagline} (${p.votes} upvotes) - ${p.url}\n`;
      });
      text += '\n';
    }

    if (data.devto?.length > 0) {
      text += 'DEV.TO TOP ARTICLES:\n';
      data.devto.forEach((a, i) => {
        text += `${i + 1}. "${a.title}" by ${a.author} (${a.reactions} reactions, ${a.readingTime}min read) [${a.tags.join(', ')}] - ${a.url}\n`;
      });
      text += '\n';
    }

    if (Object.values(data).every(arr => !arr?.length)) {
      text = 'No data could be fetched from any of the requested sources at this time.\n';
    }

    return text;
  }

  return bot;
}

module.exports = { createBot, COMMAND_MENU };
