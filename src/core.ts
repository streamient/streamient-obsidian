const EXCLUDED_NAMES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);
const DOCUMENT_EXTENSIONS = new Set(['pdf', 'doc', 'docx', 'txt', 'rtf', 'csv', 'tsv', 'json', 'yaml', 'yml', 'xml', 'html', 'htm']);
const IMAGE_EXTENSIONS = new Set(['bmp', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'avif', 'heic']);
const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'm4a', '3gp', 'flac', 'ogg', 'oga', 'opus']);
const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'ogv', 'mov', 'mkv']);

export const UPLOAD_CHUNK_SIZE = 20_000_000;
export const MANIFEST_BATCH_SIZE = 500;

export function normalizeServerUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

export function normalizeVaultPath(value: string): string {
  const raw = value.replace(/\\/g, '/').trim().replace(/^\.\//, '');
  if (!raw || raw.startsWith('/') || raw.includes('\0')) throw new Error('Vault path must be relative');
  const parts: string[] = [];
  for (const part of raw.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!parts.length) throw new Error('Vault path escapes the vault');
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  if (!parts.length) throw new Error('Vault path is required');
  return parts.join('/');
}

export function isExcludedVaultPath(value: string): boolean {
  const normalized = normalizeVaultPath(value);
  const parts = normalized.split('/');
  if (EXCLUDED_NAMES.has(parts.at(-1) || '')) return true;
  if (parts.some((part) => part.startsWith('.'))) return true;
  return /(?:^|\/)(?:~[^/]+|[^/]+\.tmp|[^/]+\.temp|[^/]+\.swp)$/.test(normalized);
}

export function vaultFileKind(value: string): string {
  const name = value.split('/').at(-1) || value;
  const extension = name.includes('.') ? name.split('.').at(-1)?.toLowerCase() || '' : '';
  if (extension === 'md') return 'markdown';
  if (extension === 'canvas') return 'canvas';
  if (extension === 'base') return 'base';
  if (IMAGE_EXTENSIONS.has(extension)) return 'image';
  if (AUDIO_EXTENSIONS.has(extension)) return 'audio';
  if (VIDEO_EXTENSIONS.has(extension)) return 'video';
  if (DOCUMENT_EXTENSIONS.has(extension)) return 'document';
  return 'other';
}

export function mimeTypeForPath(value: string): string {
  const extension = value.split('.').at(-1)?.toLowerCase() || '';
  const known: Record<string, string> = {
    md: 'text/markdown', canvas: 'application/json', base: 'text/yaml', txt: 'text/plain', json: 'application/json', yaml: 'text/yaml', yml: 'text/yaml',
    pdf: 'application/pdf', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp',
    mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
  };
  return known[extension] || 'application/octet-stream';
}

export async function sha256Hex(value: ArrayBuffer | Uint8Array | string): Promise<string> {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value instanceof Uint8Array ? value : new Uint8Array(value);
  const input = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const digest = await crypto.subtle.digest('SHA-256', input);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function uuid(): string {
  return crypto.randomUUID();
}

export function base64Url(value: ArrayBuffer): string {
  let binary = '';
  for (const byte of new Uint8Array(value)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function pkceChallenge(verifier: string): Promise<string> {
  return base64Url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
}

export function coalescePending<T extends { path: string; operation: string }>(items: T[], next: T): T[] {
  const filtered = items.filter((item) => item.path !== next.path);
  let prior: T | undefined;
  for (let index = items.length - 1; index >= 0; index--) {
    if (items[index].path === next.path) {
      prior = items[index];
      break;
    }
  }
  const rename = items.find((item) => item.path === next.path && item.operation === 'rename');
  if (rename && next.operation !== 'rename') {
    const withoutLaterChanges = items.filter((item) => item.path !== next.path || item.operation === 'rename');
    return [...withoutLaterChanges, next];
  }
  if (prior?.operation === 'create' && next.operation === 'trash') return filtered;
  if (next.operation === 'trash') return [...filtered, next];
  if (prior?.operation === 'create' && next.operation === 'update') return [...filtered, { ...next, operation: 'create' }];
  return [...filtered, next];
}

export function manifestBatches<T>(items: T[], size = MANIFEST_BATCH_SIZE): T[][] {
  if (!Number.isSafeInteger(size) || size < 1) throw new Error('Manifest batch size must be a positive integer');
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size) batches.push(items.slice(index, index + size));
  return batches;
}
