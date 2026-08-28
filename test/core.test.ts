import assert from 'node:assert/strict';
import test from 'node:test';

import { coalescePending, isExcludedVaultPath, manifestBatches, mimeTypeForPath, normalizeServerUrl, normalizeVaultPath, sha256Hex, vaultFileKind } from '../src/core';

test('normalizes safe vault and server paths', () => {
  assert.equal(normalizeServerUrl('https://app.streamient.com///'), 'https://app.streamient.com');
  assert.equal(normalizeVaultPath('./Notes\\Today.md'), 'Notes/Today.md');
  assert.throws(() => normalizeVaultPath('../../outside.md'));
  assert.throws(() => normalizeVaultPath('/absolute.md'));
});

test('excludes hidden, trash, OS, and temporary files', () => {
  assert.equal(isExcludedVaultPath('.obsidian/plugins/x/data.json'), true);
  assert.equal(isExcludedVaultPath('.trash/deleted.md'), true);
  assert.equal(isExcludedVaultPath('Notes/.private/secret.md'), true);
  assert.equal(isExcludedVaultPath('Notes/draft.tmp'), true);
  assert.equal(isExcludedVaultPath('Notes/Today.md'), false);
});

test('classifies vault content without desktop APIs', () => {
  assert.equal(vaultFileKind('Notes/A.md'), 'markdown');
  assert.equal(vaultFileKind('Boards/A.canvas'), 'canvas');
  assert.equal(vaultFileKind('Data/A.base'), 'base');
  assert.equal(vaultFileKind('Files/A.pdf'), 'document');
  assert.equal(vaultFileKind('Images/A.png'), 'image');
  assert.equal(mimeTypeForPath('Files/A.docx'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
});

test('coalesces repeated changes while preserving create semantics', () => {
  const created = { path: 'A.md', operation: 'create', operationId: '1' };
  const updated = { path: 'A.md', operation: 'update', operationId: '2' };
  assert.deepEqual(coalescePending([created], updated), [{ ...updated, operation: 'create' }]);
  assert.deepEqual(coalescePending([created], { path: 'A.md', operation: 'trash', operationId: '3' }), []);
	const renamed = { path: 'B.md', operation: 'rename', operationId: '4' };
	assert.deepEqual(coalescePending([renamed], { path: 'B.md', operation: 'update', operationId: '5' }), [renamed, { path: 'B.md', operation: 'update', operationId: '5' }]);
});

test('uses browser SHA-256 for byte identity', async () => {
  assert.equal(await sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('batches large manifests without losing order', () => {
  const items = Array.from({ length: 1001 }, (_value, index) => index);
  const batches = manifestBatches(items);
  assert.deepEqual(batches.map((batch) => batch.length), [500, 500, 1]);
  assert.deepEqual(batches.flat(), items);
});
