function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function mdToHtml(input) {
  let s = String(input ?? '');
  if (!s.trim()) return '';
  const blocks = [];
  s = s.replace(/```[a-zA-Z0-9_-]*\n?([\s\S]*?)```/g, (_, code) => {
    blocks.push(code.replace(/\n+$/, ''));
    return ` PRE${blocks.length - 1} `;
  });
  const inlines = [];
  s = s.replace(/`([^`\n]+)`/g, (_, code) => {
    inlines.push(code);
    return ` CODE${inlines.length - 1} `;
  });
  s = escapeHtml(s);
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, text, url) => `<a href="${escapeHtml(url)}">${text}</a>`);
  s = s.replace(/^\s{0,3}#{1,6}\s+(.+?)\s*#*$/gm, '<b>$1</b>');
  s = s.replace(/\*\*([^\n]+?)\*\*/g, '<b>$1</b>');
  s = s.replace(/(^|[^*])\*([^*\n]+?)\*(?!\*)/g, '$1<i>$2</i>');
  s = s.replace(/^(\s*)[-*]\s+/gm, '$1• ');
  s = s.replace(/ CODE(\d+) /g, (_, i) => `<code>${escapeHtml(inlines[Number(i)])}</code>`);
  s = s.replace(/ PRE(\d+) /g, (_, i) => `<pre>${escapeHtml(blocks[Number(i)])}</pre>`);
  return s.trim();
}

function cleanOutput(text) {
  if (!text) return '';
  return text
    .replace(/\[ACTIONS\][\s\S]*?\[\/ACTIONS\]/g, '')
    .replace(/\[NEED_DATA:[^\]]*\]/g, '')
    .replace(/\[SETTINGS_UPDATE\][\s\S]*?\[\/SETTINGS_UPDATE\]/g, '')
    .replace(/\[TOOL_CALL\][\s\S]*?\[\/TOOL_CALL\]/g, '')
    .replace(/\[TOOL_RESULT\][\s\S]*?\[\/TOOL_RESULT\]/g, '')
    .replace(/\[FUNCTION_CALL\][\s\S]*?\[\/FUNCTION_CALL\]/g, '')
    .replace(/\[FUNCTION_RESULT\][\s\S]*?\[\/FUNCTION_RESULT\]/g, '')
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/```\w*\n?/g, '').replace(/```/g, ''))
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(?<!\w)\*([^*]+)\*(?!\w)/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(?<!\w)_([^_]+)_(?!\w)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function sendLong(ctx, text, options = {}) {
  const maxLen = 4000;
  if (text.length <= maxLen) {
    await ctx.reply(text, options);
    return;
  }
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf('\n\n', maxLen);
    if (splitAt < maxLen * 0.3) splitAt = remaining.lastIndexOf('\n', maxLen);
    if (splitAt < maxLen * 0.3) splitAt = maxLen;
    chunks.push(remaining.substring(0, splitAt));
    remaining = remaining.substring(splitAt).trimStart();
  }
  for (const chunk of chunks) {
    await ctx.reply(chunk, options);
  }
}

module.exports = { cleanOutput, sendLong, escapeHtml, mdToHtml };
