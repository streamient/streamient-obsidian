import { App, FuzzySuggestModal, Modal, Notice, Platform, Plugin, PluginSettingTab, Setting, TAbstractFile, TFile, TFolder, type SettingDefinitionItem } from 'obsidian';

import { authorizationUrl, exchangeAuthorizationCode, refreshAccessToken, StreamientApi } from './api';
import { base64Url, isExcludedVaultPath, normalizeServerUrl, normalizeVaultPath, pkceChallenge, uuid } from './core';
import { accountKey, createProjectState, migrateSettings, ownerForPath, profileConfigurationError, retainOwnedOperations, uniqueProjectFolder } from './profiles';
import { SerializedSettingsWriter } from './persistence';
import { SyncEngine } from './sync';
import type { ProjectSummary, ProjectSyncProfile, ScopePathKind, StreamientSyncSettings, SyncAccount, SyncProgress, SyncScopePath, VaultScopeMode } from './types';

class AccountPicker extends FuzzySuggestModal<SyncAccount> {
  constructor(app: App, private readonly accounts: SyncAccount[], private readonly choose: (account: SyncAccount) => void) {
    super(app);
    this.setPlaceholder('Choose a Streamient account');
  }

  getItems(): SyncAccount[] {
    return this.accounts;
  }

  getItemText(account: SyncAccount): string {
    return `${account.accountName} — ${account.userEmail || account.userName}`;
  }

  onChooseItem(account: SyncAccount): void {
    this.choose(account);
  }
}

class ProjectPicker extends FuzzySuggestModal<ProjectSummary> {
  constructor(app: App, private readonly projects: ProjectSummary[], private readonly choose: (project: ProjectSummary) => void) {
    super(app);
    this.setPlaceholder('Add a Streamient project');
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

class VaultPathPicker extends FuzzySuggestModal<TAbstractFile> {
  private readonly items: TAbstractFile[];

  constructor(app: App, kind: ScopePathKind, private readonly choose: (path: SyncScopePath) => void) {
    super(app);
    this.items = app.vault.getAllLoadedFiles().filter((item) => kind === 'file' ? item instanceof TFile : item instanceof TFolder && Boolean(item.path)).filter((item) => {
      try {
        return !isExcludedVaultPath(item.path);
      } catch {
        return false;
      }
    });
    this.setPlaceholder(`Select a vault ${kind}`);
  }

  getItems(): TAbstractFile[] {
    return this.items;
  }

  getItemText(item: TAbstractFile): string {
    return item.path;
  }

  onChooseItem(item: TAbstractFile): void {
    this.choose({ path: item.path, kind: item instanceof TFile ? 'file' : 'folder' });
  }
}

class ConfirmModal extends Modal {
  private settled = false;

  constructor(app: App, private readonly title: string, private readonly message: string, private readonly done: (confirmed: boolean) => void) {
    super(app);
  }

  private finish(confirmed: boolean): void {
    if (this.settled) return;
    this.settled = true;
    this.done(confirmed);
    this.close();
  }

  onOpen(): void {
    this.titleEl.setText(this.title);
    this.contentEl.createEl('p', { text: this.message });
    new Setting(this.contentEl)
      .addButton((button) => button.setButtonText('Cancel').onClick(() => this.finish(false)))
      .addButton((button) => button.setButtonText('Remove').setDestructive().onClick(() => this.finish(true)));
  }

  onClose(): void {
    if (!this.settled) {
      this.settled = true;
      this.done(false);
    }
    this.contentEl.empty();
  }
}

export default class StreamientSyncPlugin extends Plugin {
  declare settings: StreamientSyncSettings;
  private readonly engines = new Map<string, SyncEngine>();
  private readonly progress = new Map<string, SyncProgress>();
  private readonly accessTokens = new Map<string, { value: string; expiresAt: number }>();
  private readonly apiClients = new Map<string, StreamientApi>();
  private statusBar: HTMLElement | null = null;
  private settingTab: StreamientSettingTab | null = null;
  private settingsWriter!: SerializedSettingsWriter;
  private saveTimer = 0;
  private backgroundTimer = 0;
  private coordinating = false;

  async onload(): Promise<void> {
    let savedSettings: unknown = null;
    try {
      savedSettings = await this.loadData();
    } catch (error) {
      console.warn('Streamient shared settings could not be read; recovering safe defaults', error);
    }
    const localSettings: unknown = this.app.loadLocalStorage(this.localStorageKey());
    this.settings = migrateSettings(savedSettings, localSettings, Platform.isMobile ? 'Obsidian mobile' : 'Obsidian desktop');
    this.settingsWriter = new SerializedSettingsWriter(() => this.writeSettings());
    await this.migrateLegacyCredential();
    const authorizedKeys = Object.keys(this.settings.accounts).filter((key) => Boolean(this.app.secretStorage.getSecret(this.secretName(key))));
    this.settings.authenticated = authorizedKeys.length > 0;
    if (!authorizedKeys.includes(this.settings.defaultAccountKey)) this.settings.defaultAccountKey = authorizedKeys[0] || '';
    await this.saveSettings();
    this.rebuildEngines();

    this.settingTab = new StreamientSettingTab(this.app, this);
    this.addSettingTab(this.settingTab);
    this.addRibbonIcon('refresh-cw', 'Sync all Streamient projects', () => void this.syncAll());
    if (!Platform.isMobile) this.statusBar = this.addStatusBarItem();
    this.refreshStatus();

    this.addCommand({ id: 'sync-all', name: 'Sync all projects', callback: () => void this.syncAll() });
    this.addCommand({ id: 'add-project', name: 'Add project', callback: () => void this.chooseProject() });
    this.addCommand({ id: 'abort-sync', name: 'Abort active sync', callback: () => void this.abortActiveSync() });
    this.addCommand({ id: 'connect', name: 'Connect account', callback: () => void this.startAuthorization() });

    this.registerObsidianProtocolHandler('streamient-auth', (parameters) => {
      void this.finishAuthorization(String(parameters.code || ''), String(parameters.state || ''), String(parameters.error || ''));
    });

    this.app.workspace.onLayoutReady(() => {
      this.registerEvent(this.app.vault.on('create', (file) => { if (file instanceof TFile) this.engineForPath(file.path)?.queueFile(file); }));
      this.registerEvent(this.app.vault.on('modify', (file) => { if (file instanceof TFile) this.engineForPath(file.path)?.queueFile(file); }));
      this.registerEvent(this.app.vault.on('rename', (file, oldPath) => { if (file instanceof TFile) void this.handleRename(file, oldPath); }));
      this.registerEvent(this.app.vault.on('delete', (file) => { if (file instanceof TFile) void this.engineForPath(file.path)?.handleDelete(file); }));
      void this.resumeSync();
    });

    this.registerInterval(window.setInterval(() => void this.resumeSync(), 30_000));
    this.registerDomEvent(window, 'online', () => void this.resumeSync());
    this.registerDomEvent(document, 'visibilitychange', () => { if (!document.hidden) void this.resumeSync(); });
  }

  onunload(): void {
    if (this.saveTimer) window.clearTimeout(this.saveTimer);
    if (this.backgroundTimer) window.clearTimeout(this.backgroundTimer);
  }

  private localStorageKey(): string {
    return `${this.manifest.id}-device-${this.app.vault.getName().toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  }

  private secretName(account: string): string {
    return `streamient-sync-${this.settings.deviceId}-${account}`;
  }

  private legacySecretName(): string {
    return `streamient-sync-${this.settings.deviceId}`;
  }

  private async setRefreshToken(account: string, value: string): Promise<void> {
    await Promise.resolve(this.app.secretStorage.setSecret(this.secretName(account), value));
  }

  private async migrateLegacyCredential(): Promise<void> {
    if (Object.keys(this.settings.accounts).length) return;
    const legacy = this.app.secretStorage.getSecret(this.legacySecretName());
    if (!legacy) return;
    try {
      const tokens = await refreshAccessToken(this.settings.serverUrl, legacy);
      await Promise.resolve(this.app.secretStorage.setSecret(this.legacySecretName(), tokens.refresh_token));
      const identity = await new StreamientApi(this.settings.serverUrl, async () => tokens.access_token).account();
      const key = accountKey(identity.id, identity.user.id);
      this.settings.accounts[key] = { key, accountId: identity.id, accountName: identity.name, userId: identity.user.id, userName: identity.user.name, userEmail: identity.user.email, serverUrl: this.settings.serverUrl };
      this.settings.defaultAccountKey = key;
      for (const profile of this.settings.profiles) if (!profile.accountKey) profile.accountKey = key;
      await this.setRefreshToken(key, tokens.refresh_token);
      await Promise.resolve(this.app.secretStorage.setSecret(this.legacySecretName(), ''));
      this.accessTokens.set(key, { value: tokens.access_token, expiresAt: Date.now() + tokens.expires_in * 1000 });
    } catch (error) {
      console.warn('Streamient legacy account authorization requires sign-in', error);
    }
  }

  private async writeSettings(): Promise<void> {
    const shared = { schemaVersion: 2, serverUrl: this.settings.serverUrl, profiles: this.settings.profiles };
    const local = { authenticated: this.settings.authenticated, defaultAccountKey: this.settings.defaultAccountKey, accounts: this.settings.accounts, deviceId: this.settings.deviceId, deviceName: this.settings.deviceName, pendingOauthState: this.settings.pendingOauthState, pendingOauthVerifier: this.settings.pendingOauthVerifier, pendingOauthMode: this.settings.pendingOauthMode, pendingOauthProfileId: this.settings.pendingOauthProfileId, profileStates: this.settings.profileStates };
    await this.saveData(shared);
    this.app.saveLocalStorage(this.localStorageKey(), local);
    this.refreshStatus();
  }

  async saveSettings(): Promise<void> {
    await this.settingsWriter.save();
  }

  requestSettingsSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = 0;
      void this.saveSettings().catch((error) => console.error('Streamient settings save failed', error));
    }, 250);
  }

  private rebuildEngines(): void {
    this.engines.clear();
    this.progress.clear();
    for (const profile of this.settings.profiles) {
      const state = this.settings.profileStates[profile.id] ||= createProjectState();
      this.engines.set(profile.id, new SyncEngine({
        app: this.app,
        api: () => this.api(profile.accountKey),
        profile,
        state,
        settings: this.settings,
        profiles: () => this.settings.profiles,
        saveSettings: () => this.saveSettings(),
        requestSave: () => this.requestSettingsSave(),
        onProgress: (progress) => this.updateSyncProgress(progress),
        onWorkQueued: () => this.scheduleBackground(),
      }));
    }
  }

  private refreshSettingsTab(): void {
    this.settingTab?.refresh();
  }

  private updateSyncProgress(progress: SyncProgress): void {
    const previous = this.progress.get(progress.profileId);
    this.progress.set(progress.profileId, progress);
    this.refreshStatus();
    if (previous?.active !== progress.active || previous?.phase === 'stopping' !== (progress.phase === 'stopping')) this.refreshSettingsTab();
    else this.settingTab?.updateSyncStatus(progress.profileId);
  }

  progressFor(profileId: string): SyncProgress | null {
    return this.progress.get(profileId) || this.engines.get(profileId)?.progress() || null;
  }

  private activeEngine(): SyncEngine | null {
    return [...this.engines.values()].find((engine) => engine.busy()) || null;
  }

  private refreshStatus(): void {
    if (!this.statusBar) return;
    if (!this.settings.authenticated) {
      this.statusBar.setText('Streamient: signed out');
      return;
    }
    const active = [...this.progress.values()].find((progress) => progress.active);
    if (active) {
      this.statusBar.setText(`Streamient: ${active.projectName} · ${this.syncStatusText(active.profileId)}`);
      return;
    }
    const pending = Object.values(this.settings.profileStates).reduce((total, state) => total + state.pendingOperations.length, 0);
    const paused = Object.values(this.settings.profileStates).filter((state) => state.paused).length;
    this.statusBar.setText(`Streamient: ${this.settings.profiles.length} projects · ${pending} pending${paused ? ` · ${paused} paused` : ''}`);
  }

  syncStatusText(profileId: string): string {
    const progress = this.progressFor(profileId);
    const state = this.settings.profileStates[profileId];
    if (!progress || !state) return 'Not configured';
    const labels: Record<SyncProgress['phase'], string> = { idle: 'Idle', scanning: 'Scanning vault', reconciling: 'Reconciling manifest', preview: 'Waiting for confirmation', applying: 'Applying changes', uploading: 'Uploading content', trashing: 'Moving items to trash', renaming: 'Renaming items', pulling: 'Pulling changes', stopping: 'Stopping sync', paused: 'Paused', complete: 'Sync complete', failed: 'Sync failed' };
    if (progress.phase === 'failed') return progress.error ? `Failed: ${progress.error}` : 'Failed';
    if (progress.active) return progress.total > 0 ? `${labels[progress.phase]} ${Math.min(progress.current, progress.total)}/${progress.total}` : labels[progress.phase];
    if (state.needsReview) return 'Review required';
    if (state.paused) return 'Paused';
    if (state.lastSyncError) return `Last sync failed: ${state.lastSyncError}`;
    return state.lastSyncAt ? `Last completed ${new Date(state.lastSyncAt).toLocaleString()}` : 'Ready';
  }

  private hasAccountCredential(key: string): boolean {
    return Boolean(key && this.settings.accounts[key] && this.app.secretStorage.getSecret(this.secretName(key)));
  }

  private async token(key: string): Promise<string> {
    const cached = this.accessTokens.get(key);
    if (cached && cached.expiresAt > Date.now() + 15_000) return cached.value;
    const account = this.settings.accounts[key];
    const stored = this.app.secretStorage.getSecret(this.secretName(key));
    if (!account || !stored) throw new Error('Sign in to the Streamient account for this project');
    const tokens = await refreshAccessToken(account.serverUrl, stored);
    this.accessTokens.set(key, { value: tokens.access_token, expiresAt: Date.now() + tokens.expires_in * 1000 });
    await this.setRefreshToken(key, tokens.refresh_token);
    return tokens.access_token;
  }

  api(key: string): StreamientApi {
    const account = this.settings.accounts[key];
    if (!account) throw new Error('Sign in to the Streamient account for this project');
    const existing = this.apiClients.get(key);
    if (existing?.serverUrl === account.serverUrl) return existing;
    const client = new StreamientApi(account.serverUrl, () => this.token(key));
    this.apiClients.set(key, client);
    return client;
  }

  async startAuthorization(mode: 'default' | 'additional' | 'profile' = 'default', profileId = ''): Promise<void> {
    try {
      this.settings.serverUrl = normalizeServerUrl(this.settings.serverUrl);
      const verifier = base64Url(crypto.getRandomValues(new Uint8Array(48)).buffer);
      this.settings.pendingOauthVerifier = verifier;
      this.settings.pendingOauthState = uuid();
      this.settings.pendingOauthMode = mode;
      this.settings.pendingOauthProfileId = profileId;
      await this.saveSettings();
      const forceLogin = mode !== 'default' || Boolean(this.settings.defaultAccountKey);
      window.open(authorizationUrl(this.settings.serverUrl, this.settings.pendingOauthState, await pkceChallenge(verifier), forceLogin), '_blank');
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
      const identityClient = new StreamientApi(this.settings.serverUrl, async () => tokens.access_token);
      const identity = await identityClient.account();
      const key = accountKey(identity.id, identity.user.id);
      this.settings.accounts[key] = { key, accountId: identity.id, accountName: identity.name, userId: identity.user.id, userName: identity.user.name, userEmail: identity.user.email, serverUrl: this.settings.serverUrl };
      await this.setRefreshToken(key, tokens.refresh_token);
      this.accessTokens.set(key, { value: tokens.access_token, expiresAt: Date.now() + tokens.expires_in * 1000 });
      this.settings.authenticated = true;
      if (!this.settings.defaultAccountKey || this.settings.pendingOauthMode === 'default') this.settings.defaultAccountKey = key;
      for (const profile of this.settings.profiles) if (!profile.accountKey) profile.accountKey = key;
      const mode = this.settings.pendingOauthMode;
      const profileId = this.settings.pendingOauthProfileId;
      this.settings.pendingOauthState = '';
      this.settings.pendingOauthVerifier = '';
      this.settings.pendingOauthMode = 'default';
      this.settings.pendingOauthProfileId = '';
      await this.saveSettings();
      this.rebuildEngines();
      this.refreshSettingsTab();
      new Notice(`Connected to ${identity.name} as ${identity.user.email}`);
      if (mode === 'profile') {
        const profile = this.settings.profiles.find((item) => item.id === profileId);
        if (profile && profile.accountKey !== key) new Notice(`This project belongs to ${this.settings.accounts[profile.accountKey]?.accountName || 'another account'}`);
      } else if (mode === 'additional' || !this.settings.profiles.length) await this.chooseProject(key);
    } catch (error) {
      new Notice(`Streamient authorization failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  addAccount(): void {
    void this.startAuthorization('additional');
  }

  reconnectProfileAccount(profileId: string): void {
    void this.startAuthorization('profile', profileId);
  }

  async chooseProject(selectedAccountKey = ''): Promise<void> {
    if (!this.settings.authenticated) {
      new Notice('Sign in to Streamient first');
      return;
    }
    try {
      const accounts = Object.values(this.settings.accounts).filter((account) => this.hasAccountCredential(account.key));
      if (!selectedAccountKey && accounts.length > 1) {
        new AccountPicker(this.app, accounts, (account) => void this.chooseProject(account.key)).open();
        return;
      }
      const key = selectedAccountKey || this.settings.defaultAccountKey || accounts[0]?.key || '';
      if (!this.hasAccountCredential(key)) throw new Error('Sign in to an account before adding its project');
      const configured = new Set(this.settings.profiles.filter((profile) => profile.accountKey === key).map((profile) => profile.projectId));
      const projects = (await this.api(key).projects()).filter((project) => !configured.has(project._id));
      if (!projects.length) {
        new Notice('All projects from this account are already configured');
        return;
      }
      new ProjectPicker(this.app, projects, (project) => void this.connectProject(project, key)).open();
    } catch (error) {
      new Notice(`Could not list Streamient projects: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async connectProject(project: ProjectSummary, key: string): Promise<void> {
    if (this.settings.profiles.some((profile) => profile.accountKey === key && profile.projectId === project._id)) return;
    try {
      const connection = await this.api(key).connect({ project_id: project._id, name: this.app.vault.getName(), streamient_folder: uniqueProjectFolder(project.name, this.settings.profiles), device_id: this.settings.deviceId, device_name: this.settings.deviceName, platform: Platform.isMobile ? 'mobile' : 'desktop' });
      if (!connection.enabled) await this.api(key).updateConnection(connection.id, { enabled: true });
      const profile: ProjectSyncProfile = { id: uuid(), accountKey: key, projectId: project._id, projectName: project.name, connectionId: connection.id, streamientFolder: connection.streamient_folder, vaultMode: 'off', selectedPaths: [] };
      const error = profileConfigurationError(this.settings.profiles, profile);
      if (error) throw new Error(error);
      this.settings.profiles.push(profile);
      this.settings.profileStates[profile.id] = createProjectState();
      await this.saveSettings();
      this.rebuildEngines();
      this.refreshSettingsTab();
      new Notice(`${project.name} added. Review its first sync before starting.`);
    } catch (error) {
      new Notice(`Could not add Streamient project: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async disconnect(): Promise<void> {
    for (const engine of this.engines.values()) await engine.abort();
    for (const key of Object.keys(this.settings.accounts)) await this.setRefreshToken(key, '');
    this.accessTokens.clear();
    this.apiClients.clear();
    this.settings.authenticated = false;
    await this.saveSettings();
    this.refreshSettingsTab();
    new Notice('Signed out. Project profiles and synchronized knowledge remain.');
  }

  private engineForPath(path: string): SyncEngine | null {
    const profile = ownerForPath(this.settings.profiles, path);
    return profile ? this.engines.get(profile.id) || null : null;
  }

  private async handleRename(file: TFile, oldPath: string): Promise<void> {
    const oldEngine = this.engineForPath(oldPath);
    const newEngine = this.engineForPath(file.path);
    if (oldEngine && oldEngine === newEngine) await oldEngine.handleRename(file, oldPath);
    else {
      oldEngine?.handleScopeExit(oldPath);
      newEngine?.queueFile(file);
    }
  }

  private scheduleBackground(): void {
    if (this.backgroundTimer) return;
    this.backgroundTimer = window.setTimeout(() => {
      this.backgroundTimer = 0;
      void this.resumeSync();
    }, 250);
  }

  private async resumeSync(): Promise<void> {
    if (this.coordinating || !this.settings.authenticated || !navigator.onLine) return;
    this.coordinating = true;
    try {
      for (const profile of this.settings.profiles) {
        const state = this.settings.profileStates[profile.id];
        const engine = this.engines.get(profile.id);
        if (!this.hasAccountCredential(profile.accountKey)) continue;
        if (!engine || state.paused || state.needsReview) continue;
        await engine.flush();
        await engine.pull();
      }
    } catch (error) {
      console.warn('Streamient background sync deferred', error);
    } finally {
      this.coordinating = false;
      this.refreshSettingsTab();
    }
  }

  async syncProject(profileId: string): Promise<void> {
    if (this.coordinating) {
      new Notice('Another Streamient project is currently syncing');
      return;
    }
    const engine = this.engines.get(profileId);
    const state = this.settings.profileStates[profileId];
    const profile = this.settings.profiles.find((item) => item.id === profileId);
    if (!engine || !state || !this.settings.authenticated) return;
    if (!profile || !this.hasAccountCredential(profile.accountKey)) {
      new Notice('Sign in to the Streamient account for this project');
      return;
    }
    this.coordinating = true;
    try {
      if (state.paused) await engine.resume();
      await engine.fullSync(state.needsReview);
    } catch (error) {
      new Notice(`Streamient sync failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.coordinating = false;
      this.refreshSettingsTab();
    }
  }

  async syncAll(): Promise<void> {
    if (this.coordinating || !this.settings.authenticated) return;
    this.coordinating = true;
    let skipped = 0;
    try {
      for (const profile of this.settings.profiles) {
        const state = this.settings.profileStates[profile.id];
        const engine = this.engines.get(profile.id);
        if (!engine || state.paused || state.needsReview || !this.hasAccountCredential(profile.accountKey)) {
          skipped++;
          continue;
        }
        await engine.fullSync();
      }
      if (skipped) new Notice(`${skipped} project${skipped === 1 ? '' : 's'} skipped because review or resume is required`);
    } catch (error) {
      new Notice(`Streamient sync failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.coordinating = false;
      this.refreshSettingsTab();
    }
  }

  async abortProject(profileId: string): Promise<void> {
    await this.engines.get(profileId)?.abort();
    this.refreshSettingsTab();
  }

  private async abortActiveSync(): Promise<void> {
    const engine = this.activeEngine();
    if (engine) await engine.abort();
    else new Notice('No Streamient sync is active');
  }

  private profileWith(profileId: string, changes: Partial<ProjectSyncProfile>): ProjectSyncProfile | null {
    const profile = this.settings.profiles.find((item) => item.id === profileId);
    return profile ? { ...profile, ...changes } : null;
  }

  private async saveProfile(candidate: ProjectSyncProfile, updateConnection = false): Promise<void> {
    if (this.activeEngine()) throw new Error('Wait for the active sync to finish or abort it first.');
    const error = profileConfigurationError(this.settings.profiles, candidate);
    if (error) throw new Error(error);
    if (updateConnection) {
      const connection = await this.api(candidate.accountKey).updateConnection(candidate.connectionId, { streamient_folder: candidate.streamientFolder });
      candidate.streamientFolder = connection.streamient_folder;
    }
    const index = this.settings.profiles.findIndex((profile) => profile.id === candidate.id);
    this.settings.profiles[index] = candidate;
    const state = this.settings.profileStates[candidate.id];
    state.pendingOperations = retainOwnedOperations(state.pendingOperations, candidate, this.settings.profiles);
    state.needsReview = true;
    await this.saveSettings();
    this.rebuildEngines();
    this.refreshSettingsTab();
  }

  async updateProfileFolder(profileId: string, value: string): Promise<void> {
    try {
      const streamientFolder = normalizeVaultPath(value);
      if (isExcludedVaultPath(streamientFolder)) throw new Error('Project folder cannot be hidden or excluded.');
      const candidate = this.profileWith(profileId, { streamientFolder });
      if (candidate) await this.saveProfile(candidate, true);
    } catch (error) {
      new Notice(`Could not update project folder: ${error instanceof Error ? error.message : String(error)}`);
      this.refreshSettingsTab();
    }
  }

  async updateVaultMode(profileId: string, vaultMode: VaultScopeMode): Promise<void> {
    try {
      const candidate = this.profileWith(profileId, { vaultMode });
      if (candidate) await this.saveProfile(candidate);
    } catch (error) {
      new Notice(`Could not update vault scope: ${error instanceof Error ? error.message : String(error)}`);
      this.refreshSettingsTab();
    }
  }

  chooseScopePath(profileId: string, kind: ScopePathKind): void {
    new VaultPathPicker(this.app, kind, (path) => void this.addScopePath(profileId, path)).open();
  }

  private async addScopePath(profileId: string, path: SyncScopePath): Promise<void> {
    try {
      const profile = this.settings.profiles.find((item) => item.id === profileId);
      if (!profile || profile.selectedPaths.some((item) => item.path === path.path && item.kind === path.kind)) return;
      const candidate = this.profileWith(profileId, { selectedPaths: [...profile.selectedPaths, path] });
      if (candidate) await this.saveProfile(candidate);
    } catch (error) {
      new Notice(`Could not add vault content: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async removeScopePath(profileId: string, path: SyncScopePath): Promise<void> {
    try {
      const profile = this.settings.profiles.find((item) => item.id === profileId);
      const candidate = profile ? this.profileWith(profileId, { selectedPaths: profile.selectedPaths.filter((item) => item.path !== path.path || item.kind !== path.kind) }) : null;
      if (candidate) await this.saveProfile(candidate);
    } catch (error) {
      new Notice(`Could not remove vault content: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  removeProject(profileId: string): void {
    const profile = this.settings.profiles.find((item) => item.id === profileId);
    if (!profile) return;
    new ConfirmModal(this.app, `Remove ${profile.projectName}?`, 'Synchronization stops in this vault. Local files and Streamient content are retained.', (confirmed) => {
      if (!confirmed) return;
      void this.finishRemoveProject(profileId);
    }).open();
  }

  private async finishRemoveProject(profileId: string): Promise<void> {
    if (this.engines.get(profileId)?.busy()) return;
    this.settings.profiles = this.settings.profiles.filter((profile) => profile.id !== profileId);
    delete this.settings.profileStates[profileId];
    this.progress.delete(profileId);
    await this.saveSettings();
    this.rebuildEngines();
    this.refreshSettingsTab();
  }
}

class StreamientSettingTab extends PluginSettingTab {
  private readonly statusElements = new Map<string, HTMLElement>();

  constructor(app: App, private readonly plugin: StreamientSyncPlugin) {
    super(app, plugin);
  }

  refresh(): void {
    this.statusElements.clear();
    this.update();
  }

  getControlValue(key: string): unknown {
    if (key === 'serverUrl') return this.plugin.settings.serverUrl;
    if (key === 'deviceName') return this.plugin.settings.deviceName;
    const [field, profileId] = key.split(':');
    const profile = this.plugin.settings.profiles.find((item) => item.id === profileId);
    if (field === 'folder') return profile?.streamientFolder;
    if (field === 'mode') return profile?.vaultMode;
    return undefined;
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    if (key === 'serverUrl' && typeof value === 'string') {
      if (this.plugin.settings.profiles.length) {
        new Notice('Remove project profiles before changing the Streamient server');
        this.refresh();
        return;
      }
      this.plugin.settings.serverUrl = normalizeServerUrl(value);
      await this.plugin.saveSettings();
      return;
    }
    if (key === 'deviceName' && typeof value === 'string') {
      this.plugin.settings.deviceName = value.trim();
      await this.plugin.saveSettings();
      return;
    }
    const [field, profileId] = key.split(':');
    if (!profileId || typeof value !== 'string') return;
    if (field === 'folder') await this.plugin.updateProfileFolder(profileId, value);
    if (field === 'mode' && ['off', 'selected', 'all'].includes(value)) await this.plugin.updateVaultMode(profileId, value as VaultScopeMode);
  }

  private projectDefinitions(profile: ProjectSyncProfile): SettingDefinitionItem {
    const state = this.plugin.settings.profileStates[profile.id];
    const account = this.plugin.settings.accounts[profile.accountKey];
    return {
      type: 'group',
      heading: profile.projectName,
      cls: 'streamient-project-profile',
      items: [
        {
          name: 'Account',
          desc: account ? `${account.accountName} — ${account.userEmail || account.userName}` : 'Sign in to this account on this device',
          render: (setting) => setting.addButton((button) => button.setButtonText(account ? 'Reconnect' : 'Sign in').onClick(() => this.plugin.reconnectProfileAccount(profile.id))),
        },
        { name: 'Project folder', desc: 'Streamient project content always synchronizes both ways here.', control: { type: 'text', key: `folder:${profile.id}`, validate: (value) => {
          try {
            return isExcludedVaultPath(normalizeVaultPath(value)) ? 'Choose a visible vault folder.' : undefined;
          } catch (error) {
            return error instanceof Error ? error.message : String(error);
          }
        } } },
        { name: 'Extra vault content', desc: 'Optionally synchronize content outside the managed project folder.', control: { type: 'dropdown', key: `mode:${profile.id}`, options: { off: 'Off', selected: 'Selected folders and files', all: 'Entire unassigned vault' } } },
        {
          name: 'Selected content',
          desc: profile.selectedPaths.length ? `${profile.selectedPaths.length} selected` : 'No additional vault content selected',
          visible: () => profile.vaultMode === 'selected',
          render: (setting) => {
            const list = setting.descEl.createDiv({ cls: 'streamient-scope-list' });
            for (const path of profile.selectedPaths) {
              const row = list.createDiv({ cls: 'streamient-scope-path' });
              row.createSpan({ text: `${path.kind}: ${path.path}` });
              row.createEl('button', { text: 'Remove', cls: 'mod-muted' }).addEventListener('click', () => void this.plugin.removeScopePath(profile.id, path));
            }
            setting.addButton((button) => button.setButtonText('Add folder').onClick(() => this.plugin.chooseScopePath(profile.id, 'folder')));
            setting.addButton((button) => button.setButtonText('Add file').onClick(() => this.plugin.chooseScopePath(profile.id, 'file')));
          },
        },
        {
          name: 'Status',
          desc: '',
          render: (setting) => {
            this.statusElements.set(profile.id, setting.descEl);
            this.updateSyncStatus(profile.id);
            const progress = this.plugin.progressFor(profile.id);
            if (progress?.active) setting.addButton((button) => button.setButtonText('Abort').setDestructive().onClick(() => void this.plugin.abortProject(profile.id)));
            else setting.addButton((button) => button.setButtonText(state.needsReview ? 'Review' : state.paused ? 'Resume' : 'Sync').setCta().onClick(() => void this.plugin.syncProject(profile.id)));
            setting.addButton((button) => button.setButtonText('Remove').onClick(() => this.plugin.removeProject(profile.id)));
          },
        },
      ],
    };
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      {
        type: 'group',
        heading: 'Streamient server',
        items: [
          { name: 'Server URL', desc: 'One Streamient account and server per vault.', control: { type: 'text', key: 'serverUrl', disabled: () => this.plugin.settings.profiles.length > 0, validate: (value) => normalizeServerUrl(value) ? undefined : 'Enter a Streamient server URL.' } },
          {
            name: 'Default account',
            desc: this.plugin.settings.defaultAccountKey && this.plugin.settings.accounts[this.plugin.settings.defaultAccountKey] ? `${this.plugin.settings.accounts[this.plugin.settings.defaultAccountKey].accountName} — ${this.plugin.settings.accounts[this.plugin.settings.defaultAccountKey].userEmail || this.plugin.settings.accounts[this.plugin.settings.defaultAccountKey].userName}` : 'Not signed in',
            render: (setting) => {
              setting.addButton((button) => button.setButtonText(this.plugin.settings.authenticated ? 'Reconnect' : 'Sign in').setCta().onClick(() => void this.plugin.startAuthorization()));
              setting.addButton((button) => button.setButtonText('Add account').setDisabled(!this.plugin.settings.authenticated).onClick(() => this.plugin.addAccount()));
              setting.addButton((button) => button.setButtonText('Sign out').setDisabled(!this.plugin.settings.authenticated).onClick(() => void this.plugin.disconnect()));
            },
          },
          { name: 'Device name', desc: 'Shown in sync status and conflict history.', control: { type: 'text', key: 'deviceName' } },
        ],
      },
      {
        type: 'group',
        heading: 'Projects',
        items: [
          {
            name: 'Project sync profiles',
            desc: this.plugin.settings.profiles.length ? `${this.plugin.settings.profiles.length} configured` : 'No projects configured',
            render: (setting) => {
              setting.addButton((button) => button.setButtonText('Add project').setCta().setDisabled(!this.plugin.settings.authenticated).onClick(() => void this.plugin.chooseProject()));
              setting.addButton((button) => button.setButtonText('Sync all').setDisabled(!this.plugin.settings.authenticated || !this.plugin.settings.profiles.length).onClick(() => void this.plugin.syncAll()));
            },
          },
        ],
      },
      ...this.plugin.settings.profiles.map((profile) => this.projectDefinitions(profile)),
      {
        type: 'group',
        heading: 'Data handling',
        items: [{ name: 'Privacy', desc: 'Streamient receives readable selected vault content over TLS for indexing, preview, and editing. Files are encrypted at rest. The plugin includes no telemetry.' }],
      },
    ];
  }

  updateSyncStatus(projectId: string): void {
    const element = this.statusElements.get(projectId);
    if (!element) return;
    element.empty();
    element.createDiv({ text: this.plugin.syncStatusText(projectId) });
    const progress = this.plugin.progressFor(projectId);
    if (progress?.active && progress.total > 0) {
      const bar = element.createEl('progress', { cls: 'streamient-sync-progress' });
      bar.max = progress.total;
      bar.value = Math.min(progress.current, progress.total);
    }
    if (progress?.active && progress.path) element.createDiv({ cls: 'streamient-sync-path', text: progress.path });
  }
}
