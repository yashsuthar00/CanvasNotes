import type { El } from './types';
import { t } from './i18n';

export type Op = { op: 'put'; el: El } | { op: 'del'; id: string };

async function json<T>(res: Response): Promise<T> {
  // The session expired or was signed out elsewhere: reload to show the sign-in page.
  if (res.status === 401) {
    location.reload();
    throw new Error(t('Sign in required'));
  }
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

export interface User {
  id: string;
  email: string;
  name: string;
}

// Browser-stored state that belongs to one account (viewports, recently viewed
// boards…) is keyed by user, so two people sharing a browser don't mix them.
let currentUserId = '';
export function userKey(key: string): string {
  return currentUserId ? `${key}:${currentUserId}` : key;
}

// Upload space: bytes in use and the account's limit.
export interface Storage {
  used: number;
  quota: number;
}

export async function fetchState(): Promise<{ elements: El[]; auth: boolean; user: User | null; storage: Storage | null }> {
  const data = await json<{ elements: El[]; auth?: boolean; user?: User; storage?: Storage }>(await fetch('/api/state'));
  currentUserId = data.user?.id ?? '';
  return { elements: data.elements, auth: !!data.auth, user: data.user ?? null, storage: data.storage ?? null };
}

export async function fetchPublic(token: string): Promise<{ board: string; elements: El[] }> {
  return json(await fetch(`/api/public/${encodeURIComponent(token)}`));
}

export async function postJson<T = { ok: boolean }>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error || `${res.status} ${res.statusText}`);
  return data as T;
}

export async function logout(): Promise<void> {
  await fetch('/api/logout', { method: 'POST' });
  location.reload();
}

export async function applyOps(ops: Op[]): Promise<void> {
  await json(await fetch('/api/ops', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ops }) }));
}

export interface Uploaded {
  url: string;
  name: string;
  size: number;
  mime: string;
}

export async function upload(file: File): Promise<Uploaded> {
  const res = await fetch(`/api/upload?name=${encodeURIComponent(file.name || 'pasted')}`, {
    method: 'POST',
    headers: { 'content-type': file.type || 'application/octet-stream' },
    body: file,
  });
  return json<Uploaded>(res);
}

export interface Unfurled {
  ok: boolean;
  url?: string;
  title?: string | null;
  description?: string | null;
  image?: string | null;
  site?: string | null;
}

export async function unfurl(url: string): Promise<Unfurled> {
  return json<Unfurled>(await fetch(`/api/unfurl?url=${encodeURIComponent(url)}`));
}

export async function importElements(elements: El[], mode: 'merge' | 'replace'): Promise<void> {
  await json(await fetch('/api/import', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ elements, mode }) }));
}
