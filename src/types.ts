export interface FileState {
  fileId: string;
  revision: number;
  sha256: string;
  modifiedAt: number;
  size: number;
  inTrash?: boolean;
}

export interface PendingOperation {
  operationId: string;
  operation: 'create' | 'update' | 'rename' | 'trash' | 'restore';
  path: string;
  previousPath?: string;
  queuedAt: number;
}

export type VaultScopeMode = 'off' | 'selected' | 'all';
export type ScopePathKind = 'file' | 'folder';

export interface SyncScopePath {
  path: string;
  kind: ScopePathKind;
}

export interface ProjectSyncProfile {
  id: string;
  accountKey: string;
  projectId: string;
  projectName: string;
  connectionId: string;
  streamientFolder: string;
  vaultMode: VaultScopeMode;
  selectedPaths: SyncScopePath[];
}

export interface ProjectSyncState {
  cursor: number;
  lastSyncAt: number;
  lastSyncError: string;
  lastSyncRequestAt: number;
  fileStates: Record<string, FileState>;
  pendingOperations: PendingOperation[];
  paused: boolean;
  needsReview: boolean;
  folderRelocationTarget: string;
}

export interface StreamientSyncSettings {
  schemaVersion: 2;
  serverUrl: string;
  authenticated: boolean;
  defaultAccountKey: string;
  accounts: Record<string, SyncAccount>;
  deviceId: string;
  deviceName: string;
  pendingOauthState: string;
  pendingOauthVerifier: string;
  pendingOauthMode: 'default' | 'additional' | 'profile';
  pendingOauthProfileId: string;
  profiles: ProjectSyncProfile[];
  profileStates: Record<string, ProjectSyncState>;
}

export type SyncPhase = 'idle' | 'scanning' | 'reconciling' | 'preview' | 'applying' | 'uploading' | 'trashing' | 'renaming' | 'pulling' | 'stopping' | 'paused' | 'complete' | 'failed';

export interface SyncProgress {
  profileId: string;
  projectName: string;
  phase: SyncPhase;
  active: boolean;
  current: number;
  total: number;
  path: string;
  error: string;
}

export interface SyncAccount {
  key: string;
  accountId: string;
  accountName: string;
  userId: string;
  userName: string;
  userEmail: string;
  serverUrl: string;
}

export interface AccountSummary {
  id: string;
  name: string;
  role: string;
  user: { id: string; name: string; email: string };
}

export interface ProjectSummary {
  _id: string;
  name: string;
  color?: string;
  is_default?: boolean;
}

export interface ConnectionSummary {
  id: string;
  project_id: string;
  name: string;
  streamient_folder: string;
  enabled: boolean;
  sequence: number;
  sync_requested_at?: string | null;
  folder_relocation?: { from: string; to: string; started_at?: string | null } | null;
}

export interface ManifestEntry {
  file_id?: string;
  path: string;
  kind: string;
  size: number;
  sha256: string;
  modified_at: string;
  base_revision: number;
  in_trash: boolean;
}

export interface ManifestScope {
  vault_mode: VaultScopeMode;
  selected_paths: SyncScopePath[];
  excluded_paths: SyncScopePath[];
}

export interface ManifestSummary {
  total: number;
  counts: Record<SyncAction['action'], number>;
  bytes: { upload: number; download: number };
}

export interface ManifestResult {
  actions: SyncAction[];
  summary: ManifestSummary;
  cursor: number;
  connection: ConnectionSummary;
  exports_pending?: boolean;
}

export interface ProjectExportResult {
  actions: SyncAction[];
  summary: ManifestSummary;
  cursor: number;
  has_more: boolean;
}

export interface FolderRelocationResult {
  connection: ConnectionSummary;
  changes: SyncChange[];
  moved: number;
  remaining: number;
  has_more: boolean;
}

export interface SyncAction {
  action: 'ignore' | 'noop' | 'upload' | 'download' | 'trash';
  id?: string;
  path: string;
  kind?: string;
  mime_type?: string;
  size?: number;
  sha256?: string;
  revision?: number;
  modified_at?: string;
  in_trash?: boolean;
  base_revision?: number;
}

export interface SyncChange {
  sequence: number;
  file_id: string;
  operation: PendingOperation['operation'];
  path: string;
  previous_path?: string | null;
  revision: number;
  sha256: string;
  modified_at: string;
  source: 'obsidian' | 'streamient';
  device_id?: string | null;
  conflict: boolean;
  download_url?: string | null;
}

export interface MutationResult {
  accepted: boolean;
  duplicate?: boolean;
  conflict: boolean;
  file: {
    id: string;
    path: string;
    size: number;
    sha256: string;
    revision: number;
    modified_at: string;
    in_trash: boolean;
  };
  change: SyncChange;
}
