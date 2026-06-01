async function withRetry(fn, { retries = 2, delay = 1000, label = 'operation' } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt <= retries) {
        console.warn(`[Retry] ${label} attempt ${attempt} failed: ${err.message}. Retrying in ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
        delay *= 2;
      }
    }
  }
  throw lastError;
}

module.exports = { withRetry };
