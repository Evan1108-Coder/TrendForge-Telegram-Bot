const fs = require('fs');
const path = require('path');
const axios = require('axios');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');

const SUPPORTED_TEXT = new Set(['.txt', '.md', '.csv', '.json', '.html']);
const SUPPORTED_DOCS = new Set(['.pdf', '.rtf']);
const SUPPORTED_IMAGES = new Set(['.png', '.jpg', '.jpeg', '.avif']);

const MIME_MAP = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.avif': 'image/avif',
};

function getSupportedExtensions() {
  return [...SUPPORTED_TEXT, ...SUPPORTED_DOCS, ...SUPPORTED_IMAGES];
}

function classifyFile(fileName) {
  const ext = path.extname(fileName).toLowerCase();
  if (SUPPORTED_TEXT.has(ext)) return 'text';
  if (SUPPORTED_DOCS.has(ext)) return 'document';
  if (SUPPORTED_IMAGES.has(ext)) return 'image';
  return null;
}

async function downloadTelegramFile(bot, fileId) {
  const file = await bot.api.getFile(fileId);
  const url = `https://api.telegram.org/file/bot${bot.token}/${file.file_path}`;
  const resp = await axios.get(url, { responseType: 'arraybuffer', timeout: 30000 });
  return {
    buffer: Buffer.from(resp.data),
    filePath: file.file_path,
    fileName: path.basename(file.file_path),
  };
}

async function extractText(buffer, fileName) {
  const ext = path.extname(fileName).toLowerCase();

  if (SUPPORTED_TEXT.has(ext)) {
    const text = buffer.toString('utf-8');
    return text.substring(0, 15000);
  }

  if (ext === '.rtf') {
    return stripRtf(buffer.toString('utf-8')).substring(0, 15000);
  }

  if (ext === '.pdf') {
    const data = await pdfParse(buffer);
    return data.text.substring(0, 15000);
  }

  return null;
}

function stripRtf(raw) {
  return String(raw)
    .replace(/\\'[0-9a-fA-F]{2}/g, ' ')
    .replace(/\\[a-z]+\d* ?/gi, ' ')
    .replace(/[{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getImageBase64(buffer) {
  return buffer.toString('base64');
}

function getMimeType(fileName) {
  const ext = path.extname(fileName).toLowerCase();
  return MIME_MAP[ext] || 'image/png';
}

module.exports = {
  getSupportedExtensions,
  classifyFile,
  downloadTelegramFile,
  extractText,
  getImageBase64,
  getMimeType,
  SUPPORTED_TEXT,
  SUPPORTED_DOCS,
  SUPPORTED_IMAGES,
  stripRtf,
};
