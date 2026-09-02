import { isExcludedVaultPath, normalizeServerUrl, normalizeVaultPath, uuid } from './core';
import type { ManifestScope, PendingOperation, ProjectSyncProfile, ProjectSyncState, ScopePathKind, StreamientSyncSettings, SyncAccount, SyncScopePath, VaultScopeMode } from './types';

const DEFAULT_SERVER_URL = 'https://app.streamient.com';

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function numberValue(value: unknown): number {
  return Number.isFinite(value) ? Number(value) : 0;
}

function scopeMode(value: unknown): VaultScopeMode {
  return value === 'selected' || value === 'all' ? value : 'off';
}

function scopePath(value: unknown): SyncScopePath | null {
  const source = record(value);
  const kind: ScopePathKind | '' = source.kind === 'file' ? 'file' : source.kind === 'folder' ? 'folder' : '';
  if (!kind) return null;
  try {
    const path = normalizeVaultPath(stringValue(source.path));
    return isExcludedVaultPath(path) ? null : { path, kind };
  } catch {
    return null;
  }
}

function normalizeScopePaths(value: unknown): SyncScopePath[] {
  const result: SyncScopePath[] = [];
  const seen = new Set<string>();
  for (const item of Array.isArray(value) ? value : []) {
    const normalized = scopePath(item);
    if (!normalized) continue;
    const key = `${normalized.kind}:${normalized.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

function normalizeProfile(value: unknown): ProjectSyncProfile | null {
  const source = record(value);
  const projectId = stringValue(source.projectId);
  const connectionId = stringValue(source.connectionId);
  const projectName = stringValue(source.projectName);
  if (!projectId || !connectionId || !projectName) return null;
  let streamientFolder = '';
  try {
    streamientFolder = normalizeVaultPath(stringValue(source.streamientFolder));
  } catch {
    return null;
  }
  return { id: stringValue(source.id) || projectId, accountKey: stringValue(source.accountKey), projectId, connectionId, projectName, streamientFolder, vaultMode: scopeMode(source.vaultMode), selectedPaths: normalizeScopePaths(source.selectedPaths) };
}

function normalizeAccounts(value: unknown): Record<string, SyncAccount> {
  const result: Record<string, SyncAccount> = {};
  for (const [key, raw] of Object.entries(record(value))) {
    const source = record(raw);
    const account: SyncAccount = { key, accountId: stringValue(source.accountId), accountName: stringValue(source.accountName), userId: stringValue(source.userId), userName: stringValue(source.userName), userEmail: stringValue(source.userEmail), serverUrl: normalizeServerUrl(stringValue(source.serverUrl) || DEFAULT_SERVER_URL) };
    if (account.accountId && account.accountName && account.userId) result[key] = account;
  }
  return result;
}

export function createProjectState(overrides: Partial<ProjectSyncState> = {}): ProjectSyncState {
  return { cursor: 0, lastSyncAt: 0, lastSyncError: '', lastSyncRequestAt: 0, fileStates: {}, pendingOperations: [], paused: false, needsReview: true, ...overrides };
}

function normalizeState(value: unknown): ProjectSyncState {
  const source = record(value);
  return createProjectState({
    cursor: numberValue(source.cursor),
    lastSyncAt: numberValue(source.lastSyncAt),
    lastSyncError: stringValue(source.lastSyncError),
    lastSyncRequestAt: numberValue(source.lastSyncRequestAt),
    fileStates: record(source.fileStates) as ProjectSyncState['fileStates'],
    pendingOperations: Array.isArray(source.pendingOperations) ? source.pendingOperations as PendingOperation[] : [],
    paused: source.paused === true,
    needsReview: source.needsReview !== false,
  });
}

export function migrateSettings(sharedValue: unknown, localValue: unknown, defaultDeviceName: string): StreamientSyncSettings {
  const shared = record(sharedValue);
  const local = record(localValue);
  const profiles: ProjectSyncProfile[] = [];
  const profileStates: Record<string, ProjectSyncState> = {};
  const accounts = normalizeAccounts(local.accounts);
  if (shared.schemaVersion === 2 && Array.isArray(shared.profiles)) {
    const seen = new Set<string>();
    for (const value of shared.profiles) {
      const profile = normalizeProfile(value);
      if (!profile || seen.has(profile.id)) continue;
      seen.add(profile.id);
      profiles.push(profile);
      profileStates[profile.id] = normalizeState(record(local.profileStates)[profile.id] ?? record(local.profileStates)[profile.projectId]);
    }
  } else {
    const projectId = stringValue(shared.projectId);
    const connectionId = stringValue(shared.connectionId);
    const projectName = stringValue(shared.projectName);
    if (projectId && connectionId && projectName) {
      const profile = normalizeProfile({ id: projectId, accountKey: '', projectId, connectionId, projectName, streamientFolder: stringValue(shared.streamientFolder) || 'Streamient', vaultMode: 'off', selectedPaths: [] });
      if (profile) {
        profiles.push(profile);
        profileStates[profile.id] = createProjectState({
          cursor: numberValue(local.cursor),
          lastSyncAt: numberValue(local.lastSyncAt),
          lastSyncError: stringValue(local.lastSyncError),
          lastSyncRequestAt: numberValue(local.lastSyncRequestAt),
          fileStates: record(local.fileStates) as ProjectSyncState['fileStates'],
          pendingOperations: [],
          paused: true,
          needsReview: true,
        });
      }
    }
  }
  return {
    schemaVersion: 2,
    serverUrl: normalizeServerUrl(stringValue(shared.serverUrl) || DEFAULT_SERVER_URL),
    authenticated: false,
    defaultAccountKey: stringValue(local.defaultAccountKey),
    accounts,
    deviceId: stringValue(local.deviceId) || uuid(),
    deviceName: stringValue(local.deviceName) || defaultDeviceName,
    pendingOauthState: stringValue(local.pendingOauthState),
    pendingOauthVerifier: stringValue(local.pendingOauthVerifier),
    pendingOauthMode: local.pendingOauthMode === 'additional' || local.pendingOauthMode === 'profile' ? local.pendingOauthMode : 'default',
    pendingOauthProfileId: stringValue(local.pendingOauthProfileId),
    profiles,
    profileStates,
  };
}

export function safeProjectFolderName(value: string): string {
  return value.replace(/[<>:"/\\|?*]/g, '_').trim().slice(0, 100) || 'Project';
}

export function uniqueProjectFolder(projectName: string, profiles: ProjectSyncProfile[]): string {
  const base = `Streamient/${safeProjectFolderName(projectName)}`;
  const used = new Set(profiles.map((profile) => profile.streamientFolder.toLowerCase()));
  if (!used.has(base.toLowerCase())) return base;
  for (let index = 2; ; index++) {
    const candidate = `${base}-${index}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}

export function matchesScopePath(filePath: string, entry: SyncScopePath): boolean {
  return filePath === entry.path || entry.kind === 'folder' && filePath.startsWith(`${entry.path}/`);
}

function pathsOverlap(left: SyncScopePath, right: SyncScopePath): boolean {
  return matchesScopePath(left.path, right) || matchesScopePath(right.path, left);
}

function managedPath(profile: ProjectSyncProfile): SyncScopePath {
  return { path: profile.streamientFolder, kind: 'folder' };
}

export function profileConfigurationError(profiles: ProjectSyncProfile[], candidate: ProjectSyncProfile): string {
  const others = profiles.filter((profile) => profile.id !== candidate.id);
  if (others.some((profile) => profile.connectionId === candidate.connectionId || profile.accountKey === candidate.accountKey && profile.projectId === candidate.projectId)) return 'This project is already configured.';
  if (candidate.vaultMode === 'all' && others.some((profile) => profile.vaultMode === 'all')) return 'Only one project can sync the entire vault.';
  const candidateManaged = managedPath(candidate);
  for (const other of others) {
    if (pathsOverlap(candidateManaged, managedPath(other)) || other.vaultMode === 'selected' && other.selectedPaths.some((path) => pathsOverlap(candidateManaged, path))) return `Project folders overlap with ${other.projectName}.`;
  }
  const selected = candidate.vaultMode === 'selected' ? candidate.selectedPaths : [];
  for (let index = 0; index < selected.length; index++) {
    if (pathsOverlap(selected[index], candidateManaged)) return 'Selected vault content cannot overlap its managed project folder.';
    for (let otherIndex = index + 1; otherIndex < selected.length; otherIndex++) {
      if (pathsOverlap(selected[index], selected[otherIndex])) return 'Selected vault paths overlap each other.';
    }
    for (const other of others) {
      if (pathsOverlap(selected[index], managedPath(other)) || other.vaultMode === 'selected' && other.selectedPaths.some((path) => pathsOverlap(selected[index], path))) return `Selected vault content overlaps with ${other.projectName}.`;
    }
  }
  return '';
}

export function ownerForPath(profiles: ProjectSyncProfile[], value: string): ProjectSyncProfile | null {
  let filePath = '';
  try {
    filePath = normalizeVaultPath(value);
    if (isExcludedVaultPath(filePath)) return null;
  } catch {
    return null;
  }
  const managed = profiles.filter((profile) => matchesScopePath(filePath, managedPath(profile))).sort((left, right) => right.streamientFolder.length - left.streamientFolder.length)[0];
  if (managed) return managed;
  const selected = profiles.flatMap((profile) => profile.vaultMode === 'selected' ? profile.selectedPaths.map((path) => ({ profile, path })) : []).filter(({ path }) => matchesScopePath(filePath, path)).sort((left, right) => right.path.path.length - left.path.path.length)[0];
  if (selected) return selected.profile;
  return profiles.find((profile) => profile.vaultMode === 'all') || null;
}

export function profileOwnsPath(profile: ProjectSyncProfile, profiles: ProjectSyncProfile[], path: string): boolean {
  return ownerForPath(profiles, path)?.id === profile.id;
}

export function manifestScope(profile: ProjectSyncProfile, profiles: ProjectSyncProfile[]): ManifestScope {
  const excluded = profiles.filter((other) => other.id !== profile.id).flatMap((other) => [managedPath(other), ...(other.vaultMode === 'selected' ? other.selectedPaths : [])]);
  return { vault_mode: profile.vaultMode, selected_paths: profile.vaultMode === 'selected' ? profile.selectedPaths : [], excluded_paths: normalizeScopePaths(excluded) };
}

export function accountKey(accountId: string, userId: string): string {
  return `${accountId}:${userId}`;
}

export function retainOwnedOperations(operations: PendingOperation[], profile: ProjectSyncProfile, profiles: ProjectSyncProfile[]): PendingOperation[] {
  return operations.filter((operation) => profileOwnsPath(profile, profiles, operation.path));
}
