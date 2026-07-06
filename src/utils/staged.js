'use strict';

// staged.js — Complexity-gated, edit-in-place staged status for TrendForge.
//
// TrendForge speaks in plain text (no HTML), so this variant renders plain-text
// stages. Behaviour matches the other bots: a hello / thanks / short question
// gets an instant answer with NO status line; a real request (fetch a report,
// scrape trends, schedule, analyse, multi-step) shows ONE message edited in
// place through stages, each stage keeping the previous one's conclusion beneath
// it. Wording is customised for TrendForge (scraping / trends / reports).

// Reusable stage headers (plain text). Callers may pass any string.
const STAGES = Object.freeze({
  thinking: '🧠 Thinking it through…',
  planning: '📋 Planning the steps…',
  scraping: '🔍 Scraping the sources…',
  analyzing: '📊 Analysing the trends…',
  writing: '📝 Writing it up…',
  working: '⚙️ Working on it…',
  waiting: '⏳ Waiting on something external…',
  retrying: '🧩 Adjusting and retrying…',
});

const GREETING_RE = /^(hi|hey|hello|yo|sup|howdy|good\s*(morning|afternoon|evening|night)|gm|gn)\b[!. ]*$/i;
const THANKS_RE = /^(thanks?|thank you|thx|ty|cheers|nice|cool|great|ok(ay)?|got it|👍|🙏|❤️|👌)[!. ]*$/i;

// Words that signal real work for a trends/reports assistant.
const COMPLEX_RE = /\b(report|trend|trending|scrape|fetch|analy[sz]e|summari[sz]e|digest|idea|ideas|schedule|remind|every|daily|weekly|monitor|watch|track|compare|research|dig into|look up|find|search|url|http|generate|build|create|set up|configure)\b/i;

function looksLikeShortQuestion(text) {
  const t = text.trim();
  if (t.length > 140) return false;
  return t.split(/\s+/).length <= 20;
}

function classifyComplexity(text, hints = {}) {
  if (hints.forceComplex) return { complex: true, reason: hints.reason || 'known action' };
  if (hints.forceTrivial) return { complex: false, reason: hints.reason || 'known trivial' };

  const t = String(text || '').trim();
  if (!t) return { complex: false, reason: 'empty' };
  if (GREETING_RE.test(t)) return { complex: false, reason: 'greeting' };
  if (THANKS_RE.test(t)) return { complex: false, reason: 'acknowledgement' };
  if (looksLikeShortQuestion(t) && !COMPLEX_RE.test(t)) return { complex: false, reason: 'short question' };
  if (COMPLEX_RE.test(t)) return { complex: true, reason: 'trend/report request' };
  if (t.length > 220) return { complex: true, reason: 'long request' };
  return { complex: false, reason: 'no concrete TrendForge action detected' };
}

// Owns exactly one Telegram message and edits it in place (plain text). Resilient
// to Telegram edit errors so status rendering can never break the real task.
class StagedStatus {
  constructor(ctx, opts = {}) {
    this.ctx = ctx;
    this.header = opts.header || null;
    this.messageId = null;
    this.chatId = ctx?.chat?.id;
    this.trail = [];
    this.current = null;
    this.closed = false;
    this._maxTrail = opts.maxTrail || 8;
  }

  _render() {
    const lines = [];
    if (this.header) lines.push(this.header);
    for (const s of this.trail) {
      lines.push(s.header);
      if (s.conclusion) lines.push(`   ↳ ${s.conclusion}`);
    }
    if (this.current) lines.push(this.current.header);
    return lines.join('\n');
  }

  async _flush() {
    if (this.closed) return;
    const text = this._render();
    if (!text) return;
    try {
      if (this.messageId == null) {
        const sent = await this.ctx.reply(text);
        this.messageId = sent?.message_id ?? null;
        this.chatId = sent?.chat?.id ?? this.chatId;
      } else {
        await this.ctx.api.editMessageText(this.chatId, this.messageId, text);
      }
    } catch (err) {
      if (!/not modified|message to edit not found|message is not modified/i.test(err?.description || err?.message || '')) {
        if (typeof console !== 'undefined') console.error('[staged] flush:', err?.description || err?.message);
      }
    }
  }

  async stage(header, prevConclusion) {
    if (this.closed) return this;
    if (this.current) {
      this.trail.push({ header: this.current.header, conclusion: prevConclusion || this.current.pendingConclusion || '' });
    } else if (prevConclusion && this.trail.length) {
      this.trail[this.trail.length - 1].conclusion = prevConclusion;
    }
    if (this.trail.length > this._maxTrail) this.trail.splice(0, this.trail.length - this._maxTrail);
    this.current = { header, pendingConclusion: '' };
    await this._flush();
    return this;
  }

  note(conclusion) {
    if (this.current) this.current.pendingConclusion = conclusion;
    return this;
  }

  async _terminal(headerLine, body) {
    if (this.closed) return this;
    if (this.current) {
      this.trail.push({ header: this.current.header, conclusion: this.current.pendingConclusion || '' });
      this.current = null;
    }
    this.trail.push({ header: headerLine, conclusion: body || '' });
    await this._flush();
    this.closed = true;
    return this;
  }

  done(result) {
    return this._terminal('✅ Done.', result ? stripTags(result).slice(0, 900) : '');
  }

  cant(why, suggestions) {
    const s = suggestions ? `\n   💡 ${stripTags(suggestions).slice(0, 300)}` : '';
    return this._terminal('⚠️ Couldn’t finish.', (why ? stripTags(why).slice(0, 500) : '') + s);
  }

  tooLong(what) {
    return this._terminal(
      '⏳ This is taking longer than expected.',
      (what ? stripTags(what) + '\n   ' : '') + 'Want me to keep watching for it, or stop here?'
    );
  }

  get shown() {
    return this.messageId != null;
  }
}

function stripTags(s) {
  return String(s).replace(/<[^>]+>/g, '');
}

function openingStage(text) {
  const t = String(text || '');
  if (/\b(report|digest|write|summari[sz]e)\b/i.test(t)) return STAGES.writing;
  if (/\b(scrape|fetch|trend|trending|source|url|http)\b/i.test(t)) return STAGES.scraping;
  if (/\b(analy[sz]e|compare|research|idea|ideas)\b/i.test(t)) return STAGES.analyzing;
  if (/\b(schedule|remind|every|daily|weekly|watch|monitor|track)\b/i.test(t)) return STAGES.planning;
  const variants = [STAGES.thinking, STAGES.planning, STAGES.working];
  return variants[t.length % variants.length];
}

function maybeStaged(ctx, text, hints = {}) {
  const { complex, reason } = classifyComplexity(text, hints);
  if (!complex) return { staged: null, complex: false, reason };
  return { staged: new StagedStatus(ctx, hints), complex: true, reason };
}

module.exports = { STAGES, classifyComplexity, StagedStatus, maybeStaged, openingStage };
