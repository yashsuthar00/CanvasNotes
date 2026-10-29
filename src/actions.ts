// User-level operations shared by the toolbar, keyboard, menus and canvas.
import { t } from './i18n';
import { htmlToTextSafe } from './sanitize';
import * as api from './api';
import {
  addElements,
  columnOrderAt,
  commit,
  getState,
  makeElement,
  maxZ,
  patchElement,
  patchElements,
  setState,
  toast,
  uid,
  dependents,
} from './store';
import { COLUMN_CHILD_TYPES, DEFAULT_WIDTH, type El, type ElementOf, type ElementType } from './types';
import { allRects, contains, viewCenter } from './viewport';
import { importSpreadsheet, isSpreadsheet } from './moreActions';

export interface Placement {
  x: number;
  y: number;
  columnId?: string | null;
  index?: number;
}

// Where a new element lands: at a canvas point, or inside a column.
function place(type: ElementType, at: Placement) {
  if (at.columnId && COLUMN_CHILD_TYPES.includes(type)) {
    return { columnId: at.columnId, order: columnOrderAt(at.columnId, at.index ?? Infinity), x: 0, y: 0 };
  }
  return { columnId: null, x: Math.round(at.x), y: Math.round(at.y) };
}

let cascade = 0;
// A point near the middle of the view, nudged so repeated clicks don't stack exactly.
export function centerPlacement(): Placement {
  const c = viewCenter();
  cascade = (cascade + 1) % 6;
  return { x: c.x - 135 + cascade * 24, y: c.y - 80 + cascade * 24 };
}

// Finds the column (if any) under a world point, for dropping new things into it.
export function columnAt(point: { x: number; y: number }, exclude: string[] = []): { id: string; index: number } | null {
  const { elements, boardId } = getState();
  const rects = allRects();
  let best: El | null = null;
  for (const el of Object.values(elements)) {
    if (el.type !== 'column' || el.parentId !== boardId || el.section !== 'canvas' || exclude.includes(el.id)) continue;
    const r = rects.get(el.id);
    if (r && contains(r, point, 8) && (!best || el.z > best.z)) best = el;
  }
  if (!best) return null;
  return { id: best.id, index: columnIndexAt(best.id, point.y, exclude) };
}

export function columnIndexAt(columnId: string, y: number, exclude: string[] = []): number {
  const { elements } = getState();
  const rects = allRects();
  const kids = Object.values(elements)
    .filter((el) => el.columnId === columnId && el.section === 'canvas' && !exclude.includes(el.id))
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  let index = 0;
  for (const kid of kids) {
    const r = rects.get(kid.id);
    if (r && y > r.y + r.h / 2) index++;
  }
  return index;
}

export function createElement(type: ElementType, at: Placement = centerPlacement(), opts: { kind?: 'video' | 'audio' | 'map' } = {}): El | null {
  if (type === 'image' || type === 'file') {
    pickFiles(type === 'image' ? 'image/*' : '*/*', (files) => addFiles(files, at));
    return null;
  }
  const el = makeElement(type, place(type, at)) as El;
  if (el.type === 'link' && opts.kind) el.content = { ...el.content, kind: opts.kind };
  if (type === 'sketch' || type === 'document') {
    addElements([el]);
    setState({ modal: type === 'sketch' ? { kind: 'draw', id: el.id } : { kind: 'document', id: el.id } });
    return el;
  }
  if (type === 'line') {
    const line = el as Extract<El, { type: 'line' }>;
    line.content = { ...line.content, from: { x: at.x, y: at.y }, to: { x: at.x + 180, y: at.y } };
    addElements([el]);
    return el;
  }
  addElements([el], { edit: type !== 'swatch' });
  return el;
}

export function pickFiles(accept: string, onPick: (files: File[]) => void) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = accept;
  input.multiple = true;
  input.onchange = () => {
    if (input.files?.length) onPick([...input.files]);
  };
  input.click();
}

function imageRatio(src: string): Promise<number | undefined> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img.naturalWidth ? img.naturalHeight / img.naturalWidth : undefined);
    img.onerror = () => resolve(undefined);
    img.src = src;
  });
}

export async function addFiles(files: File[], at: Placement = centerPlacement()) {
  // CSV, TSV and Excel files become table cards (Milanote's spreadsheet import).
  const sheets = files.filter(isSpreadsheet);
  for (const sheet of sheets) await importSpreadsheet(sheet, at);
  files = files.filter((f) => !sheets.includes(f));
  if (files.length === 0) return;
  toast(t(files.length === 1 ? 'Uploading 1 file…' : 'Uploading {n} files…', { n: files.length }));
  const created: El[] = [];
  let offset = 0;
  let index = at.index ?? Infinity;
  for (const file of files) {
    try {
      const up = await api.upload(file);
      const isImage = up.mime.startsWith('image/');
      const spot = { ...at, x: at.x + offset, y: at.y + offset, index };
      const el = isImage
        ? makeElement('image', { ...place('image', spot), content: { src: up.url, ratio: await imageRatio(up.url) } })
        : makeElement('file', { ...place('file', spot), content: { src: up.url, name: up.name, size: up.size, mime: up.mime } });
      created.push(el);
      offset += 24;
      index++;
    } catch {
      toast(`Couldn't upload ${file.name}`);
    }
  }
  if (created.length) {
    addElements(created);
    toast(t(created.length === 1 ? 'Added 1 file' : 'Added {n} files', { n: created.length }));
  }
}

export function isUrl(text: string) {
  return /^https?:\/\/\S+$/i.test(text.trim());
}

export function addLink(url: string, at: Placement = centerPlacement()) {
  const el = makeElement('link', { ...place('link', at), content: { url: url.trim(), loading: true } });
  addElements([el]);
  void fetchLinkPreview(el.id, url.trim());
  return el;
}

export async function fetchLinkPreview(id: string, url: string) {
  patchElement(id, { content: { url, loading: true } }, { history: false });
  const imageBefore = (getState().elements[id] as ElementOf<'link'> | undefined)?.content.image;
  const info = await api.unfurl(url).catch(() => ({ ok: false }) as api.Unfurled);
  const now = getState().elements[id] as ElementOf<'link'> | undefined;
  if (!now) return;
  // A preview image picked while this was loading (Replace Preview) wins over the fetched one.
  const imageChanged = now.content.image !== imageBefore;
  patchElement(
    id,
    {
      content: {
        url,
        loading: false,
        title: info.title ?? null,
        description: info.description ?? null,
        image: imageChanged ? now.content.image : (info.image ?? null),
        site: info.site ?? hostOf(url),
      },
    },
    { history: false },
  );
}

export function hostOf(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function escapeHtml(text: string) {
  return text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

export function addTextNote(text: string, at: Placement = centerPlacement()) {
  const html = text
    .split(/\n{2,}/)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('');
  const el = makeElement('note', { ...place('note', at), content: { html } });
  addElements([el]);
}

// ---------------------------------------------------------------- copy / paste / duplicate

// The system clipboard gets plain text; pasting that same text back pastes the cards instead.
let internalClipboard: El[] = [];
let internalClipboardText = '';

// Elements plus everything inside them (column children, board contents).
function withDependents(ids: string[]): El[] {
  const { elements } = getState();
  const all = new Set<string>();
  for (const id of ids) {
    if (!elements[id]) continue;
    all.add(id);
    dependents(id).forEach((d) => all.add(d));
  }
  return [...all].map((id) => elements[id]).filter((el) => el.section === 'canvas');
}

// Deep-copies elements with fresh ids, remapping internal references.
function cloneTree(source: El[], roots: Set<string>, boardId: string, dx: number, dy: number): El[] {
  const idMap = new Map(source.map((el) => [el.id, uid()]));
  const now = Date.now();
  let z = maxZ(boardId);
  return source.map((el) => {
    const isRoot = roots.has(el.id);
    const copy = {
      ...structuredClone(el),
      id: idMap.get(el.id)!,
      parentId: isRoot ? boardId : idMap.get(el.parentId) ?? el.parentId,
      columnId: el.columnId ? idMap.get(el.columnId) ?? (isRoot ? el.columnId : null) : null,
      x: isRoot && !el.columnId ? el.x + dx : el.x,
      y: isRoot && !el.columnId ? el.y + dy : el.y,
      z: isRoot ? ++z : el.z,
      createdAt: now,
      updatedAt: now,
    } as El;
    if (copy.type === 'line') {
      const c = copy.content;
      const remap = (end: typeof c.from) => {
        const mapped = end.id ? idMap.get(end.id) : undefined;
        return { x: end.x + (isRoot ? dx : 0), y: end.y + (isRoot ? dy : 0), id: mapped ?? null };
      };
      copy.content = { ...c, from: remap(c.from), to: remap(c.to) };
    }
    return copy;
  });
}

export function duplicate(ids = getState().selection) {
  const { elements, boardId } = getState();
  const roots = new Set(ids.filter((id) => elements[id]));
  if (roots.size === 0) return;
  // Lines between duplicated elements come along.
  for (const el of Object.values(elements)) {
    if (el.type === 'line' && el.parentId === boardId && el.section === 'canvas') {
      const { from, to } = el.content;
      if (from.id && to.id && roots.has(from.id) && roots.has(to.id)) roots.add(el.id);
    }
  }
  const copies = cloneTree(withDependents([...roots]), roots, boardId, 24, 24);
  const newRootIds = copies.filter((c) => c.parentId === boardId && !copies.some((o) => o.id === c.columnId)).map((c) => c.id);
  addElements(copies, { select: false });
  setState({ selection: newRootIds });
}

export function copySelection() {
  const { selection, elements } = getState();
  if (selection.length === 0) return false;
  internalClipboard = withDependents(selection).map((el) => structuredClone(el));
  const rootIds = selection.filter((id) => elements[id]);
  const text = rootIds.map((id) => plainText(elements[id])).filter(Boolean).join('\n\n');
  internalClipboardText = text || `canvasnotes:${rootIds.join(',')}`;
  void navigator.clipboard?.writeText(internalClipboardText).catch(() => {});
  return true;
}

export function pasteInternal(at: Placement) {
  if (internalClipboard.length === 0) return false;
  const ids = new Set(internalClipboard.map((e) => e.id));
  const roots = new Set(internalClipboard.filter((e) => !ids.has(e.parentId) && !(e.columnId && ids.has(e.columnId))).map((e) => e.id));
  const { boardId } = getState();
  const rootEls = internalClipboard.filter((e) => roots.has(e.id) && !e.columnId);
  const minX = rootEls.length ? Math.min(...rootEls.map((e) => e.x)) : at.x;
  const minY = rootEls.length ? Math.min(...rootEls.map((e) => e.y)) : at.y;
  const source = internalClipboard.map((e) => (roots.has(e.id) ? { ...e, columnId: null } : e)) as El[];
  const copies = cloneTree(source, roots, boardId, at.x - minX, at.y - minY);
  addElements(copies, { select: false });
  setState({ selection: copies.filter((c) => c.parentId === boardId && !c.columnId).map((c) => c.id) });
  return true;
}

export function clipboardTextIsInternal(text: string) {
  return internalClipboard.length > 0 && text.replace(/\r\n/g, '\n') === internalClipboardText;
}

// ---------------------------------------------------------------- moving between boards

export function moveToBoard(ids: string[], targetBoardId: string) {
  const { elements } = getState();
  const moving = ids.map((id) => elements[id]).filter((el) => el && el.id !== targetBoardId) as El[];
  if (moving.length === 0) return;
  // Refuse to move a board into itself or its own descendants.
  for (const el of moving) {
    if (el.type === 'board' && (el.id === targetBoardId || dependents(el.id).includes(targetBoardId))) {
      toast("Can't move a board inside itself");
      return;
    }
  }
  const existing = Object.values(elements).filter((e) => e.parentId === targetBoardId && e.section === 'canvas' && !e.columnId);
  const right = existing.length ? Math.max(...existing.map((e) => e.x + e.w)) + 60 : 80;
  const minX = Math.min(...moving.map((e) => e.x));
  const minY = Math.min(...moving.map((e) => e.y));
  let z = maxZ(targetBoardId);
  const changes: Record<string, El> = {};
  for (const el of moving) {
    const dx = right - minX;
    const dy = 80 - minY;
    const next = { ...el, parentId: targetBoardId, columnId: null, x: el.x + dx, y: el.y + dy, z: ++z, updatedAt: Date.now() } as El;
    if (next.type === 'line') {
      const c = next.content;
      next.content = { ...c, from: { ...c.from, x: c.from.x + dx, y: c.from.y + dy }, to: { ...c.to, x: c.to.x + dx, y: c.to.y + dy } };
    }
    changes[el.id] = next;
  }
  commit(changes);
  setState({ selection: [] });
  const title = targetBoardId === 'root' ? 'Home' : (elements[targetBoardId] as Extract<El, { type: 'board' }>).content.title || 'board';
  toast(t(moving.length === 1 ? 'Moved 1 item to {title}' : 'Moved {n} items to {title}', { n: moving.length, title }));
}

// ---------------------------------------------------------------- text helpers

export function htmlToText(html: string) {
  return htmlToTextSafe(html.replace(/<\/(p|h\d|li|blockquote|pre)>/g, '$&\n')).replace(/\n{3,}/g, '\n\n').trim();
}

export function plainText(el: El): string {
  switch (el.type) {
    case 'note':
      return htmlToText(el.content.html);
    case 'board':
    case 'column':
      return el.content.title;
    case 'todo':
      return [el.content.title, ...el.content.items.map((i) => `${i.done ? '[x]' : '[ ]'} ${i.text}`)].filter(Boolean).join('\n');
    case 'link':
      return [el.content.title, el.content.url].filter(Boolean).join('\n');
    case 'image':
      return el.content.caption || '';
    case 'swatch':
      return [el.content.name, el.content.hex].filter(Boolean).join(' ');
    case 'file':
      return el.content.name;
    case 'line':
      return el.content.label || '';
    case 'heading':
      return el.content.text;
    case 'alias': {
      const target = getState().elements[el.content.boardId];
      return target?.type === 'board' ? target.content.title : '';
    }
    case 'sketch':
      return el.caption || '';
    case 'table':
      return [el.content.title, ...el.content.cells.map((r) => r.join('\t'))].filter(Boolean).join('\n');
    case 'document':
      return [el.content.title, htmlToText(el.content.html)].filter(Boolean).join('\n');
    case 'comment':
      return el.content.comments.map((c) => c.text).join('\n');
    case 'label':
      return el.content.name;
  }
}

// Empty notes and to-dos are discarded when you stop editing them, like Milanote.
export function isBlank(el: El) {
  if (el.type === 'note') return htmlToText(el.content.html) === '' && !/<(img|hr)/.test(el.content.html);
  if (el.type === 'todo') return !el.content.title.trim() && el.content.items.every((i) => !i.text.trim());
  if (el.type === 'link') return !el.content.url.trim();
  if (el.type === 'heading') return !el.content.text.trim();
  if (el.type === 'comment') return el.content.comments.length === 0;
  return false;
}

// ---------------------------------------------------------------- organising (context-menu actions)

function topLevel(ids: string[]) {
  const { elements } = getState();
  return ids.map((id) => elements[id]).filter((el): el is El => !!el && !el.columnId && el.type !== 'line');
}

// "Group into Column": wraps the selected cards in a new column at their top-left.
export function groupIntoColumn(ids = getState().selection) {
  const cards = topLevel(ids).filter((el) => COLUMN_CHILD_TYPES.includes(el.type));
  if (cards.length === 0) return;
  const rects = allRects();
  cards.sort((a, b) => (rects.get(a.id)?.y ?? a.y) - (rects.get(b.id)?.y ?? b.y) || a.x - b.x);
  const column = makeElement('column', { x: Math.min(...cards.map((c) => c.x)) - 10, y: Math.min(...cards.map((c) => c.y)) - 50 });
  const changes: Record<string, El> = { [column.id]: column };
  cards.forEach((c, i) => (changes[c.id] = { ...c, columnId: column.id, order: i + 1, updatedAt: Date.now() } as El));
  commit(changes);
  setState({ selection: [column.id] });
}

// "Connect with Lines": chains the selected cards with arrows in reading order.
export function connectWithLines(ids = getState().selection) {
  const cards = topLevel(ids);
  if (cards.length < 2) return toast('Select two or more cards to connect');
  cards.sort((a, b) => a.x - b.x || a.y - b.y);
  const lines = cards.slice(1).map((c, i) =>
    makeElement('line', { content: { from: { id: cards[i].id, x: cards[i].x, y: cards[i].y }, to: { id: c.id, x: c.x, y: c.y }, arrow: 'end' } }),
  );
  addElements(lines);
}

export function alignSelection(mode: 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom', ids = getState().selection) {
  const rects = allRects();
  const cards = topLevel(ids).filter((c) => rects.has(c.id) && !c.locked);
  if (cards.length < 2) return;
  const rs = cards.map((c) => rects.get(c.id)!);
  const left = Math.min(...rs.map((r) => r.x));
  const right = Math.max(...rs.map((r) => r.x + r.w));
  const top = Math.min(...rs.map((r) => r.y));
  const bottom = Math.max(...rs.map((r) => r.y + r.h));
  const patches: Record<string, Partial<El>> = {};
  cards.forEach((c, i) => {
    const r = rs[i];
    const x = mode === 'left' ? left : mode === 'right' ? right - r.w : mode === 'center' ? (left + right) / 2 - r.w / 2 : c.x;
    const y = mode === 'top' ? top : mode === 'bottom' ? bottom - r.h : mode === 'middle' ? (top + bottom) / 2 - r.h / 2 : c.y;
    patches[c.id] = { x: Math.round(x), y: Math.round(y) };
  });
  patchElements(patches);
}

export function distributeSelection(axis: 'horizontal' | 'vertical', ids = getState().selection) {
  const rects = allRects();
  const cards = topLevel(ids).filter((c) => rects.has(c.id) && !c.locked);
  if (cards.length < 3) return toast('Select three or more cards to distribute');
  const key = axis === 'horizontal' ? 'x' : 'y';
  const size = axis === 'horizontal' ? 'w' : 'h';
  cards.sort((a, b) => rects.get(a.id)![key] - rects.get(b.id)![key]);
  const rs = cards.map((c) => rects.get(c.id)!);
  const start = rs[0][key];
  const end = rs[rs.length - 1][key] + rs[rs.length - 1][size];
  const gap = (end - start - rs.reduce((s, r) => s + r[size], 0)) / (rs.length - 1);
  let pos = start;
  const patches: Record<string, Partial<El>> = {};
  cards.forEach((c, i) => {
    patches[c.id] = { [key]: Math.round(pos) } as Partial<El>;
    pos += rs[i][size] + gap;
  });
  patchElements(patches);
}

export function setLocked(ids: string[], locked: boolean) {
  patchElements(Object.fromEntries(ids.map((id) => [id, { locked }])));
}

let copiedStyle: { color: string | null } | null = null;
export function copyStyle(id = getState().selection[0]) {
  const el = getState().elements[id];
  if (!el) return;
  copiedStyle = { color: el.color ?? null };
  toast('Style copied');
}
export function pasteStyle(ids = getState().selection) {
  if (!copiedStyle) return toast('Copy a style first (Ctrl Alt C)');
  patchElements(Object.fromEntries(ids.map((id) => [id, { color: copiedStyle!.color }])));
}

// Milanote's "Unsorted" panel: a per-board holding area.
export function moveToInbox(ids = getState().selection) {
  const { elements } = getState();
  const patches: Record<string, Partial<El>> = {};
  for (const id of ids) {
    const el = elements[id];
    if (el && el.type !== 'line' && el.section === 'canvas') patches[id] = { section: 'inbox', columnId: null };
  }
  patchElements(patches);
  setState({ selection: [] });
  const n = Object.keys(patches).length;
  if (n) toast(t(n === 1 ? 'Moved 1 item to Unsorted' : 'Moved {n} items to Unsorted', { n }));
}

export function deleteCompletedTasks(id: string) {
  const el = getState().elements[id];
  if (el?.type !== 'todo') return;
  patchElement(id, { content: { items: el.content.items.filter((i) => !i.done) } });
}

export function createShortcut(boardId: string) {
  const board = getState().elements[boardId];
  if (board?.type !== 'board') return;
  const alias = makeElement('alias', { x: board.x + 140, y: board.y, content: { boardId } });
  addElements([alias]);
  toast('Shortcut created — drag it to any board');
}

export function duplicateLinkedBoard(aliasId: string) {
  const alias = getState().elements[aliasId];
  if (alias?.type !== 'alias') return;
  const { boardId } = getState();
  const target = getState().elements[alias.content.boardId];
  if (!target) return;
  const source = withDependents([target.id]);
  const copies = cloneTree(source, new Set([target.id]), boardId, 0, 0);
  const root = copies.find((c) => c.parentId === boardId && c.type === 'board')!;
  root.x = alias.x + 140;
  root.y = alias.y;
  addElements(copies, { select: false });
  setState({ selection: [root.id] });
}

export function boardUrl(boardId: string) {
  return `${location.origin}${location.pathname}${boardId === 'root' ? '#/' : `#/b/${boardId}`}`;
}

export function copyText(text: string, message = 'Copied') {
  void navigator.clipboard?.writeText(text).then(
    () => toast(message),
    () => toast("Couldn't copy"),
  );
}

// "Convert to …": change a card's type while keeping its text.
export function convertElement(id: string, to: 'note' | 'document' | 'board' | 'todo' | 'heading') {
  const el = getState().elements[id];
  if (!el || el.type === to) return;
  const text = plainText(el);
  const html = el.type === 'note' ? el.content.html : el.type === 'document' ? el.content.html : text.split('\n').map((l) => `<p>${escapeHtml(l)}</p>`).join('');
  const firstLine = text.split('\n')[0]?.trim() ?? '';
  let content: El['content'];
  switch (to) {
    case 'note':
      content = { html: el.type === 'document' && el.content.title ? `<h2>${escapeHtml(el.content.title)}</h2>${html}` : html };
      break;
    case 'document':
      content = { title: firstLine.slice(0, 80), html: el.type === 'note' ? el.content.html : html };
      break;
    case 'board':
      content = { title: firstLine.slice(0, 80) || 'Untitled board' };
      break;
    case 'todo':
      content = { title: '', items: text.split('\n').filter((l) => l.trim()).map((l) => ({ id: uid(), text: l.replace(/^\[[ x]\]\s*/, ''), done: /^\[x\]/.test(l) })) };
      break;
    case 'heading':
      content = { text: firstLine, size: 'large' };
      break;
  }
  commit({ [id]: { ...el, type: to, content, w: DEFAULT_WIDTH[to], updatedAt: Date.now() } as El });
}

export async function replaceImage(id: string) {
  pickFiles('image/*', async ([file]) => {
    const up = await api.upload(file);
    const img = new Image();
    img.src = up.url;
    await img.decode().catch(() => {});
    patchElement(id, { content: { src: up.url, ratio: img.naturalWidth ? img.naturalHeight / img.naturalWidth : undefined, annotation: [] } });
  });
}

export function replacePreview(id: string) {
  pickFiles('image/*', async ([file]) => {
    const up = await api.upload(file);
    patchElement(id, { content: { image: up.url } });
  });
}
