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

async function sendLong(ctx, text) {
  const maxLen = 4000;
  if (text.length <= maxLen) {
    await ctx.reply(text);
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
    await ctx.reply(chunk);
  }
}

module.exports = { cleanOutput, sendLong };
