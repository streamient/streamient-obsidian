import assert from 'node:assert/strict';
import test from 'node:test';

import { SerializedSettingsWriter } from '../src/persistence';
import { accountKey, createProjectState, manifestScope, migrateSettings, ownerForPath, profileConfigurationError, retainOwnedOperations, secretStorageId } from '../src/profiles';
import type { ProjectSyncProfile } from '../src/types';

function profile(overrides: Partial<ProjectSyncProfile> = {}): ProjectSyncProfile {
  return { id: 'profile-1', accountKey: 'account-1:user-1', projectId: 'project-1', projectName: 'One', connectionId: 'connection-1', streamientFolder: 'Streamient/One', vaultMode: 'off', selectedPaths: [], ...overrides };
}

test('migrates legacy settings paused without retaining the bulk operation queue', () => {
  const settings = migrateSettings({ serverUrl: 'https://app.streamient.com', connectionId: 'connection-1', projectId: 'project-1', projectName: 'One', streamientFolder: 'Streamient' }, { deviceId: 'device-1', pendingOperations: [{ path: 'Huge.md', operation: 'create' }], fileStates: { 'Known.md': { fileId: 'file-1' } } }, 'Desktop');
  assert.equal(settings.schemaVersion, 2);
  assert.equal(settings.profiles.length, 1);
  assert.equal(settings.profiles[0].vaultMode, 'off');
  assert.equal(settings.profiles[0].accountKey, '');
  assert.equal(settings.profileStates[settings.profiles[0].id].paused, true);
  assert.equal(settings.profileStates[settings.profiles[0].id].needsReview, true);
  assert.deepEqual(settings.profileStates[settings.profiles[0].id].pendingOperations, []);
  assert.ok(settings.profileStates[settings.profiles[0].id].fileStates['Known.md']);
});

test('recovers empty or corrupt settings with safe defaults', () => {
  const settings = migrateSettings(null, 'not-an-object', 'Desktop');
  assert.equal(settings.serverUrl, 'https://app.streamient.com');
  assert.deepEqual(settings.profiles, []);
  assert.deepEqual(settings.accounts, {});
  assert.ok(settings.deviceId);
});

test('keeps account identities separate and device-local', () => {
  const key = accountKey('tenant-1', 'user-1');
  const settings = migrateSettings({ schemaVersion: 2, serverUrl: 'https://app.streamient.com', profiles: [{ ...profile(), accountKey: key }] }, { defaultAccountKey: key, accounts: { [key]: { key, accountId: 'tenant-1', accountName: 'Work', userId: 'user-1', userName: 'Nitai', userEmail: 'work@example.com', serverUrl: 'https://app.streamient.com' } }, profileStates: { 'profile-1': createProjectState() } }, 'Desktop');
  assert.equal(settings.defaultAccountKey, key);
  assert.equal(settings.accounts[key].userEmail, 'work@example.com');
  assert.equal(settings.profiles[0].accountKey, key);
});

test('uses only Obsidian-compatible characters for per-account secret IDs', () => {
  const id = secretStorageId('Device_A', accountKey('tenant:work', 'user@example.com'));
  assert.match(id, /^[a-z0-9-]+$/);
  assert.doesNotMatch(id, /:/);
  assert.ok(id.length <= 64);
  assert.equal(id, secretStorageId('Device_A', accountKey('tenant:work', 'user@example.com')));
  assert.notEqual(secretStorageId('device-1', accountKey('tenant-1', 'user-1')), secretStorageId('device-1', accountKey('tenant-2', 'user-1')));
});

test('routes managed, selected, and catch-all paths to exactly one profile', () => {
  const one = profile({ vaultMode: 'selected', selectedPaths: [{ path: 'Work', kind: 'folder' }] });
  const two = profile({ id: 'profile-2', accountKey: 'account-2:user-2', projectId: 'project-2', projectName: 'Two', connectionId: 'connection-2', streamientFolder: 'Streamient/Two', vaultMode: 'all' });
  assert.equal(ownerForPath([one, two], 'Streamient/One/Note.md')?.id, one.id);
  assert.equal(ownerForPath([one, two], 'Work/Note.md')?.id, one.id);
  assert.equal(ownerForPath([one, two], 'Personal/Note.md')?.id, two.id);
  assert.equal(ownerForPath([one, two], '.obsidian/data.json'), null);
  const scope = manifestScope(two, [one, two]);
  assert.deepEqual(scope.excluded_paths, [{ path: 'Streamient/One', kind: 'folder' }, { path: 'Work', kind: 'folder' }]);
});

test('rejects overlapping project roots, selected paths, and whole-vault owners', () => {
  const one = profile({ vaultMode: 'all' });
  assert.match(profileConfigurationError([one], profile({ id: 'profile-2', projectId: 'project-2', connectionId: 'connection-2', streamientFolder: 'Streamient/Two', vaultMode: 'all' })), /Only one project/);
  assert.match(profileConfigurationError([one], profile({ id: 'profile-2', projectId: 'project-2', connectionId: 'connection-2', streamientFolder: 'Streamient/One/Nested' })), /folders overlap/);
  assert.match(profileConfigurationError([one], profile({ id: 'profile-2', projectId: 'project-2', connectionId: 'connection-2', streamientFolder: 'Streamient/Two', vaultMode: 'selected', selectedPaths: [{ path: 'Streamient/One', kind: 'folder' }] })), /overlaps/);
  const selectedOwner = profile({ vaultMode: 'selected', selectedPaths: [{ path: 'Shared', kind: 'folder' }] });
  assert.match(profileConfigurationError([selectedOwner], profile({ id: 'profile-2', projectId: 'project-2', connectionId: 'connection-2', streamientFolder: 'Shared/Project' })), /folders overlap/);
});

test('drops queued work when scope is removed without creating a remote delete', () => {
  const selected = profile({ vaultMode: 'selected', selectedPaths: [{ path: 'Work', kind: 'folder' }] });
  const operations = [{ operationId: '1', operation: 'update' as const, path: 'Work/Keep.md', queuedAt: 1 }, { operationId: '2', operation: 'update' as const, path: 'Other/Dormant.md', queuedAt: 2 }];
  assert.deepEqual(retainOwnedOperations(operations, selected, [selected]).map((operation) => operation.path), ['Work/Keep.md']);
  const off = { ...selected, vaultMode: 'off' as const };
  assert.deepEqual(retainOwnedOperations(operations, off, [off]), []);
});

test('coalesces 30000 save requests with one active write', async () => {
  let active = 0;
  let maximumActive = 0;
  let writes = 0;
  let releaseFirst!: () => void;
  const firstWrite = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const writer = new SerializedSettingsWriter(async () => {
    active++;
    maximumActive = Math.max(maximumActive, active);
    writes++;
    if (writes === 1) await firstWrite;
    active--;
  });
  const saves = Array.from({ length: 30000 }, () => writer.save());
  releaseFirst();
  await Promise.all(saves);
  assert.equal(maximumActive, 1);
  assert.ok(writes <= 2);
});
