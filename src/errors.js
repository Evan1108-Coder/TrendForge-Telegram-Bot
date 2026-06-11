// Centralized, AI-personalized error handling.
//
// Philosophy (per Evan, v3.4): when something goes wrong, don't hand the user a
// canned string. Feed the ACTUAL situation to the AI and let it explain what
// happened and exactly how to fix it, tailored to this user's real state (which
// model they picked, which providers have keys, what's ready to use instead).
//
// The ONLY time we fall back to a fixed, hard-coded message is when the AI
// itself cannot run — i.e. no provider has an API key at all, or the explainer
// LLM call itself fails. In that one case there is no working AI to ask, so a
// deterministic message is required.
//
// SECURITY: the context handed to the AI (and anything shown to the user) NEVER
// contains secret values — only booleans like "OPENAI_API_KEY: present/missing".
// Error messages are scrubbed of any secret substrings before use.

const providers = require('./llm/providers');

// Env vars whose VALUES are secrets and must never appear in context/output.
const SECRET_ENV_VARS = [
  'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GOOGLE_API_KEY',
  'TOGETHER_API_KEY', 'MINIMAX_API_KEY', 'MOONSHOT_API_KEY',
  'TELEGRAM_BOT_TOKEN', 'TELEGRAM_TOKEN',
];

// Replace any occurrence of a real secret value (and common token shapes) with
// a placeholder so a raw error/string can never leak a key downstream.
function redactSecrets(text) {
  if (text == null) return '';
  let out = String(text);
  for (const name of SECRET_ENV_VARS) {
    const val = process.env[name];
    if (val && val.length >= 6) {
      out = out.split(val).join('[redacted]');
    }
  }
  // Generic belt-and-suspenders: bearer tokens, x-api-key headers, sk-/Telegram-style tokens.
  out = out
    .replace(/(Bearer\s+)[A-Za-z0-9._\-]+/gi, '$1[redacted]')
    .replace(/(x-api-key['"\s:=]+)[A-Za-z0-9._\-]+/gi, '$1[redacted]')
    .replace(/\bsk-[A-Za-z0-9._\-]{8,}\b/g, '[redacted]')
    .replace(/\b\d{6,}:[A-Za-z0-9_\-]{30,}\b/g, '[redacted]'); // Telegram bot token shape
  return out;
}

// Best-effort category for an error so the AI (and the hard fallback) can reason
// about it. Kept deterministic and dependency-free so it's trivially testable.
function classifyError(err, where) {
  const msg = (err && (err.message || String(err))) || '';
  const lower = msg.toLowerCase();
  const status = err && err.response && err.response.status;
  const code = err && err.code;

  if (/no api key set|no key|set [a-z_]+_api_key/i.test(msg)) return 'missing_key';
  if (/unknown model/i.test(msg)) return 'unknown_model';
  if (status === 401 || status === 403 || /unauthorized|invalid api key|authentication/i.test(lower)) return 'auth';
  if (status === 429 || /rate limit|quota|too many requests|insufficient_quota/i.test(lower)) return 'rate_limit';
  if (typeof status === 'number' && status >= 500) return 'provider_down';
  if (code === 'ECONNABORTED' || /timeout|timed out/i.test(lower)) return 'timeout';
  if (['ENOTFOUND', 'ECONNREFUSED', 'EAI_AGAIN', 'ECONNRESET', 'ENETUNREACH'].includes(code) || /network|getaddrinfo|socket hang up/i.test(lower)) return 'network';
  if (/json|unexpected token|parse/i.test(lower)) return 'parse';
  if (/scrap|fetch .* failed|no data could be fetched/i.test(lower)) return 'scraper';
  return 'unknown';
}

// Build a secret-safe structured snapshot of "what happened + current state".
// deps is injectable for testing; defaults to the live providers module.
function buildErrorContext({ err, where, extra } = {}, deps = {}) {
  const getProviderStatus = deps.getProviderStatus || providers.getProviderStatus;
  const getAvailableModels = deps.getAvailableModels || providers.getAvailableModels;
  const getAllModels = deps.getAllModels || providers.getAllModels;
  const loadPreferences = deps.loadPreferences || require('./preferences').loadPreferences;

  const prefs = (() => { try { return loadPreferences(); } catch { return {}; } })();
  const status = getProviderStatus().map((p) => ({ name: p.name, envKey: p.envKey, configured: !!p.configured }));
  const message = redactSecrets(err && (err.message || String(err)));

  const safeExtra = {};
  if (extra && typeof extra === 'object') {
    for (const [k, v] of Object.entries(extra)) {
      safeExtra[k] = typeof v === 'string' ? redactSecrets(v) : v;
    }
  }

  return {
    where: where || 'an operation',
    category: classifyError(err || {}, where),
    message,
    httpStatus: (err && err.response && err.response.status) || null,
    currentModel: prefs.model || null,
    availableModels: getAvailableModels(),
    allModels: getAllModels(),
    providers: status,
    anyProviderConfigured: status.some((p) => p.configured),
    ...safeExtra,
  };
}

const EXPLAINER_SYSTEM_PROMPT =
  'You are TrendForge\'s error explainer. Something went wrong and you are given a JSON snapshot of ' +
  'EXACTLY what happened and the user\'s current state. Write a SHORT message (2-5 sentences) directly ' +
  'to the user that (1) explains in plain language what went wrong, and (2) gives a concrete, specific ' +
  'next step to fix it, using their ACTUAL situation. If they picked a model whose provider has no key, ' +
  'name the env var they need to set AND suggest a specific model that is ready right now (from ' +
  'availableModels). For network/rate-limit/provider issues, say what it likely is and that retrying or ' +
  'switching model may help. Be warm and helpful, never robotic. Plain text only: no markdown, no HTML, ' +
  'no code fences, no asterisks. Never reveal or ask for API key values. Do not invent facts beyond the snapshot.';

// Deterministic fallback used ONLY when the AI cannot run.
function hardFallback(context) {
  if (!context.anyProviderConfigured) {
    const names = context.providers.map((p) => `${p.name} (${p.envKey})`).join(', ');
    return (
      '⚠️ I can\'t reach any AI model right now — no API keys are configured, so I can\'t even generate a ' +
      `detailed explanation. Add a provider key to your .env file, then run /restart. Providers: ${names}. ` +
      'Use /config to see status.'
    );
  }
  const detail = context.message ? ` (${context.message})` : '';
  const alt = context.availableModels && context.availableModels.length
    ? ` Models ready to use: ${context.availableModels.join(', ')}.`
    : '';
  return (
    `⚠️ Something went wrong with ${context.where}${detail}. I also couldn\'t reach the AI to explain it in ` +
    `detail — the provider may be down, rate-limited, or your key/quota may have an issue. ` +
    `Try again in a moment, or switch model with /model.${alt} Run /config to check provider status.`
  );
}

// Turn an error into a personalized, user-facing explanation.
// deps.chat is injectable for testing. Returns a plain-text string (never throws).
async function explainError(context, deps = {}) {
  const chat = deps.chat || providers.chat;
  const getAvailableModels = deps.getAvailableModels || providers.getAvailableModels;
  const cleanOutput = deps.cleanOutput || require('./utils/format').cleanOutput;

  const available = getAvailableModels();
  if (!available || available.length === 0) {
    // No working AI to ask — required hard fallback.
    return hardFallback(context);
  }
  const model = available.includes(context.currentModel) ? context.currentModel : available[0];

  try {
    const response = await chat(model, [
      { role: 'system', content: EXPLAINER_SYSTEM_PROMPT },
      { role: 'user', content: `Here is what happened (JSON):\n${JSON.stringify(context, null, 2)}\n\nWrite the user-facing explanation now.` },
    ]);
    const cleaned = cleanOutput(response);
    return cleaned || hardFallback(context);
  } catch (e) {
    // The explainer LLM call itself failed — required hard fallback.
    console.error('[Errors] Explainer LLM failed:', redactSecrets(e && e.message));
    return hardFallback(context);
  }
}

// Convenience: build context from a raw error and immediately explain it.
async function handleError({ err, where, extra } = {}, deps = {}) {
  const context = buildErrorContext({ err, where, extra }, deps);
  return explainError(context, deps);
}

module.exports = {
  classifyError,
  redactSecrets,
  buildErrorContext,
  explainError,
  handleError,
  hardFallback,
  EXPLAINER_SYSTEM_PROMPT,
};
