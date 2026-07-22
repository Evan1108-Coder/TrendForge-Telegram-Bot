const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { classifyFile, getSupportedExtensions, extractText, getMimeType, stripRtf, voiceCapabilityMessage, unsupportedAttachmentMessage } = require('../src/files');

const fixtures = path.join(__dirname, 'fixtures', 'uploads');
const REQUIRED = ['.txt', '.md', '.csv', '.json', '.html', '.pdf', '.rtf', '.png', '.jpg', '.jpeg', '.avif'];

test('supports Evan requested upload extensions', () => {
  const exts = getSupportedExtensions();
  for (const ext of REQUIRED) assert.ok(exts.includes(ext), `${ext} missing`);
  for (const ext of REQUIRED) assert.ok(classifyFile(`sample${ext}`), `${ext} not classified`);
  assert.equal(classifyFile('sample.png'), 'image');
  assert.equal(classifyFile('sample.pdf'), 'document');
});

test('extracts text and rtf sample files', async () => {
  for (const [name, expected] of [['sample.txt','hello txt'], ['sample.md','Hello md'], ['sample.csv','a,b'], ['sample.json','json'], ['sample.html','Hello html']]) {
    assert.match(await extractText(fs.readFileSync(path.join(fixtures, name)), name), new RegExp(expected));
  }
  assert.match(await extractText(fs.readFileSync(path.join(fixtures, 'sample.rtf')), 'sample.rtf'), /Hello rtf/);
  assert.match(stripRtf('{\\rtf1\\ansi Hello rtf}'), /Hello rtf/);
});

test('image mime types are explicit', () => {
  assert.equal(getMimeType('a.png'), 'image/png');
  assert.equal(getMimeType('a.jpg'), 'image/jpeg');
  assert.equal(getMimeType('a.jpeg'), 'image/jpeg');
  assert.equal(getMimeType('a.avif'), 'image/avif');
});

test('voice and unsupported attachments get honest capability messages', () => {
  assert.match(voiceCapabilityMessage(), /cannot transcribe audio yet/i);
  assert.match(voiceCapabilityMessage(), /send the request as text/i);
  assert.match(unsupportedAttachmentMessage('video'), /cannot process that attachment type yet/i);
  assert.match(unsupportedAttachmentMessage('video'), /supported uploads/i);
});
