const axios = require('axios');

const PROVIDERS = {
  openai: {
    url: 'https://api.openai.com/v1/chat/completions',
    models: ['gpt-5.4-pro', 'gpt-5.4-mini', 'gpt-4o', 'gpt-4o-mini'],
    authHeader: key => ({ Authorization: `Bearer ${key}` }),
    envKey: 'OPENAI_API_KEY',
  },
  anthropic: {
    url: 'https://api.anthropic.com/v1/messages',
    models: ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5', 'claude-3.5-sonnet'],
    authHeader: key => ({ 'x-api-key': key, 'anthropic-version': '2023-06-01' }),
    envKey: 'ANTHROPIC_API_KEY',
  },
  google: {
    models: ['gemini-3.1-pro', 'gemini-3-flash', 'gemini-2.5-flash-lite'],
    envKey: 'GOOGLE_API_KEY',
  },
  together: {
    url: 'https://api.together.xyz/v1/chat/completions',
    models: ['llama-4-maverick', 'llama-4-scout', 'llama-3.3-70b'],
    authHeader: key => ({ Authorization: `Bearer ${key}` }),
    envKey: 'TOGETHER_API_KEY',
    modelMap: {
      'llama-4-maverick': 'meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8',
      'llama-4-scout': 'meta-llama/Llama-4-Scout-17B-16E-Instruct',
      'llama-3.3-70b': 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    },
  },
  minimax: {
    url: 'https://api.minimaxi.chat/v1/chat/completions',
    models: ['minimax-m2.7', 'minimax-m2.5-lightning'],
    authHeader: key => ({ Authorization: `Bearer ${key}` }),
    envKey: 'MINIMAX_API_KEY',
    modelMap: {
      'minimax-m2.7': 'MiniMax-M1',
      'minimax-m2.5-lightning': 'MiniMax-M1',
    },
  },
};

const TOGETHER_MODEL_MAP = {
  'llama-4-maverick': 'meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8',
  'llama-4-scout': 'meta-llama/Llama-4-Scout-17B-16E-Instruct',
  'llama-3.3-70b': 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
};

function getProviderForModel(model) {
  for (const [name, provider] of Object.entries(PROVIDERS)) {
    if (provider.models.includes(model)) return { name, ...provider };
  }
  return null;
}

function getApiKey(provider) {
  return process.env[provider.envKey] || null;
}

async function callOpenAICompatible(url, headers, model, messages, modelMap) {
  const resolvedModel = modelMap?.[model] || model;
  const res = await axios.post(url, {
    model: resolvedModel,
    messages,
    max_tokens: 4096,
    temperature: 0.7,
  }, { headers: { 'Content-Type': 'application/json', ...headers }, timeout: 120000 });
  const content = res.data.choices[0].message.content;
  return content.replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim();
}

async function callAnthropic(key, model, messages) {
  const system = messages.find(m => m.role === 'system')?.content || '';
  const userMessages = messages.filter(m => m.role !== 'system');
  const res = await axios.post('https://api.anthropic.com/v1/messages', {
    model,
    max_tokens: 4096,
    system,
    messages: userMessages,
  }, {
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    timeout: 120000,
  });
  return res.data.content[0].text;
}

async function callGoogle(key, model, messages) {
  const contents = messages
    .filter(m => m.role !== 'system')
    .map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
  const systemInstruction = messages.find(m => m.role === 'system');
  const body = { contents };
  if (systemInstruction) {
    body.systemInstruction = { parts: [{ text: systemInstruction.content }] };
  }
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
  const res = await axios.post(url, body, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 120000,
  });
  return res.data.candidates[0].content.parts[0].text;
}

async function chat(model, messages) {
  const provider = getProviderForModel(model);
  if (!provider) throw new Error(`Unknown model: ${model}. Available: ${getAllModels().join(', ')}`);

  const key = getApiKey(provider);
  if (!key) throw new Error(`No API key set for ${provider.name}. Set ${provider.envKey} in your .env file.`);

  if (provider.name === 'anthropic') {
    return callAnthropic(key, model, messages);
  }
  if (provider.name === 'google') {
    return callGoogle(key, model, messages);
  }
  return callOpenAICompatible(provider.url, provider.authHeader(key), model, messages, provider.modelMap);
}

function getAllModels() {
  return Object.values(PROVIDERS).flatMap(p => p.models);
}

function getAvailableModels() {
  return getAllModels().filter(model => {
    const provider = getProviderForModel(model);
    return provider && getApiKey(provider);
  });
}

module.exports = { chat, getAllModels, getAvailableModels, getProviderForModel };
