import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
const types = fs.readFileSync(new URL('../src/types.ts', import.meta.url), 'utf8');

test('keeps authentication device-local and restores it from SecretStorage', () => {
  assert.match(types, /authenticated: boolean/);
  assert.match(source, /DEVICE_SETTING_KEYS = \['authenticated'/);
  assert.match(source, /this\.settings\.authenticated = Boolean\(this\.app\.secretStorage\.getSecret\(this\.secretName\(\)\)\)/);
  assert.match(source, /this\.settings\.authenticated = true/);
  assert.match(source, /authenticated: false, connectionId: ''/);
});

test('rerenders settings after OAuth and connection state transitions', () => {
  assert.match(source, /await this\.saveSettings\(\);\n\s+this\.refreshSettingsTab\(\);\n\s+new Notice\('Connected to Streamient'\)/);
  assert.match(source, /setDesc\(this\.plugin\.settings\.authenticated \? 'Signed in' : 'Not signed in'\)/);
  assert.match(source, /setDisabled\(!this\.plugin\.settings\.authenticated\)/);
  assert.ok((source.match(/this\.refreshSettingsTab\(\)/g) || []).length >= 5);
});

test('connects directly from the project picker without an onClose race', () => {
  assert.match(source, /onChooseItem\(project: ProjectSummary\): void \{\n\s+this\.choose\(project\)/);
  assert.match(source, /new ProjectPicker\(this\.app, projects, \(project\) => void this\.connectProject\(project\)\)\.open\(\)/);
  assert.doesNotMatch(source, /projectChoice|resolveChoice|onClose\(\)/);
});
