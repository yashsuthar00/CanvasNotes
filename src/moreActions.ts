// Card actions added for full Milanote parity: synced copies, attached comments,
// reactions, image tools, single-card export, spreadsheet import, image search,
// AI ideas, starter templates and the first-run welcome board.
import * as api from './api';
import { addElements, commit, getState, makeElement, maxZ, patchElement, patchElements, setState, toast, uid } from './store';
import { DEFAULT_WIDTH, type El, type ElementOf, type Stroke } from './types';
import { addPlaced, centerPlacement, plainText, type Placement } from './actions';
import { downloadText, htmlToMarkdown, safeFileName } from './markdown';
import { allRects } from './viewport';
import { SKETCH_W } from './elements/Sketch';
import { evaluateGrid } from './formula';
import { t } from './i18n';

// ---------------------------------------------------------------- synced copies

export function createSyncedCopy(id: string) {
  const el = getState().elements[id];
  if (!el) return;
  const syncId = el.syncId || uid();
  // Place the copy beside the original (or beside its column).
  const r = allRects().get(el.columnId ?? el.id);
  const x = r ? r.x + r.w + 40 : el.x + el.w + 40;
  const y = r ? r.y : el.y;
  const copy = { ...structuredClone(el), id: uid(), syncId, columnId: null, groupId: null, x: Math.round(x), y: Math.round(y), z: maxZ() + 1, createdAt: Date.now(), updatedAt: Date.now() } as El;
  const changes: Record<string, El> = { [copy.id]: copy };
  if (!el.syncId) changes[el.id] = { ...el, syncId } as El;
  commit(changes);
  setState({ selection: [copy.id] });
  toast('Synced copy created — drag it to any board');
}

export function unsync(id: string) {
  patchElement(id, { syncId: null });
  toast('This copy no longer syncs');
}

// ---------------------------------------------------------------- comments and reactions

// "Add comment" on a card: a comment thread next to it, joined by a dashed line.
export function attachComment(id: string) {
  const el = getState().elements[id];
  if (!el) return;
  const r = allRects().get(el.columnId ?? el.id);
  const x = r ? r.x + r.w + 60 : el.x + el.w + 60;
  const y = r ? r.y : el.y;
  const comment = makeElement('comment', { x: Math.round(x), y: Math.round(y) });
  const line = makeElement('line', {
    content: { from: { id: comment.id, x, y }, to: { id: el.id, x: el.x, y: el.y }, arrow: 'none', dashed: true },
  });
  addElements([comment, line], { select: false });
  setState({ selection: [comment.id], editingId: comment.id });
}

export const REACTIONS = ['👍', '❤️', '😂', '🎉', '🔥', '👀', '✅', '❓'];

export function toggleReaction(ids: string[], emoji: string) {
  const { elements } = getState();
  const all = ids.every((id) => elements[id]?.reactions?.includes(emoji));
  const patches: Record<string, Partial<El>> = {};
  for (const id of ids) {
    const cur = elements[id]?.reactions ?? [];
    patches[id] = { reactions: all ? cur.filter((r) => r !== emoji) : [...new Set([...cur, emoji])] };
  }
  patchElements(patches);
}

// ---------------------------------------------------------------- images

const GRID = 24;

// Snap an image card so its width and visible height land on the dot grid.
export function cropToGrid(id: string) {
  const el = getState().elements[id];
  if (el?.type !== 'image' || !el.content.ratio) return;
  const crop = el.content.crop ?? { x: 0, y: 0, w: 1, h: 1 };
  const w = Math.max(GRID * 4, Math.round(el.w / GRID) * GRID);
  const visibleRatio = (el.content.ratio * crop.h) / crop.w;
  const targetH = Math.max(GRID, Math.floor((w * visibleRatio) / GRID) * GRID);
  const newH = (crop.h * targetH) / (w * visibleRatio);
  const y = crop.y + (crop.h - newH) / 2;
  patchElement(id, { w, content: { crop: { x: crop.x, y, w: crop.w, h: newH } } });
}

export function convertToSketch(id: string) {
  const el = getState().elements[id];
  if (el?.type !== 'image') return;
  const content: ElementOf<'sketch'>['content'] = { strokes: el.content.annotation ?? [], ratio: el.content.ratio ?? 0.66, background: el.content.src };
  commit({ [id]: { ...el, type: 'sketch', content, updatedAt: Date.now() } as El });
}

export function newPlaceholder(at: Placement = centerPlacement()) {
  const el = makeElement('image', { x: Math.round(at.x), y: Math.round(at.y), columnId: at.columnId ?? null, content: { src: '' } });
  addElements([el]);
}

// Fill an empty image placeholder with whatever file was chosen.
export async function fillPlaceholder(id: string, file: File) {
  const up = await api.upload(file);
  const el = getState().elements[id];
  if (!el) return;
  if (up.mime.startsWith('image/')) {
    const img = new Image();
    img.src = up.url;
    await img.decode().catch(() => {});
    patchElement(id, { content: { src: up.url, ratio: img.naturalWidth ? img.naturalHeight / img.naturalWidth : undefined } });
  } else {
    commit({ [id]: { ...el, type: 'file', w: DEFAULT_WIDTH.file, content: { src: up.url, name: up.name, size: up.size, mime: up.mime }, updatedAt: Date.now() } as El });
  }
}

// ---------------------------------------------------------------- export one card

export function strokesToSvg(strokes: Stroke[], ratio: number, background?: string | null) {
  const h = SKETCH_W * ratio;
  const paths = strokes
    .map((s) => {
      const p = s.points;
      const d = p.length === 2 ? `M${p[0]},${p[1]} l0.01,0` : 'M' + p.reduce<string[]>((acc, v, i) => (i % 2 ? acc : [...acc, `${v},${p[i + 1]}`]), []).join(' L');
      return `<path d="${d}" stroke="${s.color}" stroke-width="${s.width}" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
    })
    .join('\n  ');
  const bg = background ? `<image href="${location.origin}${background}" width="${SKETCH_W}" height="${h}" preserveAspectRatio="xMidYMid slice"/>\n  ` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SKETCH_W} ${h}" width="${SKETCH_W}" height="${Math.round(h)}">\n  ${bg}${paths}\n</svg>\n`;
}

function csvCell(v: string) {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export function exportElement(id: string) {
  const el = getState().elements[id];
  if (!el) return;
  const name = safeFileName(plainText(el).split('\n')[0] || el.type);
  switch (el.type) {
    case 'note':
      return downloadText(`${name}.md`, htmlToMarkdown(el.content.html) + '\n', 'text/markdown');
    case 'document':
      return downloadText(`${name}.md`, `# ${el.content.title}\n\n${htmlToMarkdown(el.content.html)}\n`, 'text/markdown');
    case 'todo':
      return downloadText(
        `${name}.md`,
        `${el.content.title ? `# ${el.content.title}\n\n` : ''}${el.content.items.map((i) => `${'  '.repeat(i.indent ?? 0)}- [${i.done ? 'x' : ' '}] ${i.text}${i.due ? ` (due ${i.due})` : ''}`).join('\n')}\n`,
        'text/markdown',
      );
    case 'table': {
      const values = evaluateGrid(el.content.cells);
      const csv = values.map((row) => row.map((c) => csvCell(c.error ?? String(c.value))).join(',')).join('\n');
      return downloadText(`${name}.csv`, csv + '\n', 'text/csv');
    }
    case 'sketch':
      return downloadText(`${name}.svg`, strokesToSvg(el.content.strokes, el.content.ratio, el.content.background), 'image/svg+xml');
    case 'image':
    case 'voice':
    case 'file': {
      const a = document.createElement('a');
      a.href = el.content.src;
      a.download = el.type === 'file' || el.type === 'voice' ? el.content.name : name;
      a.click();
      return;
    }
    case 'link':
      return downloadText(`${name}.md`, `[${el.content.title || el.content.url}](${el.content.url})\n${el.content.description ? `\n${el.content.description}\n` : ''}`, 'text/markdown');
    default:
      return downloadText(`${name}.txt`, plainText(el) + '\n');
  }
}

// ---------------------------------------------------------------- spreadsheets → tables

export function parseDelimited(text: string, delimiter?: string): string[][] {
  const sep = delimiter ?? (text.split('\n')[0].includes('\t') ? '\t' : ',');
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === sep) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  const width = Math.max(1, ...rows.map((r) => r.length));
  return rows.filter((r) => r.some((c) => c !== '')).map((r) => [...r, ...Array(width - r.length).fill('')]);
}

// Minimal .xlsx reader: unzip with the browser's DecompressionStream and read the first sheet.
async function readXlsx(file: File): Promise<string[][]> {
  const buf = new Uint8Array(await file.arrayBuffer());
  const view = new DataView(buf.buffer);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (view.getUint32(i, true) === 0x06054b50) {
    eocd = i;
    break;
  }
  if (eocd < 0) throw new Error(t('Not a valid .xlsx file'));
  const count = view.getUint16(eocd + 10, true);
  let ptr = view.getUint32(eocd + 16, true);
  const files = new Map<string, { method: number; size: number; offset: number }>();
  for (let n = 0; n < count; n++) {
    const method = view.getUint16(ptr + 10, true);
    const size = view.getUint32(ptr + 20, true);
    const nameLen = view.getUint16(ptr + 28, true);
    const extraLen = view.getUint16(ptr + 30, true);
    const commentLen = view.getUint16(ptr + 32, true);
    const offset = view.getUint32(ptr + 42, true);
    const name = new TextDecoder().decode(buf.subarray(ptr + 46, ptr + 46 + nameLen));
    files.set(name, { method, size, offset });
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  const read = async (name: string) => {
    const f = files.get(name);
    if (!f) return null;
    const start = f.offset + 30 + view.getUint16(f.offset + 26, true) + view.getUint16(f.offset + 28, true);
    const data = buf.subarray(start, start + f.size);
    if (f.method === 0) return new TextDecoder().decode(data);
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Response(stream).text();
  };
  const shared: string[] = [];
  const sst = await read('xl/sharedStrings.xml');
  if (sst) {
    const doc = new DOMParser().parseFromString(sst, 'application/xml');
    doc.querySelectorAll('si').forEach((si) => shared.push([...si.querySelectorAll('t')].map((t) => t.textContent ?? '').join('')));
  }
  const sheetName = [...files.keys()].filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort()[0];
  const sheet = sheetName ? await read(sheetName) : null;
  if (!sheet) throw new Error(t('The workbook has no sheets'));
  const doc = new DOMParser().parseFromString(sheet, 'application/xml');
  const grid: string[][] = [];
  doc.querySelectorAll('sheetData row').forEach((rowEl) => {
    const r = Number(rowEl.getAttribute('r') ?? grid.length + 1) - 1;
    rowEl.querySelectorAll('c').forEach((c) => {
      const ref = c.getAttribute('r') ?? '';
      const letters = ref.replace(/\d+/g, '');
      let col = 0;
      for (const ch of letters) col = col * 26 + (ch.charCodeAt(0) - 64);
      col -= 1;
      const type = c.getAttribute('t');
      const f = c.querySelector('f')?.textContent;
      const v = c.querySelector('v')?.textContent ?? c.querySelector('is t')?.textContent ?? '';
      const value = f ? `=${f}` : type === 's' ? shared[Number(v)] ?? '' : type === 'b' ? (v === '1' ? 'TRUE' : 'FALSE') : v;
      (grid[r] ??= [])[col] = value;
    });
  });
  const width = Math.max(1, ...grid.map((r) => r?.length ?? 0));
  return grid.filter(Boolean).map((r) => Array.from({ length: width }, (_, i) => r[i] ?? '')).slice(0, 500);
}

export function isSpreadsheet(file: File) {
  return /\.(csv|tsv|xlsx)$/i.test(file.name) || ['text/csv', 'text/tab-separated-values', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'].includes(file.type);
}

export async function importSpreadsheet(file: File, at: Placement = centerPlacement()) {
  try {
    const cells = /\.xlsx$/i.test(file.name) ? await readXlsx(file) : parseDelimited(await file.text(), /\.tsv$/i.test(file.name) ? '\t' : undefined);
    if (!cells.length) return toast('That file has no data');
    const cols = cells[0].length;
    const table = makeElement('table', {
      x: Math.round(at.x),
      y: Math.round(at.y),
      columnId: at.columnId ?? null,
      w: Math.min(1200, Math.max(DEFAULT_WIDTH.table, cols * 110)),
      content: { title: file.name.replace(/\.[^.]+$/, ''), cells, header: true },
    });
    addPlaced([table], at);
    toast(`Imported ${cells.length} rows from ${file.name}`);
  } catch (err) {
    toast(`Couldn't import ${file.name}: ${err instanceof Error ? err.message : err}`);
  }
}

// ---------------------------------------------------------------- image search

export interface ImageResult {
  title: string;
  thumb: string;
  url: string;
  page: string;
  author: string;
  license: string;
  ratio: number | null;
}

export async function insertSearchImage(result: ImageResult, at: Placement = centerPlacement()) {
  toast('Adding image…');
  const up = await api.postJson<api.Uploaded>('/api/import-url', { url: result.url });
  const el = makeElement('image', {
    x: Math.round(at.x),
    y: Math.round(at.y),
    columnId: at.columnId ?? null,
    content: {
      src: up.url,
      ratio: result.ratio ?? undefined,
      attribution: { label: `${result.author ? `${result.author} · ` : ''}${result.license || 'Wikimedia Commons'}`, url: result.page },
    },
  });
  addElements([el]);
}

// ---------------------------------------------------------------- AI ideas

export async function addAiIdeas(prompt: string, at: Placement = centerPlacement()) {
  const { boardId, elements } = getState();
  const context = Object.values(elements)
    .filter((e) => e.parentId === boardId && e.section === 'canvas' && (e.type === 'note' || e.type === 'heading' || e.type === 'todo'))
    .slice(0, 30)
    .map((e) => plainText(e).slice(0, 300));
  const res = await api.postJson<{ title: string; ideas: { title: string; detail: string }[] }>('/api/ai-ideas', { prompt, context });
  const column = makeElement('column', { x: Math.round(at.x), y: Math.round(at.y), content: { title: res.title || prompt.slice(0, 60) } });
  const notes = res.ideas.map((idea, i) =>
    makeElement('note', {
      columnId: column.id,
      order: i + 1,
      content: { html: `<p><strong>${escapeHtml(idea.title)}</strong></p><p>${escapeHtml(idea.detail)}</p>` },
    }),
  );
  addElements([column, ...notes], { select: false });
  setState({ selection: [column.id] });
}

function escapeHtml(t: string) {
  return t.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
}

// ---------------------------------------------------------------- folders

export function newFolder(at: Placement = centerPlacement()) {
  const folder = makeElement('column', { x: Math.round(at.x), y: Math.round(at.y), w: 240, content: { title: 'New Folder', folder: true, collapsed: false } });
  addElements([folder], { edit: true });
}

// ---------------------------------------------------------------- starter templates

type Seed = { type: El['type']; x: number; y: number; w?: number; color?: string | null; content: Record<string, unknown>; children?: Seed[] };

const p = (t: string) => `<p>${escapeHtml(t)}</p>`;
const task = (text: string) => ({ id: uid(), text, done: false });

export const STARTER_TEMPLATES: { id: string; title: string; icon: string; description: string; seeds: Seed[] }[] = [
  {
    id: 'moodboard',
    title: 'Moodboard',
    icon: '🎨',
    description: 'Collect images, colours and words for a creative direction.',
    seeds: [
      { type: 'heading', x: 0, y: 0, w: 500, content: { text: 'Moodboard', size: 'large' } },
      { type: 'note', x: 0, y: 80, color: 'butter', content: { html: p('What feeling should this have? Write three words.') } },
      { type: 'swatch', x: 300, y: 80, content: { hex: '#2d3142', name: 'Ink' } },
      { type: 'swatch', x: 440, y: 80, content: { hex: '#ef8354', name: 'Coral' } },
      { type: 'swatch', x: 580, y: 80, content: { hex: '#bfc0c0', name: 'Mist' } },
      { type: 'image', x: 0, y: 260, content: { src: '' } },
      { type: 'image', x: 320, y: 260, content: { src: '' } },
    ],
  },
  {
    id: 'weekly',
    title: 'Weekly planner',
    icon: '🗓️',
    description: 'Plan the week with a column per day.',
    seeds: [
      { type: 'heading', x: 0, y: 0, w: 500, content: { text: 'This week', size: 'large' } },
      ...['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Weekend'].map((day, i) => ({
        type: 'column' as const,
        x: i * 280,
        y: 80,
        w: 260,
        content: { title: day },
        children: [{ type: 'todo' as const, x: 0, y: 0, content: { title: '', items: [task('')] } }],
      })),
    ],
  },
  {
    id: 'kanban',
    title: 'Kanban board',
    icon: '📋',
    description: 'To do, doing and done columns for any project.',
    seeds: [
      { type: 'column', x: 0, y: 0, color: 'slate', content: { title: 'To do' }, children: [{ type: 'note', x: 0, y: 0, content: { html: p('First task') } }] },
      { type: 'column', x: 320, y: 0, color: 'sky', content: { title: 'Doing' } },
      { type: 'column', x: 640, y: 0, color: 'mint', content: { title: 'Done' } },
    ],
  },
  {
    id: 'project',
    title: 'Project plan',
    icon: '🚀',
    description: 'Goals, milestones, tasks and a place for notes.',
    seeds: [
      { type: 'heading', x: 0, y: 0, w: 600, content: { text: 'Project name', size: 'large' } },
      { type: 'note', x: 0, y: 80, color: 'sky', content: { html: '<h2>Goal</h2>' + p('What does success look like?') } },
      { type: 'todo', x: 300, y: 80, content: { title: 'Milestones', items: [task('Kick-off'), task('First draft'), task('Launch')] } },
      { type: 'table', x: 600, y: 80, w: 420, content: { title: 'Budget', header: true, cells: [['Item', 'Cost'], ['', ''], ['Total', '=SUM(B2:B2)']] } },
      { type: 'document', x: 0, y: 300, content: { title: 'Brief', html: p('Background, audience and constraints.') } },
    ],
  },
  {
    id: 'meeting',
    title: 'Meeting notes',
    icon: '📝',
    description: 'Agenda, notes, decisions and actions.',
    seeds: [
      { type: 'heading', x: 0, y: 0, w: 500, content: { text: 'Meeting', size: 'large' } },
      { type: 'todo', x: 0, y: 80, content: { title: 'Agenda', items: [task('')] } },
      { type: 'note', x: 300, y: 80, content: { html: '<h2>Notes</h2>' + p('') } },
      { type: 'note', x: 600, y: 80, color: 'mint', content: { html: '<h2>Decisions</h2>' + p('') } },
      { type: 'todo', x: 900, y: 80, color: 'peach', content: { title: 'Actions', items: [task('')] } },
    ],
  },
  {
    id: 'trip',
    title: 'Trip planner',
    icon: '✈️',
    description: 'Places, bookings, a packing list and a map.',
    seeds: [
      { type: 'heading', x: 0, y: 0, w: 500, content: { text: 'Trip', size: 'large' } },
      { type: 'link', x: 0, y: 80, content: { url: '', kind: 'map' } },
      { type: 'todo', x: 330, y: 80, content: { title: 'Packing', items: [task('Passport'), task('Chargers')] } },
      { type: 'table', x: 630, y: 80, w: 420, content: { title: 'Bookings', header: true, cells: [['What', 'When', 'Ref'], ['', '', '']] } },
      { type: 'column', x: 0, y: 380, content: { title: 'Places to see' } },
    ],
  },
];

// Creates a new board on the current board, filled from a starter template.
export function applyStarterTemplate(templateId: string, at: { x: number; y: number }, keepContent = true) {
  const tpl = STARTER_TEMPLATES.find((t) => t.id === templateId);
  if (!tpl) return null;
  const board = makeElement('board', { x: Math.round(at.x), y: Math.round(at.y), content: { title: tpl.title, icon: tpl.icon } });
  const els: El[] = [board];
  let z = 1;
  const build = (seed: Seed, parentId: string, columnId: string | null, order: number) => {
    const content = { ...seed.content } as Record<string, unknown>;
    if (!keepContent && seed.type === 'note') content.html = '';
    const el = makeElement(seed.type, {
      parentId,
      columnId,
      order,
      x: seed.x,
      y: seed.y,
      w: seed.w ?? DEFAULT_WIDTH[seed.type],
      z: z++,
      color: seed.color ?? null,
      content: content as never,
    }) as El;
    els.push(el);
    seed.children?.forEach((child, i) => build(child, parentId, el.id, i + 1));
  };
  tpl.seeds.forEach((seed, i) => build(seed, board.id, null, i));
  addElements(els, { select: false });
  setState({ selection: [board.id] });
  return board;
}

// ---------------------------------------------------------------- first run

export function seedWelcomeBoard() {
  try {
    if (localStorage.getItem(api.userKey('cn:welcomed'))) return;
    localStorage.setItem(api.userKey('cn:welcomed'), '1');
  } catch {
    return;
  }
  const { elements } = getState();
  if (Object.values(elements).some((e) => e.section === 'canvas' && e.parentId === 'root')) return;
  const board = makeElement('board', { parentId: 'root', x: 120, y: 120, content: { title: 'Welcome to Canvas Notes', icon: '👋' } });
  const coarse = matchMedia('(pointer: coarse)').matches;
  const tips = [
    ['Write anything', coarse ? 'Double-tap the board to add a note. Tap a selected note to edit it.' : 'Double-click the board to add a note. Click a selected note to edit it.'],
    ['Add more', coarse ? 'Tap a tool along the bottom: to-dos, links, images, tables, sketches…' : 'Drag tools from the left toolbar: to-dos, links, images, tables, sketches…'],
    ['Organise', 'Put cards in columns, connect them with lines, and nest boards inside boards.'],
    ['Find it later', 'Search everything with Ctrl K, label cards, and keep loose notes in Unsorted.'],
  ];
  const els: El[] = [board];
  els.push(makeElement('heading', { parentId: board.id, x: 0, y: 0, w: 640, content: { text: 'Welcome 👋', size: 'large' } }) as El);
  tips.forEach(([title, body], i) => {
    els.push(makeElement('note', { parentId: board.id, x: (i % 2) * 300, y: 90 + Math.floor(i / 2) * 170, color: ['butter', 'sky', 'mint', 'lilac'][i], content: { html: `<h2>${title}</h2>${p(body)}` } }) as El);
  });
  els.push(makeElement('todo', { parentId: board.id, x: 620, y: 90, content: { title: 'Try these', items: [task('Make a note'), task('Drag a card into a column'), task('Open a board inside a board'), task('Press ? for shortcuts')] } }) as El);
  addElements(els, { select: false });
  setState({ selection: [] });
}
