import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const workflow = fs.readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');

test('attests every published Obsidian release asset', () => {
  assert.match(workflow, /id-token: write/);
  assert.match(workflow, /attestations: write/);
  assert.match(workflow, /artifact-metadata: write/);
  assert.match(workflow, /uses: actions\/attest@v4/);
  for (const asset of ['main.js', 'manifest.json', 'styles.css']) assert.match(workflow, new RegExp(`\\s${asset.replace('.', '\\.')}`));
  assert.ok(workflow.indexOf('Attest release assets') < workflow.indexOf('Create release'));
});
