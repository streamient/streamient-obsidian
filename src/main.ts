import { App, ButtonComponent, FuzzySuggestModal, Notice, Platform, Plugin, PluginSettingTab, type SettingDefinitionItem, TFile } from 'obsidian';

import { authorizationUrl, exchangeAuthorizationCode, refreshAccessToken, StreamientApi } from './api';
import { base64Url, normalizeServerUrl, pkceChallenge, uuid } from './core';
import { SyncEngine } from './sync';
import type { ProjectSummary, StreamientSyncSettings, SyncProgress } from './types';

const DEFAULT_SETTINGS: StreamientSyncSettings = {
  serverUrl: 'https://app.streamient.com',
  connectionId: '',
  projectId: '',
  projectName: '',
  authenticated: false,
  deviceId: '',
  deviceName: '',
  cursor: 0,
  streamientFolder: 'Streamient',
  lastSyncAt: 0,
  lastSyncError: '',
  lastSyncRequestAt: 0,
  pendingOauthState: '',
  pendingOauthVerifier: '',
  fileStates: {},
  pendingOperations: [],
};

const DEVICE_SETTING_KEYS = ['authenticated', 'deviceId', 'deviceName', 'cursor', 'lastSyncAt', 'lastSyncError', 'lastSyncRequestAt', 'pendingOauthState', 'pendingOauthVerifier', 'fileStates', 'pendingOperations'] as const;

class ProjectPicker extends FuzzySuggestModal<ProjectSummary> {
  private readonly projects: ProjectSummary[];
  private readonly choose: (project: ProjectSummary) => void;

  constructor(app: App, projects: ProjectSummary[], choose: (project: ProjectSummary) => void) {
    super(app);
    this.projects = projects;
    this.choose = choose;
    this.setPlaceholder('Choose a Streamient project');
  }

  getItems(): ProjectSummary[] {
    return this.projects;
  }

  getItemText(project: ProjectSummary): string {
    return project.name;
  }

  onChooseItem(project: ProjectSummary): void {
    this.choose(project);
  }
}

export default class StreamientSyncPlugin extends Plugin {
  settings: StreamientSyncSettings = { ...DEFAULT_SETTINGS };
  private engine!: SyncEngine;
  private accessToken = '';
  private accessTokenExpiresAt = 0;
  private apiClient: StreamientApi | null = null;
  private statusBar: HTMLElement | null = null;
  private settingTab: StreamientSettingTab | null = null;
  syncProgress: SyncProgress = { phase: 'idle', active: false, current: 0, total: 0, path: '', error: '' };

  async onload(): Promise<void> {
    const savedSettings: unknown = await this.loadData();
    const localSettings: unknown = this.app.loadLocalStorage(this.localStorageKey());
    Object.assign(this.settings, DEFAULT_SETTINGS, this.settingsRecord(savedSettings), this.settingsRecord(localSettings));
    this.settings.fileStates ||= {};
    this.settings.pendingOperations ||= [];
    this.settings.deviceId ||= uuid();
    this.settings.deviceName ||= Platform.isMobile ? 'Obsidian mobile' : 'Obsidian desktop';
    this.settings.authenticated = Boolean(this.app.secretStorage.getSecret(this.secretName()));
    await this.saveSettings();

    this.engine = new SyncEngine({ app: this.app, api: () => this.api(), settings: this.settings, saveSettings: () => this.saveSettings(), onProgress: (progress) => this.updateSyncProgress(progress) });
    this.settingTab = new StreamientSettingTab(this.app, this);
    this.addSettingTab(this.settingTab);
    this.addRibbonIcon('refresh-cw', 'Sync with Streamient', () => void this.syncNow());
    if (!Platform.isMobile) this.statusBar = this.addStatusBarItem();
    this.refreshStatus();

    this.addCommand({ id: 'sync-now', name: 'Sync now', callback: () => void this.syncNow() });
    this.addCommand({ id: 'connect', name: 'Connect account', callback: () => void this.startAuthorization() });
    this.addCommand({ id: 'choose-project', name: 'Choose project', callback: () => void this.chooseProject() });

    this.registerObsidianProtocolHandler('streamient-auth', (parameters) => {
      void this.finishAuthorization(String(parameters.code || ''), String(parameters.state || ''), String(parameters.error || ''));
    });

    this.app.workspace.onLayoutReady(() => {
      this.registerEvent(this.app.vault.on('create', (file) => { if (file instanceof TFile) this.engine.queueFile(file); }));
      this.registerEvent(this.app.vault.on('modify', (file) => { if (file instanceof TFile) this.engine.queueFile(file); }));
      this.registerEvent(this.app.vault.on('rename', (file, oldPath) => { if (file instanceof TFile) void this.engine.handleRename(file, oldPath); }));
      this.registerEvent(this.app.vault.on('delete', (file) => { if (file instanceof TFile) void this.engine.handleDelete(file); }));
      void this.resumeSync();
    });

    this.registerInterval(window.setInterval(() => void this.resumeSync(), 30_000));
    this.registerDomEvent(window, 'online', () => void this.resumeSync());
    this.registerDomEvent(document, 'visibilitychange', () => { if (!document.hidden) void this.resumeSync(); });
  }

  async saveSettings(): Promise<void> {
    const shared = { ...this.settings } as Record<string, unknown>;
    const local: Record<string, unknown> = {};
    for (const key of DEVICE_SETTING_KEYS) {
      local[key] = this.settings[key];
      delete shared[key];
    }
    await this.saveData(shared);
    this.app.saveLocalStorage(this.localStorageKey(), local);
    this.refreshStatus();
  }

  private settingsRecord(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  }

  private localStorageKey(): string {
    return `${this.manifest.id}-device-${this.app.vault.getName().toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  }

  private secretName(): string {
    return `streamient-sync-${this.settings.deviceId}`;
  }

  private async setRefreshToken(value: string): Promise<void> {
    if (value) await Promise.resolve(this.app.secretStorage.setSecret(this.secretName(), value));
    else await Promise.resolve(this.app.secretStorage.setSecret(this.secretName(), ''));
  }

  private refreshStatus(): void {
    if (!this.statusBar) return;
    if (!this.settings.authenticated) {
      this.statusBar.setText('Streamient: signed out');
      return;
    }
    if (!this.settings.connectionId) {
      this.statusBar.setText('Streamient: choose a project');
      return;
    }
    if (this.syncProgress.active || this.syncProgress.phase === 'failed') {
      this.statusBar.setText(`Streamient: ${this.syncStatusText()}`);
      return;
    }
    const last = this.settings.lastSyncAt ? new Date(this.settings.lastSyncAt).toLocaleTimeString() : 'never';
    this.statusBar.setText(`Streamient: ${this.settings.pendingOperations.length} pending · ${last}`);
  }

  private refreshSettingsTab(): void {
    this.settingTab?.update();
  }

  syncStatusText(): string {
    const progress = this.syncProgress;
    const labels: Record<SyncProgress['phase'], string> = { idle: 'Idle', scanning: 'Scanning vault', reconciling: 'Reconciling manifest', preview: 'Waiting for confirmation', applying: 'Applying changes', uploading: 'Uploading content', trashing: 'Moving items to trash', renaming: 'Renaming items', pulling: 'Pulling changes', complete: 'Sync complete', failed: 'Sync failed' };
    if (progress.phase === 'failed') return progress.error ? `failed: ${progress.error}` : 'failed';
    if (progress.active) return progress.total > 0 ? `${labels[progress.phase]} ${Math.min(progress.current, progress.total)}/${progress.total}` : progress.current > 0 ? `${labels[progress.phase]} · ${progress.current}` : labels[progress.phase];
    if (this.settings.lastSyncError) return `Last sync failed: ${this.settings.lastSyncError}`;
    return this.settings.lastSyncAt ? `Last completed ${new Date(this.settings.lastSyncAt).toLocaleString()}` : 'No completed sync yet';
  }

  private updateSyncProgress(progress: SyncProgress): void {
    this.syncProgress = progress;
    this.refreshStatus();
    this.settingTab?.updateSyncStatus();
  }

  private async token(): Promise<string> {
    if (this.accessToken && this.accessTokenExpiresAt > Date.now() + 15_000) return this.accessToken;
    const stored = this.app.secretStorage.getSecret(this.secretName());
    if (!stored) throw new Error('Connect Streamient first');
    const tokens = await refreshAccessToken(this.settings.serverUrl, stored);
    this.accessToken = tokens.access_token;
    this.accessTokenExpiresAt = Date.now() + tokens.expires_in * 1000;
    await this.setRefreshToken(tokens.refresh_token);
    return this.accessToken;
  }

  api(): StreamientApi {
    const serverUrl = normalizeServerUrl(this.settings.serverUrl);
    if (!this.apiClient || this.apiClient.serverUrl !== serverUrl) this.apiClient = new StreamientApi(serverUrl, () => this.token());
    return this.apiClient;
  }

  async startAuthorization(): Promise<void> {
    try {
      this.settings.serverUrl = normalizeServerUrl(this.settings.serverUrl);
      const verifierBytes = crypto.getRandomValues(new Uint8Array(48));
      const verifier = base64Url(verifierBytes.buffer);
      const state = uuid();
      this.settings.pendingOauthVerifier = verifier;
      this.settings.pendingOauthState = state;
      await this.saveSettings();
      window.open(authorizationUrl(this.settings.serverUrl, state, await pkceChallenge(verifier)), '_blank');
      new Notice('Complete authorization in your browser');
    } catch (error) {
      new Notice(`Streamient authorization failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async finishAuthorization(code: string, state: string, oauthError: string): Promise<void> {
    try {
      if (oauthError) throw new Error(oauthError);
      if (!code || !state || state !== this.settings.pendingOauthState || !this.settings.pendingOauthVerifier) throw new Error('Authorization response is invalid or expired');
      const tokens = await exchangeAuthorizationCode(this.settings.serverUrl, code, this.settings.pendingOauthVerifier);
      this.accessToken = tokens.access_token;
      this.accessTokenExpiresAt = Date.now() + tokens.expires_in * 1000;
      await this.setRefreshToken(tokens.refresh_token);
      this.settings.authenticated = true;
      this.settings.pendingOauthState = '';
      this.settings.pendingOauthVerifier = '';
      await this.saveSettings();
      this.refreshSettingsTab();
      new Notice('Connected to Streamient');
      await this.chooseProject();
    } catch (error) {
      new Notice(`Streamient authorization failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async chooseProject(): Promise<void> {
    if (!this.settings.authenticated) {
      new Notice('Sign in to Streamient first');
      return;
    }
    try {
      const projects = await this.api().projects();
      new ProjectPicker(this.app, projects, (project) => void this.connectProject(project)).open();
    } catch (error) {
      new Notice(`Could not list Streamient projects: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async connectProject(project: ProjectSummary): Promise<void> {
    try {
      const connection = await this.api().connect({
        project_id: project._id,
        name: this.app.vault.getName(),
        streamient_folder: this.settings.streamientFolder,
        device_id: this.settings.deviceId,
        device_name: this.settings.deviceName,
        platform: Platform.isMobile ? 'mobile' : 'desktop',
      });
      if (!connection.enabled) await this.api().updateConnection(connection.id, { enabled: true });
      this.settings.connectionId = connection.id;
      this.settings.projectId = project._id;
      this.settings.projectName = project.name;
      this.settings.streamientFolder = connection.streamient_folder;
      this.settings.cursor = 0;
      this.settings.fileStates = {};
      this.settings.pendingOperations = [];
      await this.saveSettings();
      this.refreshSettingsTab();
      await this.engine.fullSync(true);
    } catch (error) {
      new Notice(`Could not connect Streamient project: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.refreshSettingsTab();
    }
  }

  async disconnect(): Promise<void> {
    try {
      if (this.settings.connectionId) await this.api().updateConnection(this.settings.connectionId, { enabled: false });
    } catch (error) {
      console.warn('Streamient disconnect request failed', error);
    }
    await this.setRefreshToken('');
    this.accessToken = '';
    this.accessTokenExpiresAt = 0;
    Object.assign(this.settings, { authenticated: false, connectionId: '', projectId: '', projectName: '', cursor: 0, fileStates: {}, pendingOperations: [] });
    await this.saveSettings();
    this.refreshSettingsTab();
    new Notice('Disconnected from Streamient. Synced knowledge remains.');
  }

  async syncNow(): Promise<void> {
    if (!this.engine.connected()) {
      new Notice('Connect Streamient and choose a project first');
      return;
    }
    if (this.engine.busy()) {
      new Notice(`Streamient sync already running: ${this.syncStatusText()}`);
      return;
    }
    try {
      await this.engine.fullSync(false);
    } catch (error) {
      new Notice(`Streamient sync failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.refreshSettingsTab();
    }
  }

  private async resumeSync(): Promise<void> {
    if (!this.engine.connected() || this.engine.busy() || !navigator.onLine) return;
    try {
      await this.engine.flush();
      await this.engine.pull();
    } catch (error) {
      console.warn('Streamient background sync deferred', error);
    }
  }
}

class StreamientSettingTab extends PluginSettingTab {
  private readonly plugin: StreamientSyncPlugin;
  private syncDescription: HTMLElement | null = null;
  private syncButton: ButtonComponent | null = null;

  constructor(app: App, plugin: StreamientSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    return [{
      type: 'group',
      heading: 'Streamient server',
      items: [
        { name: 'Server URL', desc: 'Your hosted or self-hosted Streamient URL.', control: { type: 'text', key: 'serverUrl', validate: (value) => normalizeServerUrl(value) ? undefined : 'Enter a Streamient server URL.' } },
        {
          name: 'Account',
          desc: this.plugin.settings.authenticated ? 'Signed in' : 'Not signed in',
          render: (setting) => {
            setting.addButton((button) => button.setButtonText(this.plugin.settings.authenticated ? 'Reconnect' : 'Sign in').setCta().onClick(() => void this.plugin.startAuthorization()));
            setting.addButton((button) => button.setButtonText('Disconnect').setDisabled(!this.plugin.settings.authenticated).onClick(() => void this.plugin.disconnect()));
          },
        },
        {
          name: 'Project',
          desc: this.plugin.settings.projectName || (this.plugin.settings.authenticated ? 'Choose a project' : 'Sign in first'),
          render: (setting) => setting.addButton((button) => button.setButtonText('Choose project').setDisabled(!this.plugin.settings.authenticated).onClick(() => void this.plugin.chooseProject())),
        },
        { name: 'Streamient folder', desc: 'New Streamient Notes are created here. Memories use its Memories subfolder.', control: { type: 'text', key: 'streamientFolder' } },
        { name: 'Device name', desc: 'Shown in Streamient sync status and conflict history.', control: { type: 'text', key: 'deviceName' } },
        {
          name: 'Sync now',
          desc: '',
          render: (setting) => {
            this.syncDescription = setting.descEl;
            setting.addButton((button) => {
              this.syncButton = button;
              button.setButtonText('Sync').setCta().onClick(() => void this.plugin.syncNow());
            });
            this.updateSyncStatus();
          },
        },
        {
          name: 'Data handling',
          desc: 'Streamient receives readable vault content over TLS so it can index, preview, and edit it. Files are encrypted at rest by Streamient. The plugin includes no telemetry.',
          render: (setting) => setting.settingEl.addClass('streamient-disclosure'),
        },
      ],
    }];
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    if (typeof value !== 'string') return;
    if (key === 'serverUrl') this.plugin.settings.serverUrl = normalizeServerUrl(value);
    else if (key === 'streamientFolder') {
      this.plugin.settings.streamientFolder = value.trim() || 'Streamient';
      if (this.plugin.settings.connectionId) await this.plugin.api().updateConnection(this.plugin.settings.connectionId, { streamient_folder: this.plugin.settings.streamientFolder });
    } else if (key === 'deviceName') this.plugin.settings.deviceName = value.trim();
    else return;
    await this.plugin.saveSettings();
  }

  updateSyncStatus(): void {
    if (!this.syncDescription) return;
    this.syncDescription.empty();
    this.syncDescription.createDiv({ text: this.plugin.syncStatusText() });
    const progress = this.plugin.syncProgress;
    if (progress.active && progress.total > 0) {
      const bar = this.syncDescription.createEl('progress', { cls: 'streamient-sync-progress' });
      bar.max = progress.total;
      bar.value = Math.min(progress.current, progress.total);
    }
    if (progress.active && progress.path) this.syncDescription.createDiv({ cls: 'streamient-sync-path', text: progress.path });
    this.syncButton?.setDisabled(!this.plugin.settings.connectionId || progress.active);
  }
}
