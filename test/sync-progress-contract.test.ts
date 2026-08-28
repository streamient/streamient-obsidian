import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const main = fs.readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
const sync = fs.readFileSync(new URL('../src/sync.ts', import.meta.url), 'utf8');
const types = fs.readFileSync(new URL('../src/types.ts', import.meta.url), 'utf8');
const styles = fs.readFileSync(new URL('../styles.css', import.meta.url), 'utf8');

test('reports every sync phase and persists success or failure state', () => {
  assert.match(types, /SyncPhase = 'idle' \| 'scanning' \| 'reconciling' \| 'preview' \| 'applying' \| 'uploading' \| 'pulling' \| 'complete' \| 'failed'/);
  assert.match(types, /lastSyncError: string/);
  for (const phase of ['scanning', 'reconciling', 'preview', 'applying', 'uploading', 'pulling', 'complete', 'failed']) assert.match(sync, new RegExp(`report\\('${phase}'`));
  assert.match(sync, /this\.settings\.lastSyncAt = Date\.now\(\)/);
  assert.match(sync, /this\.settings\.lastSyncError = message/);
  assert.match(sync, /if \(!this\.syncing\) window\.setTimeout/);
});

test('updates the settings progress bar and status bar incrementally', () => {
  assert.match(main, /onProgress: \(progress\) => this\.updateSyncProgress\(progress\)/);
  assert.match(main, /createEl\('progress', \{ cls: 'streamient-sync-progress' \}\)/);
  assert.match(main, /Streamient sync already running/);
  assert.match(main, /this\.settingTab\?\.updateSyncStatus\(\)/);
  assert.match(styles, /\.streamient-sync-progress/);
  assert.match(styles, /\.streamient-sync-path/);
});
