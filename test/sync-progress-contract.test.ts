import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const api = fs.readFileSync(new URL('../src/api.ts', import.meta.url), 'utf8');
const main = fs.readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
const sync = fs.readFileSync(new URL('../src/sync.ts', import.meta.url), 'utf8');
const types = fs.readFileSync(new URL('../src/types.ts', import.meta.url), 'utf8');
const styles = fs.readFileSync(new URL('../styles.css', import.meta.url), 'utf8');

test('reports scoped project phases and persists success or failure state', () => {
  assert.match(types, /SyncPhase = 'idle'.*'stopping' \| 'paused' \| 'complete' \| 'failed'/);
  assert.match(types, /profileId: string/);
  for (const phase of ['scanning', 'reconciling', 'preview', 'applying', 'pulling', 'complete', 'failed']) assert.ok(sync.includes(`report('${phase}'`));
  assert.match(sync, /this\.state\.lastSyncAt = Date\.now\(\)/);
  assert.match(sync, /this\.state\.lastSyncError = message/);
  assert.match(sync, /now - this\.lastCheckpointAt < 1000/);
});

test('updates progress incrementally and exposes per-project abort controls', () => {
  assert.match(main, /onProgress: \(progress\) => this\.updateSyncProgress\(progress\)/);
  assert.match(main, /createEl\('progress', \{ cls: 'streamient-sync-progress' \}\)/);
  assert.match(main, /setButtonText\('Abort'\)\.setDestructive\(\)/);
  assert.match(main, /this\.settingTab\?\.updateSyncStatus\(progress\.profileId\)/);
  assert.match(main, /this\.settingTab\?\.updateSyncControls\(\)/);
  assert.match(styles, /\.streamient-sync-progress/);
  assert.match(styles, /\.streamient-sync-path/);
});

test('never rebuilds the settings page for automatic or manual sync progress', () => {
  const progressBlock = main.slice(main.indexOf('private updateSyncProgress'), main.indexOf('progressFor('));
  const backgroundBlock = main.slice(main.indexOf('private async resumeSync'), main.indexOf('async syncProject'));
  const projectBlock = main.slice(main.indexOf('async syncProject'), main.indexOf('async syncAll'));
  const allBlock = main.slice(main.indexOf('async syncAll'), main.indexOf('async abortProject'));
  const abortBlock = main.slice(main.indexOf('async abortProject'), main.indexOf('private async abortActiveSync'));
  for (const block of [progressBlock, backgroundBlock, projectBlock, allBlock, abortBlock]) assert.doesNotMatch(block, /refreshSettingsTab|\.refresh\(\)/);
  assert.match(main, /updateProject\(profileId\)/);
  assert.match(main, /setting\.controlEl\.empty\(\)/);
  const projectUiBlock = main.slice(main.indexOf('updateProject(profileId: string)'), main.indexOf('getControlValue'));
  assert.doesNotMatch(projectUiBlock, /updateProjectFolder/);
});

test('aborts cooperatively, cancels partial uploads, and waits for manual resume', () => {
  assert.match(sync, /new AbortController\(\)/);
  assert.match(sync, /this\.controller\.abort\(\)/);
  assert.match(sync, /this\.state\.paused = true/);
  assert.match(sync, /signal\.addEventListener\('abort', \(\) => modal\.close\(\)/);
  assert.match(api, /await this\.cancelUpload\(session\.id\)/);
  assert.match(main, /if \(!engine \|\| state\.paused \|\| state\.needsReview/);
});

test('applies manifest uploads directly instead of persisting one queued operation per file', () => {
  const block = sync.slice(sync.indexOf('private async applyManifestAction'), sync.indexOf('queue(operation'));
  assert.match(block, /await this\.applyOperation/);
  assert.doesNotMatch(block, /this\.queue\(/);
  assert.match(sync, /\(index \+ 1\) % 25 === 0/);
});

test('labels trash and rename mutations without calling them uploads', () => {
  assert.match(sync, /pending\.operation === 'trash' \? 'trashing' : pending\.operation === 'rename' \? 'renaming' : 'uploading'/);
  assert.match(main, /trashing: 'Moving items to trash'/);
  assert.match(main, /renaming: 'Renaming items'/);
});

test('continues bounded server export batches without rescanning the vault', () => {
  assert.match(types, /exports_pending\?: boolean/);
  assert.match(api, /\/connections\/\$\{connectionId\}\/exports/);
  assert.match(sync, /while \(exportsPending\)/);
  assert.match(sync, /projectExports\(this\.profile\.connectionId/);
  assert.match(sync, /applyManifestActions\(exported\.actions/);
});

test('keeps folder relocation resumable and cleans only empty source folders', () => {
  assert.match(types, /folderRelocationTarget: string/);
  assert.match(api, /\/connections\/\$\{connectionId\}\/relocate/);
  assert.match(sync, /async relocateFolder\(streamientFolder: string\)/);
  assert.match(sync, /folder instanceof TFolder && !folder\.children\.length/);
  assert.match(main, /state\.folderRelocationTarget = streamientFolder/);
  assert.match(main, /state\.folderRelocationTarget \|\| profile\.streamientFolder/);
  assert.match(main, /updateProjectFolder\(profileId\)/);
  assert.match(main, /setButtonText\('Move'\).*updateProfileFolder/);
  assert.match(main, /Review before syncing again/);
});

test('parses proxy errors from response text without assuming JSON', () => {
  const errorBlock = api.slice(api.indexOf('function responseError'), api.indexOf('export function authorizationUrl'));
  assert.match(errorBlock, /JSON\.parse\(text\) as unknown/);
  assert.doesNotMatch(errorBlock, /response\.json/);
});
