import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
const types = fs.readFileSync(new URL('../src/types.ts', import.meta.url), 'utf8');

test('keeps account credentials and project runtime state device-local', () => {
  assert.match(types, /accounts: Record<string, SyncAccount>/);
  assert.match(types, /profileStates: Record<string, ProjectSyncState>/);
  assert.match(source, /const shared = \{ schemaVersion: 2, serverUrl: this\.settings\.serverUrl, profiles: this\.settings\.profiles \}/);
  assert.match(source, /const local = \{ authenticated: this\.settings\.authenticated, defaultAccountKey: this\.settings\.defaultAccountKey, accounts: this\.settings\.accounts/);
  assert.match(source, /secretName\(account: string\)/);
  assert.match(source, /return secretStorageId\(this\.settings\.deviceId, account\)/);
  assert.match(source, /authorizedKeys = Object\.keys\(this\.settings\.accounts\)/);
  assert.match(source, /await this\.migrateLegacyCredential\(\)/);
  assert.match(source, /this\.app\.secretStorage\.setSecret\(this\.legacySecretName\(\), ''\)/);
});

test('supports a default OAuth account and additional per-project accounts', () => {
  assert.match(source, /startAuthorization\(mode: 'default' \| 'additional' \| 'profile'/);
  assert.match(source, /mode !== 'default'/);
  assert.match(source, /const identity = await identityClient\.account\(\)/);
  assert.match(source, /accountKey: key/);
  assert.match(source, /api: \(\) => this\.api\(profile\.accountKey\)/);
  assert.match(source, /class AccountPicker extends FuzzySuggestModal<SyncAccount>/);
});

test('uses safe migration and searchable declarative settings', () => {
  assert.match(source, /savedSettings = await this\.loadData\(\)/);
  assert.match(source, /migrateSettings\(savedSettings, localSettings/);
  assert.match(source, /getSettingDefinitions\(\): SettingDefinitionItem\[\]/);
  assert.match(source, /heading: 'Projects'/);
  assert.match(source, /heading: profile\.projectName/);
  assert.doesNotMatch(source, /\n\s+display\(\): void/);
});

test('adds a project profile without automatically starting synchronization', () => {
  assert.match(source, /new ProjectPicker\(this\.app, projects, \(project\) => void this\.connectProject\(project, key\)\)\.open\(\)/);
  const connectBlock = source.slice(source.indexOf('private async connectProject'), source.indexOf('async disconnect'));
  assert.match(connectBlock, /createProjectState\(\)/);
  assert.doesNotMatch(connectBlock, /fullSync/);
  assert.match(connectBlock, /Review its first sync before starting/);
});
