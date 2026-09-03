import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const workflow = fs.readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
const manifest = JSON.parse(fs.readFileSync(new URL('../manifest.json', import.meta.url), 'utf8')) as { version: string; minAppVersion: string };
const packageJson = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
const versions = JSON.parse(fs.readFileSync(new URL('../versions.json', import.meta.url), 'utf8')) as Record<string, string>;

test('attests every published Obsidian release asset', () => {
  assert.match(workflow, /id-token: write/);
  assert.match(workflow, /attestations: write/);
  assert.match(workflow, /artifact-metadata: write/);
  assert.match(workflow, /uses: actions\/attest@v4/);
  for (const asset of ['main.js', 'manifest.json', 'styles.css']) assert.match(workflow, new RegExp(`\\s${asset.replace('.', '\\.')}`));
  assert.ok(workflow.indexOf('Attest release assets') < workflow.indexOf('Create release'));
});

test('keeps the 0.3.2 release metadata aligned', () => {
  assert.equal(manifest.version, '0.3.2');
  assert.equal(packageJson.version, manifest.version);
  assert.equal(versions[manifest.version], manifest.minAppVersion);
});
