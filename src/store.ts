import { useSyncExternalStore } from 'react';
import * as api from './api';
import { t } from './i18n';
import { DEFAULT_WIDTH, ROOT_ID, type El, type ElementOf, type ElementType, type ContentByType } from './types';

export type SaveStatus = 'saved' | 'saving' | 'error';
export type Panel = null | 'search' | 'trash' | 'shortcuts' | 'inbox' | 'quick' | 'export' | 'templates' | 'settings';
export type Modal =
  | { kind: 'draw'; id: string }
  | { kind: 'document'; id: string }
  | { kind: 'labels'; ids: string[] }
  | { kind: 'icon'; id: string }
  | { kind: 'boardLink'; onPick: (boardId: string, title: string) => void }
  | { kind: 'crop'; id: string }
  | { kind: 'fileInfo'; id: string }
  | { kind: 'imageSearch'; at?: { x: number; y: number; columnId?: string | null; index?: number } }
  | { kind: 'aiIdeas'; at?: { x: number; y: number } }
  | { kind: 'boardPassword'; id: string; mode: 'set' | 'unlock' | 'remove' }
  | { kind: 'account' };
export type Theme = 'system' | 'light' | 'dark';

export interface State {
  elements: Record<string, El>;
  loaded: boolean;
  loadError: string | null;
  boardId: string;
  selection: string[];
  editingId: string | null;
  saveStatus: SaveStatus;
  tool: 'line' | null;
  // Move mode (the hand): dragging anywhere only moves the view; cards can't be changed.
  hand: boolean;
  panel: Panel;
  theme: Theme;
  canUndo: boolean;
  canRedo: boolean;
  // Asks the canvas to centre on an element once (e.g. from search).
  focusRequest: { id: string; nonce: number } | null;
  toast: { text: string; nonce: number } | null;
  modal: Modal | null;
  captionEditId: string | null;
  presenting: boolean;
  authEnabled: boolean;
  user: api.User | null;
  storage: api.Storage | null;
  // Viewing a published board: nothing can be changed or saved.
  readOnly: boolean;
  publicRoot: string | null;
}

type Patch = Partial<Omit<El, 'content'>> & { content?: Partial<El['content']> };

interface HistoryEntry {
  before: Record<string, El | null>;
  after: Record<string, El | null>;
  key?: string;
  at: number;
}

function readTheme(): Theme {
  try {
    const t = localStorage.getItem('cn:theme');
    if (t === 'light' || t === 'dark' || t === 'system') return t;
  } catch {}
  return 'system';
}

function readHand(): boolean {
  try {
    return localStorage.getItem('cn:hand') === '1';
  } catch {
    return false;
  }
}

function boardFromHash(): string {
  const m = location.hash.match(/^#\/b\/([\w-]+)/);
  return m ? m[1] : ROOT_ID;
}

let state: State = {
  elements: {},
  loaded: false,
  loadError: null,
  boardId: boardFromHash(),
  selection: [],
  editingId: null,
  saveStatus: 'saved',
  tool: null,
  hand: readHand(),
  panel: null,
  theme: readTheme(),
  canUndo: false,
  canRedo: false,
  focusRequest: null,
  toast: null,
  modal: null,
  captionEditId: null,
  presenting: false,
  authEnabled: false,
  user: null,
  storage: null,
  readOnly: false,
  publicRoot: null,
};

const listeners = new Set<() => void>();

export function getState(): State {
  return state;
}

export function setState(partial: Partial<State>) {
  state = { ...state, ...partial };
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const subscribeState = subscribe;

export function useStore<T>(selector: (s: State) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state));
}

export function useElement(id: string | null | undefined): El | undefined {
  return useStore((s) => (id ? s.elements[id] : undefined));
}

// ---------------------------------------------------------------- ids & time

export function uid(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return Array.from(bytes, (b) => (b % 36).toString(36)).join('');
}

// ---------------------------------------------------------------- sync

const dirty = new Map<string, 'put' | 'del'>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushing = false;

function scheduleFlush(delay = 500) {
  if (state.readOnly) return;
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(flush, delay);
  if (state.saveStatus !== 'saving') setState({ saveStatus: 'saving' });
}

function pendingOps(): api.Op[] {
  return [...dirty].map(([id, kind]) =>
    kind === 'del' || !state.elements[id] ? { op: 'del', id } : { op: 'put', el: state.elements[id] },
  );
}

async function flush() {
  flushTimer = null;
  if (flushing) return scheduleFlush(300);
  if (dirty.size === 0) return setState({ saveStatus: 'saved' });
  const ops = pendingOps();
  const sent = new Map(dirty);
  dirty.clear();
  flushing = true;
  try {
    await api.applyOps(ops);
    setState({ saveStatus: dirty.size ? 'saving' : 'saved' });
  } catch {
    // Put back whatever was not superseded by newer edits, then retry.
    for (const [id, kind] of sent) if (!dirty.has(id)) dirty.set(id, kind);
    setState({ saveStatus: 'error' });
    flushTimer = setTimeout(flush, 3000);
  } finally {
    flushing = false;
  }
  if (dirty.size && !flushTimer) scheduleFlush(300);
}

window.addEventListener('beforeunload', (e) => {
  if (dirty.size === 0) return;
  const ok = navigator.sendBeacon('/api/ops', new Blob([JSON.stringify({ ops: pendingOps() })], { type: 'application/json' }));
  if (ok) dirty.clear();
  else e.preventDefault();
});

export async function load() {
  try {
    const { elements, auth, user, storage } = await api.fetchState();
    const map: Record<string, El> = {};
    for (const el of elements) map[el.id] = el;
    setState({ elements: map, loaded: true, loadError: null, authEnabled: auth, user, storage });
    if (state.boardId !== ROOT_ID && !map[state.boardId]) navigate(ROOT_ID);
  } catch (err) {
    setState({ loadError: err instanceof Error ? err.message : String(err) });
  }
}

// A published board opened through its read-only link (/p/<token>).
export async function loadPublic(token: string) {
  try {
    const { board, elements } = await api.fetchPublic(token);
    const map: Record<string, El> = {};
    for (const el of elements) map[el.id] = el;
    const fromHash = boardFromHash();
    setState({
      elements: map,
      loaded: true,
      loadError: null,
      readOnly: true,
      publicRoot: board,
      boardId: map[fromHash] ? fromHash : board,
    });
  } catch (err) {
    setState({ loadError: err instanceof Error ? err.message : String(err) });
  }
}

// ---------------------------------------------------------------- mutations & history

const undoStack: HistoryEntry[] = [];
const redoStack: HistoryEntry[] = [];
const COALESCE_MS = 1500;

function writeElements(changes: Record<string, El | null>) {
  const next = { ...state.elements };
  for (const [id, el] of Object.entries(changes)) {
    if (el) {
      next[id] = el;
      dirty.set(id, 'put');
    } else {
      delete next[id];
      dirty.set(id, 'del');
    }
  }
  return next;
}

export interface CommitOptions {
  history?: boolean;
  // Consecutive commits with the same key (e.g. typing in one note) merge into one undo step.
  coalesce?: string;
}

// Applies element changes (null deletes) as one undoable step.
export function commit(changes: Record<string, El | null>, opts: CommitOptions = {}) {
  if (state.readOnly) return;
  changes = withSyncedCopies(changes);
  const ids = Object.keys(changes);
  if (ids.length === 0) return;
  const now = Date.now();
  if (opts.history !== false) {
    const before: Record<string, El | null> = {};
    for (const id of ids) before[id] = state.elements[id] ?? null;
    const last = undoStack[undoStack.length - 1];
    if (opts.coalesce && last && last.key === opts.coalesce && now - last.at < COALESCE_MS) {
      for (const id of ids) if (!(id in last.before)) last.before[id] = before[id];
      Object.assign(last.after, changes);
      last.at = now;
    } else {
      undoStack.push({ before, after: { ...changes }, key: opts.coalesce, at: now });
      if (undoStack.length > 300) undoStack.shift();
    }
    redoStack.length = 0;
  }
  setState({ elements: writeElements(changes), canUndo: undoStack.length > 0, canRedo: redoStack.length > 0 });
  scheduleFlush();
}

// Content edits to a synced copy are applied to every copy sharing its syncId.
function withSyncedCopies(changes: Record<string, El | null>): Record<string, El | null> {
  let out = changes;
  for (const el of Object.values(changes)) {
    if (!el?.syncId) continue;
    const prev = state.elements[el.id];
    if (prev && prev.content === el.content) continue;
    for (const other of Object.values(state.elements)) {
      if (other.syncId !== el.syncId || other.id === el.id || other.id in changes || other.type !== el.type) continue;
      if (out === changes) out = { ...changes };
      out[other.id] = { ...other, content: el.content, updatedAt: el.updatedAt } as El;
    }
  }
  return out;
}

function applyHistory(from: HistoryEntry[], to: HistoryEntry[], side: 'before' | 'after') {
  const entry = from.pop();
  if (!entry) return;
  to.push(entry);
  const changes = entry[side];
  const elements = writeElements(changes);
  const restored = Object.keys(changes).filter((id) => changes[id] && changes[id]!.section === 'canvas');
  setState({
    elements,
    editingId: null,
    selection: restored.filter((id) => elements[id]?.parentId === state.boardId),
    canUndo: undoStack.length > 0,
    canRedo: redoStack.length > 0,
  });
  scheduleFlush();
}

export const undo = () => applyHistory(undoStack, redoStack, 'before');
export const redo = () => applyHistory(redoStack, undoStack, 'after');

export function patchElement(id: string, patch: Patch, opts?: CommitOptions) {
  patchElements({ [id]: patch }, opts);
}

export function patchElements(patches: Record<string, Patch>, opts?: CommitOptions) {
  const changes: Record<string, El> = {};
  const now = Date.now();
  for (const [id, patch] of Object.entries(patches)) {
    const el = state.elements[id];
    if (!el) continue;
    changes[id] = {
      ...el,
      ...patch,
      content: patch.content ? { ...el.content, ...patch.content } : el.content,
      updatedAt: now,
    } as El;
  }
  commit(changes, opts);
}

// ---------------------------------------------------------------- queries

export function maxZ(boardId = state.boardId): number {
  let z = 0;
  for (const el of Object.values(state.elements)) if (el.parentId === boardId && el.z > z) z = el.z;
  return z;
}

export function columnChildren(columnId: string, elements = state.elements): El[] {
  return Object.values(elements)
    .filter((el) => el.columnId === columnId && el.section === 'canvas')
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

export function boardChildren(boardId: string, elements = state.elements): El[] {
  return Object.values(elements).filter((el) => el.parentId === boardId && el.section === 'canvas');
}

// All elements whose existence depends on `id`: board contents (recursively) and column children.
export function dependents(id: string, elements = state.elements): string[] {
  const out: string[] = [];
  const queue = [id];
  while (queue.length) {
    const current = queue.pop()!;
    for (const el of Object.values(elements)) {
      if (el.parentId === current || el.columnId === current) {
        out.push(el.id);
        queue.push(el.id);
      }
    }
  }
  return out;
}

export function boardPath(boardId: string): { id: string; title: string }[] {
  const path: { id: string; title: string }[] = [];
  let id: string | undefined = boardId;
  const seen = new Set<string>();
  while (id && id !== ROOT_ID && !seen.has(id)) {
    seen.add(id);
    const el: El | undefined = state.elements[id];
    if (!el || el.type !== 'board') break;
    path.unshift({ id, title: el.content.title || 'Untitled board' });
    if (id === state.publicRoot) return path;
    id = el.parentId;
  }
  path.unshift({ id: ROOT_ID, title: t('Home') });
  return path;
}

// ---------------------------------------------------------------- creation

export function defaultContent<T extends ElementType>(type: T): ContentByType[T] {
  const defaults: { [K in ElementType]: ContentByType[K] } = {
    note: { html: '' },
    heading: { text: '', size: 'large' },
    board: { title: '' },
    alias: { boardId: '' },
    column: { title: '' },
    todo: { title: '', items: [{ id: uid(), text: '', done: false }] },
    image: { src: '' },
    link: { url: '' },
    line: { from: { x: 0, y: 0 }, to: { x: 160, y: 0 }, arrow: 'end' },
    swatch: { hex: '#f4c95d' },
    file: { src: '', name: '', size: 0, mime: '' },
    sketch: { strokes: [], ratio: 0.66 },
    table: {
      title: '',
      header: true,
      cells: [
        ['', '', ''],
        ['', '', ''],
        ['', '', ''],
      ],
    },
    document: { title: '', html: '' },
    comment: { comments: [] },
    label: { name: '', color: '#3a8fd9' },
  };
  return defaults[type];
}

export function makeElement<T extends ElementType>(
  type: T,
  init: Partial<Omit<ElementOf<T>, 'content'>> & { content?: Partial<ContentByType[T]> } = {},
): ElementOf<T> {
  const now = Date.now();
  const { content, ...rest } = init;
  return {
    id: uid(),
    type,
    parentId: state.boardId,
    section: 'canvas',
    columnId: null,
    x: 0,
    y: 0,
    w: DEFAULT_WIDTH[type],
    z: maxZ() + 1,
    color: null,
    createdAt: now,
    updatedAt: now,
    ...rest,
    content: { ...defaultContent(type), ...content } as ContentByType[T],
  };
}

export function addElements(els: El[], { select = true, edit = false } = {}) {
  const changes: Record<string, El> = {};
  for (const el of els) changes[el.id] = el;
  commit(changes);
  if (select) setState({ selection: els.map((e) => e.id), editingId: edit && els.length === 1 ? els[0].id : null });
}

// Next order value to append to a column, or to insert before `beforeId`.
export function columnOrderAt(columnId: string, index: number, exclude: string[] = []): number {
  const kids = columnChildren(columnId).filter((k) => !exclude.includes(k.id));
  if (kids.length === 0) return 1;
  if (index <= 0) return (kids[0].order ?? 0) - 1;
  if (index >= kids.length) return (kids[kids.length - 1].order ?? 0) + 1;
  return ((kids[index - 1].order ?? 0) + (kids[index].order ?? 0)) / 2;
}

// ---------------------------------------------------------------- trash

export function trashElements(ids: string[]) {
  const now = Date.now();
  const changes: Record<string, El> = {};
  for (const id of ids) {
    const el = state.elements[id];
    if (el && el.section === 'canvas') changes[id] = { ...el, section: 'trash', trashedAt: now, updatedAt: now } as El;
  }
  commit(changes);
  setState({ selection: [], editingId: null });
  const n = Object.keys(changes).length;
  if (n) toast(t(n === 1 ? 'Moved 1 item to Trash' : 'Moved {n} items to Trash', { n }));
}

export function restoreElement(id: string) {
  const el = state.elements[id];
  if (!el) return;
  const parent = state.elements[el.parentId];
  const parentOk = el.parentId === ROOT_ID || (parent && parent.section === 'canvas');
  const column = el.columnId ? state.elements[el.columnId] : null;
  const columnOk = !el.columnId || (column && column.section === 'canvas');
  commit({
    [id]: {
      ...el,
      section: 'canvas',
      trashedAt: null,
      parentId: parentOk ? el.parentId : ROOT_ID,
      columnId: columnOk ? el.columnId : null,
      updatedAt: Date.now(),
    } as El,
  });
}

export function deleteForever(ids: string[]) {
  const changes: Record<string, null> = {};
  for (const id of ids) {
    changes[id] = null;
    for (const dep of dependents(id)) changes[dep] = null;
  }
  // Lines attached to deleted elements become free-floating.
  const extra: Record<string, El> = {};
  for (const el of Object.values(state.elements)) {
    if (el.type !== 'line' || el.id in changes) continue;
    const { from, to } = el.content;
    if ((from.id && from.id in changes) || (to.id && to.id in changes)) {
      extra[el.id] = {
        ...el,
        content: {
          ...el.content,
          from: from.id && from.id in changes ? { x: from.x, y: from.y } : from,
          to: to.id && to.id in changes ? { x: to.x, y: to.y } : to,
        },
      };
    }
  }
  commit({ ...extra, ...changes });
}

// ---------------------------------------------------------------- navigation & ui

export function navigate(boardId: string) {
  if (state.publicRoot && boardId === ROOT_ID) boardId = state.publicRoot;
  const hash = boardId === ROOT_ID ? '#/' : `#/b/${boardId}`;
  if (location.hash !== hash) location.hash = hash;
  setState({ boardId, selection: [], editingId: null, tool: null });
}

window.addEventListener('hashchange', () => {
  const id = boardFromHash();
  if (id !== state.boardId) setState({ boardId: id, selection: [], editingId: null, tool: null });
});

export function syncedCount(syncId: string | null | undefined, elements = state.elements): number {
  if (!syncId) return 0;
  let n = 0;
  for (const el of Object.values(elements)) if (el.syncId === syncId && el.section !== 'trash') n++;
  return n;
}

export function setTheme(theme: Theme) {
  try {
    localStorage.setItem('cn:theme', theme);
  } catch {}
  setState({ theme });
}

export function setHand(hand: boolean) {
  try {
    localStorage.setItem('cn:hand', hand ? '1' : '0');
  } catch {}
  if ((document.activeElement as HTMLElement | null)?.isContentEditable) (document.activeElement as HTMLElement).blur();
  setState(hand ? { hand, selection: [], editingId: null, tool: null, captionEditId: null } : { hand });
}

export function toast(text: string) {
  setState({ toast: { text: t(text), nonce: Date.now() } });
}

export function select(ids: string[]) {
  setState({ selection: ids, editingId: state.editingId && ids.includes(state.editingId) ? state.editingId : null });
}

export function startEditing(id: string | null) {
  if (state.readOnly && id) return;
  setState({ editingId: id, selection: id ? [id] : state.selection });
}
