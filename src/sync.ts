import { App, Modal, Notice, Platform, Setting, TFile, normalizePath } from 'obsidian';

import { coalescePending, isExcludedVaultPath, mimeTypeForPath, normalizeVaultPath, sha256Hex, uuid, vaultFileKind } from './core';
import { StreamientApi } from './api';
import type { FileState, ManifestEntry, PendingOperation, StreamientSyncSettings, SyncAction, SyncChange } from './types';

interface SyncEngineOptions {
  app: App;
  api: () => StreamientApi;
  settings: StreamientSyncSettings;
  saveSettings: () => Promise<void>;
}

class SyncPreviewModal extends Modal {
  private readonly actions: SyncAction[];
  private readonly done: (confirmed: boolean) => void;

  constructor(app: App, actions: SyncAction[], done: (confirmed: boolean) => void) {
    super(app);
    this.actions = actions;
    this.done = done;
  }

  onOpen(): void {
    const counts = this.actions.reduce<Record<string, number>>((result, action) => {
      result[action.action] = (result[action.action] || 0) + 1;
      return result;
    }, {});
    this.titleEl.setText('Review first Streamient sync');
    this.contentEl.createEl('p', { text: 'Streamient will reconcile this vault with the selected project.' });
    const list = this.contentEl.createEl('ul');
    for (const action of ['upload', 'download', 'trash', 'noop', 'ignore']) list.createEl('li', { text: `${counts[action] || 0} ${action}` });
    new Setting(this.contentEl)
      .addButton((button) => button.setButtonText('Cancel').onClick(() => { this.done(false); this.close(); }))
      .addButton((button) => button.setButtonText('Start sync').setCta().onClick(() => { this.done(true); this.close(); }));
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export class SyncEngine {
  private readonly app: App;
  private readonly getApi: () => StreamientApi;
  private readonly settings: StreamientSyncSettings;
  private readonly saveSettings: () => Promise<void>;
  private readonly suppressContent = new Map<string, string>();
  private readonly suppressRename = new Map<string, string>();
  private readonly suppressTrash = new Set<string>();
  private readonly debounce = new Map<string, number>();
  private flushing = false;
  private syncing = false;

  constructor(options: SyncEngineOptions) {
    this.app = options.app;
    this.getApi = options.api;
    this.settings = options.settings;
    this.saveSettings = options.saveSettings;
  }

  connected(): boolean {
    return Boolean(this.settings.connectionId && this.settings.projectId);
  }

  private devicePayload(): Record<string, unknown> {
    return { device_id: this.settings.deviceId, device_name: this.settings.deviceName, platform: Platform.isMobile ? 'mobile' : 'desktop' };
  }

  private included(file: TFile): boolean {
    try {
      return !isExcludedVaultPath(file.path);
    } catch {
      return false;
    }
  }

  private async bytes(file: TFile): Promise<ArrayBuffer> {
    return this.app.vault.readBinary(file);
  }

  private state(path: string): FileState | undefined {
    return this.settings.fileStates[normalizeVaultPath(path)];
  }

  private setState(path: string, state: FileState): void {
    this.settings.fileStates[normalizeVaultPath(path)] = state;
  }

  private removeState(path: string): FileState | undefined {
    const normalized = normalizeVaultPath(path);
    const state = this.settings.fileStates[normalized];
    delete this.settings.fileStates[normalized];
    return state;
  }

  async manifest(): Promise<ManifestEntry[]> {
    const entries: ManifestEntry[] = [];
    for (const file of this.app.vault.getFiles()) {
      if (!this.included(file)) continue;
      const state = this.state(file.path);
      let sha256 = state?.sha256 || '';
      if (!state || state.modifiedAt !== file.stat.mtime || state.size !== file.stat.size) sha256 = await sha256Hex(await this.bytes(file));
      entries.push({
        file_id: state?.fileId,
        path: file.path,
        kind: vaultFileKind(file.path),
        size: file.stat.size,
        sha256,
        modified_at: new Date(file.stat.mtime).toISOString(),
        base_revision: state?.revision || 0,
        in_trash: false,
      });
    }
    return entries;
  }

  private preview(actions: SyncAction[]): Promise<boolean> {
    return new Promise((resolve) => new SyncPreviewModal(this.app, actions, resolve).open());
  }

  async fullSync(confirm = false): Promise<void> {
    if (!this.connected() || this.syncing) return;
    this.syncing = true;
    try {
      const manifest = await this.manifest();
      let result = await this.getApi().manifest(this.settings.connectionId, manifest, this.devicePayload(), confirm);
      if (confirm) {
        if (!await this.preview(result.actions)) return;
        result = await this.getApi().manifest(this.settings.connectionId, manifest, this.devicePayload(), false);
      }
      for (const action of result.actions) await this.applyManifestAction(action);
      await this.flush();
      this.settings.cursor = Math.max(this.settings.cursor, result.cursor || 0);
      this.settings.lastSyncAt = Date.now();
      this.settings.lastSyncRequestAt = result.connection.sync_requested_at ? new Date(result.connection.sync_requested_at).getTime() : this.settings.lastSyncRequestAt;
      await this.saveSettings();
      new Notice('Streamient sync complete');
    } finally {
      this.syncing = false;
    }
  }

  private async applyManifestAction(action: SyncAction): Promise<void> {
    if (action.action === 'ignore') return;
    if (action.action === 'noop') {
      if (action.id && action.sha256 && action.revision !== undefined) this.setState(action.path, { fileId: action.id, revision: action.revision, sha256: action.sha256, modifiedAt: new Date(action.modified_at || Date.now()).getTime(), size: action.size || 0, inTrash: Boolean(action.in_trash) });
      return;
    }
    if (action.action === 'upload') {
		if (action.id && action.revision !== undefined) this.setState(action.path, { fileId: action.id, revision: action.revision, sha256: action.sha256 || '', modifiedAt: new Date(action.modified_at || 0).getTime(), size: action.size || 0, inTrash: Boolean(action.in_trash) });
      this.queue({ operationId: uuid(), operation: action.base_revision ? 'update' : 'create', path: action.path, queuedAt: Date.now() });
      return;
    }
    if (action.action === 'trash') {
      await this.applyTrash(action.path);
      return;
    }
    if (action.action === 'download' && action.id) {
      await this.applyContent({
        sequence: 0,
        file_id: action.id,
        operation: action.in_trash ? 'trash' : 'update',
        path: action.path,
        revision: action.revision || 0,
        sha256: action.sha256 || '',
        modified_at: action.modified_at || new Date().toISOString(),
        source: 'streamient',
        conflict: false,
        download_url: `/api/v1/obsidian/files/${action.id}/content`,
      });
    }
  }

  queue(operation: PendingOperation): void {
    this.settings.pendingOperations = coalescePending(this.settings.pendingOperations, operation);
    void this.saveSettings();
    window.setTimeout(() => void this.flush().catch((error) => console.error('Streamient sync failed', error)), 250);
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
      const current = this.state(file.path);
      if (current) this.setState(file.path, { ...current, sha256, modifiedAt: file.stat.mtime, size: file.stat.size, inTrash: false });
      await this.saveSettings();
      return;
    }
	if (expected) this.suppressContent.delete(file.path);
    const current = this.state(file.path);
    if (current?.sha256 === sha256) return;
    this.queue({ operationId: uuid(), operation: current ? 'update' : 'create', path: file.path, queuedAt: Date.now() });
  }

  async handleRename(file: TFile, oldPath: string): Promise<void> {
    if (!this.connected()) return;
	if (this.suppressTrash.has(oldPath) && !this.included(file)) {
		window.setTimeout(() => this.suppressTrash.delete(oldPath), 5_000);
		return;
	}
    const expected = this.suppressRename.get(oldPath);
    if (expected === file.path) {
      this.suppressRename.delete(oldPath);
      return;
    }
	if (expected) this.suppressRename.delete(oldPath);
    const oldState = this.removeState(oldPath);
	const pendingLocalCreate = this.settings.pendingOperations.some((operation) => operation.path === oldPath && operation.operation === 'create');
	if (!oldState && pendingLocalCreate) {
		this.settings.pendingOperations = this.settings.pendingOperations.filter((operation) => operation.path !== oldPath);
		this.queue({ operationId: uuid(), operation: 'create', path: file.path, queuedAt: Date.now() });
		return;
	}
    if (oldState) this.setState(file.path, oldState);
    if (!this.included(file)) {
		if (oldState) {
			this.setState(oldPath, oldState);
			this.queue({ operationId: uuid(), operation: 'trash', path: oldPath, queuedAt: Date.now() });
		}
      return;
    }
    if (!oldState) {
      this.queueFile(file);
      return;
    }
    this.queue({ operationId: uuid(), operation: 'rename', path: file.path, previousPath: oldPath, queuedAt: Date.now() });
  }

  async handleDelete(file: TFile): Promise<void> {
    if (!this.connected()) return;
    if (this.suppressTrash.delete(file.path)) return;
    const current = this.state(file.path);
    if (!current) {
		this.settings.pendingOperations = this.settings.pendingOperations.filter((operation) => operation.path !== file.path);
		await this.saveSettings();
		return;
	}
    this.queue({ operationId: uuid(), operation: 'trash', path: file.path, queuedAt: Date.now() });
  }

  async flush(): Promise<void> {
    if (!this.connected() || this.flushing || !this.settings.pendingOperations.length) return;
    this.flushing = true;
    try {
      while (this.settings.pendingOperations.length) {
        const pending = this.settings.pendingOperations[0];
        const statePath = pending.previousPath || pending.path;
        const state = this.state(pending.path) || this.state(statePath);
        const mutation: Record<string, unknown> = {
          operation_id: pending.operationId,
          operation: pending.operation,
          file_id: state?.fileId,
          path: pending.path,
          previous_path: pending.previousPath,
          base_revision: state?.revision || 0,
          modified_at: new Date(pending.queuedAt).toISOString(),
          device_id: this.settings.deviceId,
        };
        if (['create', 'update', 'restore'].includes(pending.operation)) {
          const abstract = this.app.vault.getAbstractFileByPath(pending.path);
          if (!(abstract instanceof TFile)) {
			if (!state) {
				this.settings.pendingOperations.shift();
				await this.saveSettings();
				continue;
			}
			pending.operation = 'trash';
            continue;
          }
          const content = await this.bytes(abstract);
          mutation.upload_id = await this.getApi().upload(this.settings.connectionId, pending.path, mimeTypeForPath(pending.path), content);
          mutation.modified_at = new Date(abstract.stat.mtime).toISOString();
        }
        const response = await this.getApi().mutations(this.settings.connectionId, [mutation], this.devicePayload());
        const result = response.results[0];
		if (result.conflict) new Notice(result.accepted ? `Streamient resolved a conflict for ${result.file.path}; your newer change won.` : `Streamient resolved a conflict for ${result.file.path}; the server version was newer.`);
        if (result.accepted) {
          if (pending.previousPath) this.removeState(pending.previousPath);
          this.setState(result.file.path, { fileId: result.file.id, revision: result.file.revision, sha256: result.file.sha256, modifiedAt: new Date(result.file.modified_at).getTime(), size: result.file.size, inTrash: result.file.in_trash });
          this.settings.cursor = Math.max(this.settings.cursor, result.change.sequence || 0);
        } else {
          await this.applyContent(result.change);
        }
        this.settings.pendingOperations.shift();
        await this.saveSettings();
      }
    } finally {
      this.flushing = false;
    }
  }

  async pull(): Promise<void> {
    if (!this.connected()) return;
    let more = true;
    let requestedAt = 0;
    while (more) {
      const result = await this.getApi().changes(this.settings.connectionId, this.settings.cursor, this.settings.deviceId);
      requestedAt = result.sync_requested_at ? new Date(result.sync_requested_at).getTime() : 0;
      for (const change of result.changes) {
		if (change.conflict && change.device_id !== this.settings.deviceId) new Notice(`Streamient conflict resolved for ${change.path}`);
        const state = this.state(change.path);
        if (change.device_id === this.settings.deviceId && state?.revision && state.revision >= change.revision) {
          this.settings.cursor = Math.max(this.settings.cursor, change.sequence);
          continue;
        }
        await this.applyContent(change);
        this.settings.cursor = Math.max(this.settings.cursor, change.sequence);
      }
      more = result.has_more;
    }
    this.settings.lastSyncAt = Date.now();
    await this.saveSettings();
    if (requestedAt > this.settings.lastSyncRequestAt) {
      this.settings.lastSyncRequestAt = requestedAt;
      await this.saveSettings();
      await this.fullSync(false);
    }
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
      const state = this.state(change.path);
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
      await this.saveSettings();
      return;
    }
    const content = await this.getApi().download(change.file_id);
    const sha256 = change.sha256 || await sha256Hex(content);
	if (change.previous_path && change.previous_path !== change.path) {
		const losing = this.app.vault.getAbstractFileByPath(change.previous_path);
		if (losing instanceof TFile) {
			this.suppressTrash.add(change.previous_path);
			await this.app.fileManager.trashFile(losing);
			window.setTimeout(() => this.suppressTrash.delete(change.previous_path || ''), 5_000);
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
    await this.saveSettings();
  }

  private async applyTrash(filePath: string): Promise<void> {
    const existing = this.app.vault.getAbstractFileByPath(filePath);
    if (!(existing instanceof TFile)) return;
    this.suppressTrash.add(filePath);
    await this.app.fileManager.trashFile(existing);
	window.setTimeout(() => this.suppressTrash.delete(filePath), 5_000);
  }
}
