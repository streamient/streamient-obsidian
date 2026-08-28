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

export interface StreamientSyncSettings {
  serverUrl: string;
  connectionId: string;
  projectId: string;
  projectName: string;
  authenticated: boolean;
  deviceId: string;
  deviceName: string;
  cursor: number;
  streamientFolder: string;
  lastSyncAt: number;
  lastSyncError: string;
  lastSyncRequestAt: number;
  pendingOauthState: string;
  pendingOauthVerifier: string;
  fileStates: Record<string, FileState>;
  pendingOperations: PendingOperation[];
}

export type SyncPhase = 'idle' | 'scanning' | 'reconciling' | 'preview' | 'applying' | 'uploading' | 'pulling' | 'complete' | 'failed';

export interface SyncProgress {
  phase: SyncPhase;
  active: boolean;
  current: number;
  total: number;
  path: string;
  error: string;
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
