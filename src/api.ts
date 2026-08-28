import { requestUrl } from 'obsidian';
import type { RequestUrlParam, RequestUrlResponse } from 'obsidian';

import { manifestBatches, normalizeServerUrl, sha256Hex, UPLOAD_CHUNK_SIZE, uuid } from './core';
import type { ConnectionSummary, ManifestEntry, MutationResult, ProjectSummary, SyncAction, SyncChange } from './types';

const CLIENT_ID = 'streamient-obsidian';
const REDIRECT_URI = 'obsidian://streamient-auth';
const MIN_REQUEST_INTERVAL_MS = 25;
const MAX_RATE_LIMIT_RETRIES = 6;

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope: string;
}

export class StreamientApiError extends Error {
  status: number;
  code: string;

  constructor(message: string, status: number, code = '') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function jsonBody(value: unknown): string {
  return JSON.stringify(value);
}

function responseError(response: { status: number; json?: unknown; text?: string }): StreamientApiError {
  const payload = response.json && typeof response.json === 'object' ? response.json as { error?: string; code?: string } : {};
  return new StreamientApiError(payload.error || response.text || `Streamient request failed (${response.status})`, response.status, payload.code || '');
}

export function authorizationUrl(serverUrl: string, state: string, challenge: string): string {
  const server = normalizeServerUrl(serverUrl);
  const url = new URL(`${server}/oauth/authorize`);
  url.searchParams.set('client_id', CLIENT_ID);
  url.searchParams.set('redirect_uri', REDIRECT_URI);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'vault:read vault:write');
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('resource', `${server}/api/v1`);
  return url.toString();
}

async function tokenRequest(serverUrl: string, values: Record<string, string>): Promise<TokenResponse> {
  const response = await requestUrl({
    url: `${normalizeServerUrl(serverUrl)}/oauth/token`,
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(values).toString(),
    throw: false,
  });
  if (response.status < 200 || response.status >= 300) throw responseError(response);
  return response.json as TokenResponse;
}

export function exchangeAuthorizationCode(serverUrl: string, code: string, verifier: string): Promise<TokenResponse> {
  return tokenRequest(serverUrl, { grant_type: 'authorization_code', client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, code, code_verifier: verifier });
}

export function refreshAccessToken(serverUrl: string, refreshToken: string): Promise<TokenResponse> {
  return tokenRequest(serverUrl, { grant_type: 'refresh_token', client_id: CLIENT_ID, refresh_token: refreshToken });
}

export class StreamientApi {
  serverUrl: string;
  private readonly accessToken: () => Promise<string>;
  private nextRequestAt = 0;

  constructor(serverUrl: string, accessToken: () => Promise<string>) {
    this.serverUrl = normalizeServerUrl(serverUrl);
    this.accessToken = accessToken;
  }

  private async pacedRequest(options: RequestUrlParam): Promise<RequestUrlResponse> {
    for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt++) {
      const wait = Math.max(0, this.nextRequestAt - Date.now());
      if (wait) await new Promise((resolve) => window.setTimeout(resolve, wait));
      this.nextRequestAt = Date.now() + MIN_REQUEST_INTERVAL_MS;
      const response = await requestUrl({ ...options, throw: false });
      if (response.status !== 429 || attempt === MAX_RATE_LIMIT_RETRIES) return response;
      const retryAfter = response.headers?.['retry-after'] || response.headers?.['Retry-After'] || '';
      const retryAfterSeconds = Number(retryAfter);
      const delay = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0 ? Math.min(retryAfterSeconds * 1000, 30_000) : Math.min(1000 * (2 ** attempt), 30_000);
      await new Promise((resolve) => window.setTimeout(resolve, delay));
    }
    throw new Error('Streamient rate-limit retry exhausted');
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.pacedRequest({
      url: `${this.serverUrl}/api/v1/obsidian${path}`,
      method,
      headers: { Authorization: `Bearer ${await this.accessToken()}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : jsonBody(body),
    });
    if (response.status < 200 || response.status >= 300) throw responseError(response);
    return response.json as T;
  }

  async projects(): Promise<ProjectSummary[]> {
    return (await this.request<{ projects: ProjectSummary[] }>('GET', '/projects')).projects;
  }

  async connections(projectId?: string): Promise<ConnectionSummary[]> {
    const query = projectId ? `?project_id=${encodeURIComponent(projectId)}` : '';
    return (await this.request<{ connections: ConnectionSummary[] }>('GET', `/connections${query}`)).connections;
  }

  async connect(data: Record<string, unknown>): Promise<ConnectionSummary> {
    return (await this.request<{ connection: ConnectionSummary }>('POST', '/connections', data)).connection;
  }

  async registerDevice(connectionId: string, data: Record<string, unknown>): Promise<ConnectionSummary> {
    return (await this.request<{ connection: ConnectionSummary }>('POST', `/connections/${connectionId}/devices`, data)).connection;
  }

  async updateConnection(connectionId: string, data: Record<string, unknown>): Promise<ConnectionSummary> {
    return (await this.request<{ connection: ConnectionSummary }>('PATCH', `/connections/${connectionId}`, data)).connection;
  }

  async manifest(connectionId: string, files: ManifestEntry[], device: Record<string, unknown>, preview = false): Promise<{ actions: SyncAction[]; cursor: number; connection: ConnectionSummary }> {
    const manifestId = uuid();
    const batches = manifestBatches(files);
    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
      await this.request('POST', `/connections/${connectionId}/manifest`, { manifest_id: manifestId, batch_index: batchIndex, files: batches[batchIndex], complete: false, ...device });
    }
    return this.request('POST', `/connections/${connectionId}/manifest`, { manifest_id: manifestId, batch_count: batches.length, complete: true, preview, ...device });
  }

  async mutations(connectionId: string, mutations: Record<string, unknown>[], device: Record<string, unknown>): Promise<{ results: MutationResult[]; cursor: number }> {
    return this.request('POST', `/connections/${connectionId}/mutations`, { mutations, ...device });
  }

  async changes(connectionId: string, after: number, deviceId: string): Promise<{ changes: SyncChange[]; cursor: number; has_more: boolean; sync_requested_at?: string | null }> {
    return this.request('GET', `/connections/${connectionId}/changes?after=${after}&limit=250&device_id=${encodeURIComponent(deviceId)}`);
  }

  async createUpload(connectionId: string, path: string, mimeType: string, content: ArrayBuffer): Promise<{ id: string; chunk_size: number }> {
    const sha256 = await sha256Hex(content);
    const result = await this.request<{ upload: { id: string; chunk_size: number } }>('POST', '/uploads', { connection_id: connectionId, path, mime_type: mimeType, total_bytes: content.byteLength, sha256 });
    return result.upload;
  }

  async upload(connectionId: string, path: string, mimeType: string, content: ArrayBuffer): Promise<string> {
    const session = await this.createUpload(connectionId, path, mimeType, content);
    const chunkSize = session.chunk_size || UPLOAD_CHUNK_SIZE;
    for (let offset = 0; offset < content.byteLength; offset += chunkSize) {
      const chunk = content.slice(offset, Math.min(offset + chunkSize, content.byteLength));
      const response = await this.pacedRequest({
        url: `${this.serverUrl}/api/v1/obsidian/uploads/${session.id}`,
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${await this.accessToken()}`,
          'Content-Type': 'application/offset+octet-stream',
          'Upload-Offset': String(offset),
          'Upload-Length': String(content.byteLength),
          'Upload-Checksum': `sha256 ${await sha256Hex(chunk)}`,
        },
        body: chunk,
      });
      if (response.status < 200 || response.status >= 300) throw responseError(response);
    }
    await this.request('POST', `/uploads/${session.id}/complete`);
    return session.id;
  }

  async download(fileId: string): Promise<ArrayBuffer> {
    const response = await this.pacedRequest({
      url: `${this.serverUrl}/api/v1/obsidian/files/${fileId}/content`,
      method: 'GET',
      headers: { Authorization: `Bearer ${await this.accessToken()}` },
    });
    if (response.status < 200 || response.status >= 300) throw responseError(response);
    return response.arrayBuffer;
  }
}
