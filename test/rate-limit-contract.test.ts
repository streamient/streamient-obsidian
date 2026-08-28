import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const api = fs.readFileSync(new URL('../src/api.ts', import.meta.url), 'utf8');
const main = fs.readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');

test('paces all Obsidian sync traffic below the dedicated server limit', () => {
  assert.match(api, /MIN_REQUEST_INTERVAL_MS = 25/);
  assert.match(api, /MAX_RATE_LIMIT_RETRIES = 6/);
  assert.ok((api.match(/this\.pacedRequest\(/g) || []).length >= 3);
  assert.match(api, /response\.status !== 429/);
  assert.match(api, /response\.headers\?\.\['retry-after'\]/);
});

test('reuses one paced API client across the complete sync', () => {
  assert.match(main, /private apiClient: StreamientApi \| null = null/);
  assert.match(main, /if \(!this\.apiClient \|\| this\.apiClient\.serverUrl !== serverUrl\) this\.apiClient = new StreamientApi/);
  assert.match(main, /return this\.apiClient/);
});
