import { App, Modal, Notice, Platform, Setting, TFile, normalizePath } from 'obsidian';

import { StreamientApi, StreamientRequestCancelledError } from './api';
import { coalescePending, isExcludedVaultPath, mimeTypeForPath, normalizeVaultPath, sha256Hex, uuid, vaultFileKind } from './core';
import { manifestScope, profileOwnsPath } from './profiles';
import type { FileState, ManifestEntry, ManifestSummary, PendingOperation, ProjectSyncProfile, ProjectSyncState, StreamientSyncSettings, SyncAction, SyncChange, SyncPhase, SyncProgress } from './types';

interface SyncEngineOptions {
  app: App;
  api: () => StreamientApi;
  profile: ProjectSyncProfile;
  state: ProjectSyncState;
  settings: StreamientSyncSettings;
  profiles: () => ProjectSyncProfile[];
  saveSettings: () => Promise<void>;
  requestSave: () => void;
  onProgress: (progress: SyncProgress) => void;
  onWorkQueued: () => void;
}

export class SyncCancelledError extends Error {
  constructor() {
    super('Streamient sync canceled');
  }
}

function humanBytes(value: number): string {
  if (value < 1000) return `${value} B`;
  const units = ['kB', 'MB', 'GB', 'TB'];
  let amount = value;
  let unit = '';
  for (const candidate of units) {
    amount /= 1000;
    unit = candidate;
    if (amount < 1000) break;
  }
  return `${amount.toFixed(amount >= 10 ? 1 : 2)} ${unit}`;
}

class SyncPreviewModal extends Modal {
  private readonly projectName: string;
  private readonly summary: ManifestSummary;
  private readonly done: (confirmed: boolean) => void;
  private settled = false;

  constructor(app: App, projectName: string, summary: ManifestSummary, done: (confirmed: boolean) => void) {
    super(app);
    this.projectName = projectName;
    this.summary = summary;
    this.done = done;
  }

  private finish(confirmed: boolean): void {
    if (this.settled) return;
    this.settled = true;
    this.done(confirmed);
    this.close();
  }

  onOpen(): void {
    this.titleEl.setText(`Review ${this.projectName} sync`);
    this.contentEl.createEl('p', { text: 'Nothing changes until you start this sync.' });
    const list = this.contentEl.createEl('ul');
    for (const action of ['upload', 'download', 'trash', 'noop', 'ignore'] as const) list.createEl('li', { text: `${this.summary.counts[action] || 0} ${action}` });
    list.createEl('li', { text: `${humanBytes(this.summary.bytes.upload)} to Streamient` });
    list.createEl('li', { text: `${humanBytes(this.summary.bytes.download)} to Obsidian` });
    new Setting(this.contentEl)
      .addButton((button) => button.setButtonText('Cancel').onClick(() => this.finish(false)))
      .addButton((button) => button.setButtonText('Start sync').setCta().onClick(() => this.finish(true)));
  }

  onClose(): void {
    if (!this.settled) {
      this.settled = true;
      this.done(false);
    }
    this.contentEl.empty();
  }
}

function isCanceled(error: unknown): boolean {
  return error instanceof SyncCancelledError || error instanceof StreamientRequestCancelledError;
}

export class SyncEngine {
  private readonly app: App;
  private readonly getApi: () => StreamientApi;
  private readonly profile: ProjectSyncProfile;
  private readonly state: ProjectSyncState;
  private readonly settings: StreamientSyncSettings;
  private readonly getProfiles: () => ProjectSyncProfile[];
  private readonly saveSettings: () => Promise<void>;
  private readonly requestSave: () => void;
  private readonly onProgress: (progress: SyncProgress) => void;
  private readonly onWorkQueued: () => void;
  private readonly suppressContent = new Map<string, string>();
  private readonly suppressRename = new Map<string, string>();
  private readonly suppressTrash = new Set<string>();
  private readonly debounce = new Map<string, number>();
  private controller: AbortController | null = null;
  private running = false;
  private lastCheckpointAt = 0;
  private lastProgressAt = 0;
  private progressState: SyncProgress;

  constructor(options: SyncEngineOptions) {
    this.app = options.app;
    this.getApi = options.api;
    this.profile = options.profile;
    this.state = options.state;
    this.settings = options.settings;
    this.getProfiles = options.profiles;
    this.saveSettings = options.saveSettings;
    this.requestSave = options.requestSave;
    this.onProgress = options.onProgress;
    this.onWorkQueued = options.onWorkQueued;
    this.progressState = { profileId: this.profile.id, projectName: this.profile.projectName, phase: this.state.paused ? 'paused' : 'idle', active: false, current: 0, total: 0, path: '', error: '' };
  }

  connected(): boolean {
    return Boolean(this.profile.connectionId && this.profile.projectId);
  }

  busy(): boolean {
    return this.running;
  }

  progress(): SyncProgress {
    return { ...this.progressState };
  }

  private report(phase: SyncPhase, active: boolean, current = 0, total = 0, path = '', error = '', force = false): void {
    const previousPhase = this.progressState.phase;
    this.progressState = { profileId: this.profile.id, projectName: this.profile.projectName, phase, active, current, total, path, error };
    const now = Date.now();
    if (!force && active && phase === previousPhase && now - this.lastProgressAt < 100) return;
    this.lastProgressAt = now;
    this.onProgress({ ...this.progressState });
  }

  private throwIfCanceled(signal: AbortSignal): void {
    if (signal.aborted) throw new SyncCancelledError();
  }

  private async checkpoint(force = false): Promise<void> {
    const now = Date.now();
    if (!force && now - this.lastCheckpointAt < 1000) return;
    this.lastCheckpointAt = now;
    await this.saveSettings();
  }

  private async recordFailure(error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    this.state.lastSyncError = message;
    this.report('failed', false, this.progressState.current, this.progressState.total, this.progressState.path, message, true);
    await this.checkpoint(true);
  }

  private async recordSuccess(): Promise<void> {
    this.state.lastSyncAt = Date.now();
    this.state.lastSyncError = '';
    await this.checkpoint(true);
  }

  private async recordCanceled(): Promise<void> {
    this.state.paused = true;
    this.state.lastSyncError = '';
    this.report('paused', false, this.progressState.current, this.progressState.total, this.progressState.path, '', true);
    await this.checkpoint(true);
  }

  private devicePayload(): Record<string, unknown> {
    return { device_id: this.settings.deviceId, device_name: this.settings.deviceName, platform: Platform.isMobile ? 'mobile' : 'desktop' };
  }

  owns(path: string): boolean {
    return profileOwnsPath(this.profile, this.getProfiles(), path);
  }

  private included(file: TFile): boolean {
    try {
      return !isExcludedVaultPath(file.path) && this.owns(file.path);
    } catch {
      return false;
    }
  }

  private async bytes(file: TFile): Promise<ArrayBuffer> {
    return this.app.vault.readBinary(file);
  }

  private stateFor(path: string): FileState | undefined {
    return this.state.fileStates[normalizeVaultPath(path)];
  }

  private setState(path: string, state: FileState): void {
    this.state.fileStates[normalizeVaultPath(path)] = state;
  }

  private removeState(path: string): FileState | undefined {
    const normalized = normalizeVaultPath(path);
    const state = this.state.fileStates[normalized];
    delete this.state.fileStates[normalized];
    return state;
  }

  async manifest(signal: AbortSignal): Promise<ManifestEntry[]> {
    const entries: ManifestEntry[] = [];
    const files = this.app.vault.getFiles().filter((file) => this.included(file));
    this.report('scanning', true, 0, files.length, '', '', true);
    for (let index = 0; index < files.length; index++) {
      this.throwIfCanceled(signal);
      const file = files[index];
      const state = this.stateFor(file.path);
      let sha256 = state?.sha256 || '';
      if (!state || state.modifiedAt !== file.stat.mtime || state.size !== file.stat.size) sha256 = await sha256Hex(await this.bytes(file));
      entries.push({ file_id: state?.fileId, path: file.path, kind: vaultFileKind(file.path), size: file.stat.size, sha256, modified_at: new Date(file.stat.mtime).toISOString(), base_revision: state?.revision || 0, in_trash: false });
      this.report('scanning', true, index + 1, files.length, file.path);
      if ((index + 1) % 25 === 0) await new Promise((resolve) => window.setTimeout(resolve, 0));
    }
    return entries;
  }

  private preview(summary: ManifestSummary, signal: AbortSignal): Promise<boolean> {
    return new Promise((resolve) => {
      const modal = new SyncPreviewModal(this.app, this.profile.projectName, summary, resolve);
      signal.addEventListener('abort', () => modal.close(), { once: true });
      modal.open();
    });
  }

  async fullSync(review = false): Promise<void> {
    if (!this.connected() || this.running || this.state.paused && !review) return;
    this.running = true;
    this.controller = new AbortController();
    const signal = this.controller.signal;
    try {
      const localManifest = await this.manifest(signal);
      const scope = manifestScope(this.profile, this.getProfiles());
      if (review || this.state.needsReview) {
        this.report('reconciling', true, 0, 0, '', '', true);
        const preview = await this.getApi().manifest(this.profile.connectionId, localManifest, scope, this.devicePayload(), true, true, signal);
        this.throwIfCanceled(signal);
        this.report('preview', true, 0, preview.summary.total, '', '', true);
        if (!await this.preview(preview.summary, signal)) {
          this.throwIfCanceled(signal);
          this.report('idle', false, 0, 0, '', '', true);
          return;
        }
        this.state.needsReview = false;
        this.state.paused = false;
        await this.checkpoint(true);
      }
      this.throwIfCanceled(signal);
      this.report('reconciling', true, 0, 0, '', '', true);
      const result = await this.getApi().manifest(this.profile.connectionId, localManifest, scope, this.devicePayload(), false, false, signal);
      this.throwIfCanceled(signal);
      const order: Record<SyncAction['action'], number> = { download: 0, trash: 1, noop: 2, upload: 3, ignore: 4 };
      const actions = [...result.actions].sort((left, right) => order[left.action] - order[right.action]);
      this.report('applying', true, 0, actions.length, '', '', true);
      for (let index = 0; index < actions.length; index++) {
        this.throwIfCanceled(signal);
        const action = actions[index];
        this.report('applying', true, index, actions.length, action.path);
        await this.applyManifestAction(action, signal);
        this.report('applying', true, index + 1, actions.length, action.path);
        await this.checkpoint();
        if ((index + 1) % 25 === 0) await new Promise((resolve) => window.setTimeout(resolve, 0));
      }
      await this.flushOperations(signal);
      this.state.cursor = Math.max(this.state.cursor, result.cursor || 0);
      this.state.lastSyncRequestAt = result.connection.sync_requested_at ? new Date(result.connection.sync_requested_at).getTime() : this.state.lastSyncRequestAt;
      await this.recordSuccess();
      this.report('complete', false, 0, 0, '', '', true);
      new Notice(`${this.profile.projectName} sync complete`);
    } catch (error) {
      if (isCanceled(error)) await this.recordCanceled();
      else {
        await this.recordFailure(error);
        throw error;
      }
    } finally {
      this.running = false;
      this.controller = null;
    }
  }

  private async applyManifestAction(action: SyncAction, signal: AbortSignal): Promise<void> {
    if (action.action === 'ignore') return;
    if (action.action === 'noop') {
      if (action.id && action.sha256 && action.revision !== undefined) this.setState(action.path, { fileId: action.id, revision: action.revision, sha256: action.sha256, modifiedAt: new Date(action.modified_at || Date.now()).getTime(), size: action.size || 0, inTrash: Boolean(action.in_trash) });
      return;
    }
    if (action.action === 'upload') {
      if (action.id && action.revision !== undefined) this.setState(action.path, { fileId: action.id, revision: action.revision, sha256: action.sha256 || '', modifiedAt: new Date(action.modified_at || 0).getTime(), size: action.size || 0, inTrash: Boolean(action.in_trash) });
      await this.applyOperation({ operationId: uuid(), operation: action.base_revision ? 'update' : 'create', path: action.path, queuedAt: Date.now() }, signal);
      return;
    }
    if (action.action === 'trash') {
      await this.applyTrash(action.path);
      return;
    }
    if (action.action === 'download' && action.id) await this.applyContent({ sequence: 0, file_id: action.id, operation: action.in_trash ? 'trash' : 'update', path: action.path, revision: action.revision || 0, sha256: action.sha256 || '', modified_at: action.modified_at || new Date().toISOString(), source: 'streamient', conflict: false, download_url: `/api/v1/obsidian/files/${action.id}/content` });
  }

  queue(operation: PendingOperation): void {
    this.state.pendingOperations = coalescePending(this.state.pendingOperations, operation);
    this.requestSave();
    if (!this.running && !this.state.paused && !this.state.needsReview) this.onWorkQueued();
  }

  queueFile(file: TFile): void {
    if (!this.connected() || !this.included(file)) return;
    const prior = this.debounce.get(file.path);
    if (prior) window.clearTimeout(prior);
    this.debounce.set(file.path, window.setTimeout(() => {
      this.debounce.delete(file.path);
      void this.handleFileChange(file);
    }, 750));
  }

  private async handleFileChange(file: TFile): Promise<void> {
    if (!this.included(file)) return;
    const content = await this.bytes(file);
    const sha256 = await sha256Hex(content);
    const expected = this.suppressContent.get(file.path);
    if (expected === sha256) {
      this.suppressContent.delete(file.path);
      const current = this.stateFor(file.path);
      if (current) this.setState(file.path, { ...current, sha256, modifiedAt: file.stat.mtime, size: file.stat.size, inTrash: false });
      this.requestSave();
      return;
    }
    if (expected) this.suppressContent.delete(file.path);
    const current = this.stateFor(file.path);
    if (current?.sha256 === sha256) return;
    this.queue({ operationId: uuid(), operation: current ? 'update' : 'create', path: file.path, queuedAt: Date.now() });
  }

  async handleRename(file: TFile, oldPath: string): Promise<void> {
    if (!this.connected()) return;
    if (this.suppressTrash.has(oldPath) && !this.included(file)) {
      window.setTimeout(() => this.suppressTrash.delete(oldPath), 5000);
      return;
    }
    const expected = this.suppressRename.get(oldPath);
    if (expected === file.path) {
      this.suppressRename.delete(oldPath);
      return;
    }
    if (expected) this.suppressRename.delete(oldPath);
    const oldState = this.removeState(oldPath);
    const pendingLocalCreate = this.state.pendingOperations.some((operation) => operation.path === oldPath && operation.operation === 'create');
    if (!oldState && pendingLocalCreate) {
      this.state.pendingOperations = this.state.pendingOperations.filter((operation) => operation.path !== oldPath);
      this.queue({ operationId: uuid(), operation: 'create', path: file.path, queuedAt: Date.now() });
      return;
    }
    if (oldState) this.setState(file.path, oldState);
    if (!oldState) {
      this.queueFile(file);
      return;
    }
    this.queue({ operationId: uuid(), operation: 'rename', path: file.path, previousPath: oldPath, queuedAt: Date.now() });
  }

  handleScopeExit(path: string): void {
    this.state.pendingOperations = this.state.pendingOperations.filter((operation) => operation.path !== path && operation.previousPath !== path);
    this.requestSave();
  }

  async handleDelete(file: TFile): Promise<void> {
    if (!this.connected() || this.suppressTrash.delete(file.path)) return;
    const current = this.stateFor(file.path);
    if (!current) {
      this.state.pendingOperations = this.state.pendingOperations.filter((operation) => operation.path !== file.path);
      this.requestSave();
      return;
    }
    this.queue({ operationId: uuid(), operation: 'trash', path: file.path, queuedAt: Date.now() });
  }

  private async applyOperation(pending: PendingOperation, signal: AbortSignal): Promise<void> {
    this.throwIfCanceled(signal);
    const statePath = pending.previousPath || pending.path;
    const state = this.stateFor(pending.path) || this.stateFor(statePath);
    const mutation: Record<string, unknown> = { operation_id: pending.operationId, operation: pending.operation, file_id: state?.fileId, path: pending.path, previous_path: pending.previousPath, base_revision: state?.revision || 0, modified_at: new Date(pending.queuedAt).toISOString(), device_id: this.settings.deviceId };
    if (['create', 'update', 'restore'].includes(pending.operation)) {
      const abstract = this.app.vault.getAbstractFileByPath(pending.path);
      if (!(abstract instanceof TFile)) {
        if (!state) return;
        mutation.operation = 'trash';
      } else {
        const content = await this.bytes(abstract);
        mutation.upload_id = await this.getApi().upload(this.profile.connectionId, pending.path, mimeTypeForPath(pending.path), content, signal);
        mutation.modified_at = new Date(abstract.stat.mtime).toISOString();
      }
    }
    const response = await this.getApi().mutations(this.profile.connectionId, [mutation], this.devicePayload());
    const result = response.results[0];
    if (result.conflict) new Notice(result.accepted ? `Streamient resolved a conflict for ${result.file.path}; your newer change won.` : `Streamient resolved a conflict for ${result.file.path}; the server version was newer.`);
    if (result.accepted) {
      if (pending.previousPath) this.removeState(pending.previousPath);
      this.setState(result.file.path, { fileId: result.file.id, revision: result.file.revision, sha256: result.file.sha256, modifiedAt: new Date(result.file.modified_at).getTime(), size: result.file.size, inTrash: result.file.in_trash });
      this.state.cursor = Math.max(this.state.cursor, result.change.sequence || 0);
    } else {
      await this.applyContent(result.change);
    }
  }

  private async flushOperations(signal: AbortSignal): Promise<void> {
    const total = this.state.pendingOperations.length;
    let completed = 0;
    while (this.state.pendingOperations.length) {
      this.throwIfCanceled(signal);
      const pending = this.state.pendingOperations[0];
      if (!this.owns(pending.path)) {
        this.state.pendingOperations.shift();
        this.requestSave();
        continue;
      }
      const phase: SyncPhase = pending.operation === 'trash' ? 'trashing' : pending.operation === 'rename' ? 'renaming' : 'uploading';
      this.report(phase, true, completed, total, pending.path, '', true);
      await this.applyOperation(pending, signal);
      this.state.pendingOperations.shift();
      completed++;
      this.report(phase, true, completed, total, pending.path);
      await this.checkpoint();
    }
  }

  async flush(): Promise<void> {
    if (!this.connected() || this.running || this.state.paused || this.state.needsReview || !this.state.pendingOperations.length) return;
    this.running = true;
    this.controller = new AbortController();
    try {
      await this.flushOperations(this.controller.signal);
      await this.recordSuccess();
      this.report('complete', false, 0, 0, '', '', true);
    } catch (error) {
      if (isCanceled(error)) await this.recordCanceled();
      else {
        await this.recordFailure(error);
        throw error;
      }
    } finally {
      this.running = false;
      this.controller = null;
    }
  }

  async pull(): Promise<void> {
    if (!this.connected() || this.running || this.state.paused || this.state.needsReview) return;
    this.running = true;
    this.controller = new AbortController();
    const signal = this.controller.signal;
    let requestedAt = 0;
    let completed = 0;
    let runFullSync = false;
    try {
      let more = true;
      this.report('pulling', true, 0, 0, '', '', true);
      while (more) {
        this.throwIfCanceled(signal);
        const result = await this.getApi().changes(this.profile.connectionId, this.state.cursor, this.settings.deviceId);
        this.throwIfCanceled(signal);
        requestedAt = result.sync_requested_at ? new Date(result.sync_requested_at).getTime() : 0;
        for (const change of result.changes) {
          this.throwIfCanceled(signal);
          this.report('pulling', true, completed, 0, change.path);
          const inScope = this.owns(change.path) || Boolean(change.previous_path && this.owns(change.previous_path));
          const state = this.stateFor(change.path);
          if (inScope && !(change.device_id === this.settings.deviceId && state?.revision && state.revision >= change.revision)) {
            if (change.conflict && change.device_id !== this.settings.deviceId) new Notice(`Streamient conflict resolved for ${change.path}`);
            await this.applyContent(change);
          }
          this.state.cursor = Math.max(this.state.cursor, change.sequence);
          completed++;
          await this.checkpoint();
        }
        more = result.has_more;
      }
      await this.recordSuccess();
      this.report('complete', false, 0, 0, '', '', true);
      if (requestedAt > this.state.lastSyncRequestAt) {
        this.state.lastSyncRequestAt = requestedAt;
        await this.checkpoint(true);
        runFullSync = true;
      }
    } catch (error) {
      if (isCanceled(error)) await this.recordCanceled();
      else {
        await this.recordFailure(error);
        throw error;
      }
    } finally {
      this.running = false;
      this.controller = null;
    }
    if (runFullSync && !this.state.paused) await this.fullSync();
  }

  async abort(): Promise<void> {
    this.state.paused = true;
    if (this.controller) {
      this.report('stopping', true, this.progressState.current, this.progressState.total, this.progressState.path, '', true);
      this.controller.abort();
    } else {
      this.report('paused', false, 0, 0, '', '', true);
    }
    await this.checkpoint(true);
  }

  async resume(): Promise<void> {
    this.state.paused = false;
    this.report('idle', false, 0, 0, '', '', true);
    await this.checkpoint(true);
  }

  private async ensureParent(filePath: string): Promise<void> {
    const parts = normalizePath(filePath).split('/').slice(0, -1);
    let current = '';
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!this.app.vault.getAbstractFileByPath(current)) await this.app.vault.createFolder(current);
    }
  }

  private async applyContent(change: SyncChange): Promise<void> {
    if (change.operation === 'trash') {
      await this.applyTrash(change.path);
      const state = this.stateFor(change.path);
      if (state) this.setState(change.path, { ...state, revision: change.revision, modifiedAt: new Date(change.modified_at).getTime(), inTrash: true });
      return;
    }
    if (change.operation === 'rename' && change.previous_path) {
      const previous = this.app.vault.getAbstractFileByPath(change.previous_path);
      if (previous instanceof TFile) {
        await this.ensureParent(change.path);
        this.suppressRename.set(change.previous_path, change.path);
        await this.app.fileManager.renameFile(previous, normalizePath(change.path));
      }
      const priorState = this.removeState(change.previous_path);
      if (priorState) this.setState(change.path, { ...priorState, revision: change.revision, modifiedAt: new Date(change.modified_at).getTime() });
      return;
    }
    const content = await this.getApi().download(change.file_id);
    const sha256 = change.sha256 || await sha256Hex(content);
    if (change.previous_path && change.previous_path !== change.path) {
      const losing = this.app.vault.getAbstractFileByPath(change.previous_path);
      if (losing instanceof TFile) {
        this.suppressTrash.add(change.previous_path);
        await this.app.fileManager.trashFile(losing);
        window.setTimeout(() => this.suppressTrash.delete(change.previous_path || ''), 5000);
      }
      this.removeState(change.previous_path);
    }
    await this.ensureParent(change.path);
    const existing = this.app.vault.getAbstractFileByPath(change.path);
    this.suppressContent.set(change.path, sha256);
    const extension = change.path.split('.').at(-1)?.toLowerCase() || '';
    const textFile = ['md', 'canvas', 'base', 'txt', 'csv', 'tsv', 'json', 'yaml', 'yml', 'xml', 'html', 'htm'].includes(extension);
    if (existing instanceof TFile) {
      if (textFile) await this.app.vault.modify(existing, new TextDecoder().decode(content));
      else await this.app.vault.modifyBinary(existing, content);
    } else if (textFile) {
      await this.app.vault.create(normalizePath(change.path), new TextDecoder().decode(content));
    } else {
      await this.app.vault.createBinary(normalizePath(change.path), content);
    }
    this.setState(change.path, { fileId: change.file_id, revision: change.revision, sha256, modifiedAt: new Date(change.modified_at).getTime(), size: content.byteLength, inTrash: false });
  }

  private async applyTrash(filePath: string): Promise<void> {
    const existing = this.app.vault.getAbstractFileByPath(filePath);
    if (!(existing instanceof TFile)) return;
    this.suppressTrash.add(filePath);
    await this.app.fileManager.trashFile(existing);
    window.setTimeout(() => this.suppressTrash.delete(filePath), 5000);
  }
}
