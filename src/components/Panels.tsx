import { useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import {
  addElements,
  boardPath,
  commit,
  deleteForever,
  getState,
  makeElement,
  navigate,
  patchElement,
  restoreElement,
  setState,
  setTheme,
  useStore,
  dependents,
  uid,
} from '../store';
import * as api from '../api';
import { LABELS_PARENT, QUICK_PARENT, ROOT_ID, SYSTEM_PARENT, TEMPLATES_PARENT, type El, type ElementOf } from '../types';
import { STARTER_TEMPLATES, applyStarterTemplate } from '../moreActions';
import { plainText, columnAt, boardUrl, copyText } from '../actions';
import { useLabels } from './Modals';
import { isOverCanvas, screenToWorld, allRects, union, canvasRect } from '../viewport';
import { exportBoardMarkdown, exportBoardPng, exportBoardText, exportBoardWord } from '../exporters';
import { ElementBody } from '../elements/ElementBody';
import { getToolbarPrefs, setToolbarPrefs, ALL_TOOL_IDS, TOOL_LABELS } from './toolbarPrefs';
import { CURRENCY_OPTIONS, FORMAT_OPTIONS, getLocaleSettings, numLocale, setLocaleSettings, type LocaleSettings } from '../locale';
import { getLang, LANGUAGES, setLang, t, type Lang } from '../i18n';

export const TYPE_LABEL: Record<El['type'], string> = {
  note: 'Note',
  heading: 'Heading',
  board: 'Board',
  alias: 'Shortcut',
  column: 'Column',
  todo: 'To-do',
  image: 'Image',
  link: 'Link',
  line: 'Line',
  swatch: 'Colour',
  file: 'File',
  sketch: 'Sketch',
  table: 'Table',
  document: 'Document',
  comment: 'Comment',
  label: 'Label',
};

function close() {
  setState({ panel: null });
}

function boardTitle(id: string) {
  return boardPath(id)
    .map((b) => b.title)
    .join(' / ');
}

// ---------------------------------------------------------------- recently viewed boards

const VIEWED_KEY = 'cn:viewed';
export function lastViewed(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(api.userKey(VIEWED_KEY)) || '{}');
  } catch {
    return {};
  }
}
export function markViewed(boardId: string) {
  try {
    const v = lastViewed();
    v[boardId] = Date.now();
    localStorage.setItem(api.userKey(VIEWED_KEY), JSON.stringify(v));
  } catch {}
}

// ---------------------------------------------------------------- search

type Sort = 'relevance' | 'modified' | 'viewed';

export function SearchPalette() {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [sort, setSort] = useState<Sort>('relevance');
  const [labelFilter, setLabelFilter] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const elements = useStore((s) => s.elements);
  const labels = useLabels();

  useEffect(() => inputRef.current?.focus(), []);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    const viewed = lastViewed();
    const live = Object.values(elements).filter(
      (el) => el.section === 'canvas' && el.type !== 'line' && el.type !== 'label' && isLive(el, elements) && (!labelFilter || el.labels?.includes(labelFilter)),
    );
    const sorter = (a: { el: El; score: number }, b: { el: El; score: number }) =>
      sort === 'modified'
        ? b.el.updatedAt - a.el.updatedAt
        : sort === 'viewed'
          ? (viewed[b.el.type === 'board' ? b.el.id : b.el.parentId] ?? 0) - (viewed[a.el.type === 'board' ? a.el.id : a.el.parentId] ?? 0)
          : b.score - a.score;
    if (!q && !labelFilter) {
      // Recent boards, by when they were last opened.
      return live
        .filter((el) => el.type === 'board')
        .map((el) => ({ el, text: plainText(el), score: viewed[el.id] ?? 0 }))
        .sort((a, b) => b.score - a.score || b.el.updatedAt - a.el.updatedAt)
        .slice(0, 12);
    }
    const terms = q.split(/\s+/).filter(Boolean);
    return live
      .map((el) => {
        const text = plainText(el) + ' ' + (el.caption ?? '');
        const lower = text.toLowerCase();
        if (!terms.every((t) => lower.includes(t))) return null;
        const score = (el.type === 'board' ? 3 : 0) + (terms[0] && lower.startsWith(terms[0]) ? 2 : 0) + el.updatedAt / 1e13;
        return { el, text, score };
      })
      .filter((r): r is { el: El; text: string; score: number } => !!r)
      .sort(sorter)
      .slice(0, 80);
  }, [query, elements, sort, labelFilter]);

  const open = (el: El) => {
    close();
    if (el.type === 'board' && !query.trim()) return navigate(el.id);
    navigate(el.parentId);
    setState({ focusRequest: { id: el.id, nonce: Date.now() } });
  };

  return (
    <div className="overlay" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div className="palette" role="dialog" aria-label={t('Search')}>
        <input
          ref={inputRef}
          className="palette-input"
          placeholder={t('Search notes, boards, to-dos, links, tables…')}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') close();
            else if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive((a) => Math.min(results.length - 1, a + 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((a) => Math.max(0, a - 1));
            } else if (e.key === 'Enter' && results[active]) open(results[active].el);
          }}
        />
        <div className="palette-filters">
          <span className="palette-hint">
            {query.trim() || labelFilter ? t(results.length === 1 ? '1 match' : '{n} matches', { n: results.length }) : t('Recently viewed boards')}
          </span>
          <label>
            {t('Sort by:')}{' '}
            <select value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
              <option value="relevance">{t('Relevance')}</option>
              <option value="modified">{t('Last modified')}</option>
              <option value="viewed">{t('Last viewed')}</option>
            </select>
          </label>
          {labels.length > 0 && (
            <label>
              Label:{' '}
              <select value={labelFilter ?? ''} onChange={(e) => setLabelFilter(e.target.value || null)}>
                <option value="">{t('Any')}</option>
                {labels.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.content.name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        <ul className="palette-results scrollable">
          {results.map((r, i) => (
            <li key={r.el.id}>
              <button className={i === active ? 'active' : ''} onMouseEnter={() => setActive(i)} onClick={() => open(r.el)}>
                <span className={`type-pill type-${r.el.type}`}>{t(TYPE_LABEL[r.el.type])}</span>
                <span className="result-text">
                  <Highlight text={snippet(r.text, query)} query={query} />
                  {r.el.labels?.length ? (
                    <span className="result-labels">
                      {r.el.labels.map((id) => {
                        const l = elements[id];
                        return l?.type === 'label' ? (
                          <span key={id} className="label-chip small" style={{ background: l.content.color }}>
                            {l.content.name}
                          </span>
                        ) : null;
                      })}
                    </span>
                  ) : null}
                </span>
                <span className="result-where">{r.el.type === 'board' && !query.trim() ? t('Board') : boardTitle(r.el.parentId)}</span>
              </button>
            </li>
          ))}
          {(query.trim() || labelFilter) && results.length === 0 && <li className="palette-empty">No results found for “{query}”. Try adjusting your search.</li>}
        </ul>
      </div>
    </div>
  );
}

// An element is searchable only if every board above it is also on the canvas.
function isLive(el: El, elements: Record<string, El>) {
  const seen = new Set<string>();
  let parentId = el.parentId;
  if (el.columnId && elements[el.columnId]?.section !== 'canvas') return false;
  while (parentId !== ROOT_ID) {
    if (seen.has(parentId)) return false;
    seen.add(parentId);
    const parent = elements[parentId];
    if (!parent || parent.section !== 'canvas') return false;
    parentId = parent.parentId;
  }
  return true;
}

function snippet(text: string, query: string) {
  const flat = text.replace(/\s+/g, ' ').trim();
  const first = query.trim().toLowerCase().split(/\s+/)[0];
  const i = first ? flat.toLowerCase().indexOf(first) : -1;
  if (i < 50) return flat.slice(0, 140) || '(empty)';
  return '…' + flat.slice(i - 40, i + 100);
}

function Highlight({ text, query }: { text: string; query: string }) {
  const terms = query
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!terms.length) return <>{text}</>;
  const parts = text.split(new RegExp(`(${terms.join('|')})`, 'gi'));
  return <>{parts.map((p, i) => (i % 2 ? <mark key={i}>{p}</mark> : p))}</>;
}

// ---------------------------------------------------------------- trash

export function TrashPanel() {
  const elements = useStore((s) => s.elements);
  const trashed = Object.values(elements)
    .filter((el) => el.section === 'trash')
    .sort((a, b) => (b.trashedAt ?? 0) - (a.trashedAt ?? 0));
  const [confirming, setConfirming] = useState(false);

  return (
    <aside className="side-panel" aria-label={t('Trash')}>
      <div className="side-head">
        <h2>{t('Trash')}</h2>
        <button className="icon-btn" onClick={close} title={t('Close')}>
          ✕
        </button>
      </div>
      <p className="side-sub">{t('Restore things you removed, or delete them for good.')}</p>
      <ul className="trash-list scrollable">
        {trashed.length === 0 && <li className="trash-empty">{t('Trash is empty.')}</li>}
        {trashed.map((el) => (
          <li key={el.id}>
            <div className="trash-item">
              <span className={`type-pill type-${el.type}`}>{t(TYPE_LABEL[el.type])}</span>
              <div className="trash-text">
                <div className="trash-title">{plainText(el).slice(0, 90) || (el.type === 'image' ? t('Image') : t('Untitled'))}</div>
                <div className="trash-where">
                  from {boardTitle(el.parentId)} · {timeAgo(el.trashedAt ?? el.updatedAt)}
                </div>
              </div>
            </div>
            <div className="trash-actions">
              <button onClick={() => restoreElement(el.id)}>{t('Restore')}</button>
              <button className="danger" onClick={() => deleteForever([el.id])}>
                {t('Delete')}
              </button>
            </div>
          </li>
        ))}
      </ul>
      {trashed.length > 0 && (
        <div className="side-foot">
          {confirming ? (
            <>
              <span>{t('This will permanently delete all boards and cards in the trash.')}</span>
              <button
                className="danger solid"
                onClick={() => {
                  deleteForever(trashed.map((t) => t.id));
                  setConfirming(false);
                }}
              >
                {t('Continue')}
              </button>
              <button onClick={() => setConfirming(false)}>{t('Cancel')}</button>
            </>
          ) : (
            <button className="danger" onClick={() => setConfirming(true)}>
              {t('Empty trash')}
            </button>
          )}
        </div>
      )}
    </aside>
  );
}

export function timeAgo(at: number) {
  const s = Math.round((Date.now() - at) / 1000);
  if (s < 60) return t('just now');
  if (s < 3600) return t('{n} min ago', { n: Math.round(s / 60) });
  if (s < 86400) return t('{n} h ago', { n: Math.round(s / 3600) });
  return new Date(at).toLocaleDateString(numLocale());
}

// ---------------------------------------------------------------- unsorted (inbox)

// "Unsorted" is per board; "Quick notes" is one inbox shared by every board.
export function InboxPanel({ scope = 'board' }: { scope?: 'board' | 'quick' }) {
  const boardId = useStore((s) => s.boardId);
  const holder = scope === 'quick' ? QUICK_PARENT : boardId;
  const key = useStore((s) =>
    Object.values(s.elements)
      .filter((e) => e.section === 'inbox' && e.parentId === (scope === 'quick' ? QUICK_PARENT : s.boardId))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((e) => e.id)
      .join(','),
  );
  const ids = key ? key.split(',') : [];
  const [ghost, setGhost] = useState<{ id: string; x: number; y: number } | null>(null);

  const [draft, setDraft] = useState('');
  const add = () => {
    const text = draft.trim();
    if (!text) return;
    const html = text
      .split('\n')
      .map((l) => `<p>${l.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</p>`)
      .join('');
    addElements([makeElement('note', { section: 'inbox', parentId: holder, content: { html } })], { select: false });
    setDraft('');
  };

  // Drag a card out of the panel onto the board.
  const onPointerDown = (e: RPointerEvent, id: string) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const start = { x: e.clientX, y: e.clientY };
    let moved = false;
    const move = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 5) return;
      moved = true;
      setGhost({ id, x: ev.clientX, y: ev.clientY });
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setGhost(null);
      if (!moved || !isOverCanvas(ev.clientX, ev.clientY)) return;
      const p = screenToWorld(ev.clientX, ev.clientY);
      const el = getState().elements[id];
      if (!el) return;
      const column = columnAt(p);
      patchElement(id, {
        section: 'canvas',
        parentId: boardId,
        x: Math.round(p.x - 40),
        y: Math.round(p.y - 20),
        columnId: column?.id ?? null,
        order: column ? Date.now() : el.order,
        z: Math.max(0, ...Object.values(getState().elements).filter((x) => x.parentId === boardId).map((x) => x.z)) + 1,
      });
      setState({ selection: [id] });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <aside className="side-panel inbox-panel" aria-label={scope === 'quick' ? t('Quick notes') : t('Unsorted')}>
      <div className="side-head">
        <h2>{scope === 'quick' ? t('Quick notes') : t('Unsorted')}</h2>
        <button className="icon-btn" onClick={close} title={t('Close')}>
          ✕
        </button>
      </div>
      {scope === 'quick' ? (
        <p className="side-sub">{t('Jot things down from any device — your phone included — and sort them onto a board later. Drag a note onto any board.')}</p>
      ) : (
        <p className="side-sub">
          {t('A place to put things while you decide where they should go. Drag cards onto the board; press')} <kbd>U</kbd> {t('to send selected cards here.')}
        </p>
      )}
      <div className="inbox-list scrollable">
        {ids.length === 0 && <div className="trash-empty">{scope === 'quick' ? t('No quick notes yet.') : t('Nothing unsorted on this board.')}</div>}
        {ids.map((id) => (
          <InboxCard key={id} id={id} onPointerDown={onPointerDown} dragging={ghost?.id === id} />
        ))}
      </div>
      <div className="side-foot quick-add">
        <textarea
          value={draft}
          rows={2}
          placeholder={t('Quick note… (Enter to add)')}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              add();
            }
          }}
        />
        <button onClick={add} disabled={!draft.trim()}>
          {t('Add')}
        </button>
      </div>
      {ghost && (
        <div className="tool-ghost" style={{ left: ghost.x, top: ghost.y }}>
          {t(TYPE_LABEL[getState().elements[ghost.id]?.type ?? 'note'])}
        </div>
      )}
    </aside>
  );
}

function InboxCard({ id, onPointerDown, dragging }: { id: string; onPointerDown(e: RPointerEvent, id: string): void; dragging: boolean }) {
  const el = useStore((s) => s.elements[id]);
  if (!el) return null;
  return (
    <div className={`inbox-card item item-${el.type} in-column ${dragging ? 'drag-source' : ''}`} onPointerDown={(e) => onPointerDown(e, id)}>
      <ElementBody el={el} editing={false} selected={false} />
      <div className="inbox-actions">
        <button
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => {
            const r = canvasRect();
            const p = screenToWorld((r?.left ?? 0) + (r?.width ?? 800) / 2, (r?.top ?? 0) + (r?.height ?? 600) / 2);
            patchElement(id, { section: 'canvas', parentId: getState().boardId, x: Math.round(p.x - 130), y: Math.round(p.y - 60), columnId: null });
          }}
        >
          {t('Add to board')}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- export

export function ExportPanel() {
  const boardId = useStore((s) => s.boardId);
  const [subBoards, setSubBoards] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const title = boardPath(boardId).slice(-1)[0].title;
  const run = async (label: string, fn: () => Promise<void> | void) => {
    setBusy(label);
    try {
      await fn();
    } finally {
      setBusy(null);
    }
  };
  return (
    <aside className="side-panel" aria-label={t('Export')}>
      <div className="side-head">
        <h2>{t('Export board')}</h2>
        <button className="icon-btn" onClick={close} title={t('Close')}>
          ✕
        </button>
      </div>
      <p className="side-sub">“{title}”</p>
      <div className="export-section">
        <h3>{t('Export the current board layout')}</h3>
        <button disabled={!!busy} onClick={() => run('png', () => exportBoardPng(boardId, 2))}>
          {busy === 'png' ? t('Generating…') : t('PNG image')}
        </button>
        <button disabled={!!busy} onClick={() => run('pdf', () => exportBoardPng(boardId, 2, true))}>
          {busy === 'pdf' ? t('Generating…') : t('PDF (print)')}
        </button>
      </div>
      <div className="export-section">
        <h3>{t('Convert to a linear document')}</h3>
        <label className="check">
          <input type="checkbox" checked={subBoards} onChange={(e) => setSubBoards(e.target.checked)} /> {t('Include sub-boards')}
        </label>
        <button onClick={() => exportBoardMarkdown(boardId, subBoards)}>{t('Markdown')}</button>
        <button onClick={() => exportBoardText(boardId, subBoards)}>{t('Plain text')}</button>
        <button onClick={() => exportBoardWord(boardId, subBoards)}>{t('Word document')}</button>
      </div>
      <div className="export-section">
        <h3>{t('Download all images and files')}</h3>
        <a className="button-like" href={`/api/board-files/${boardId}`} download>
          {t('Generate ZIP file')}
        </a>
      </div>
      <div className="export-section">
        <h3>{t('Link')}</h3>
        <button onClick={() => copyText(boardUrl(boardId), 'Board link copied')}>{t('Copy a link to this board')}</button>
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------- templates

export function TemplatesPanel() {
  const boardId = useStore((s) => s.boardId);
  const key = useStore((s) =>
    Object.values(s.elements)
      .filter((e) => e.parentId === TEMPLATES_PARENT && e.type === 'board' && e.section === 'canvas')
      .map((e) => `${e.id}:${e.updatedAt}`)
      .join(','),
  );
  const templates = key ? key.split(',').map((k) => getState().elements[k.split(':')[0]] as ElementOf<'board'>) : [];
  const [query, setQuery] = useState('');
  const [keepContent, setKeepContent] = useState(true);
  const shown = templates.filter((t) => t.content.title.toLowerCase().includes(query.toLowerCase()));

  const use = (template: ElementOf<'board'> | null) => {
    const r = canvasRect();
    const p = screenToWorld((r?.left ?? 0) + (r?.width ?? 800) / 2, (r?.top ?? 0) + (r?.height ?? 600) / 2);
    if (!template) {
      const board = makeElement('board', { x: Math.round(p.x - 55), y: Math.round(p.y - 50) });
      addElements([board], { edit: true });
      close();
      return;
    }
    const board = cloneTemplate(template, boardId, keepContent);
    board.x = Math.round(p.x - 55);
    board.y = Math.round(p.y - 50);
    close();
    setState({ selection: [board.id] });
  };

  return (
    <aside className="side-panel" aria-label={t('Templates')}>
      <div className="side-head">
        <h2>{t('Choose a template')}</h2>
        <button className="icon-btn" onClick={close} title={t('Close')}>
          ✕
        </button>
      </div>
      <input className="palette-input" placeholder={t('Search templates...')} value={query} onChange={(e) => setQuery(e.target.value)} />
      <ul className="trash-list scrollable">
        <li>
          <button className="template-row" onClick={() => use(null)}>
            <span className="board-icon small">▦</span> {t('Empty board')}
          </button>
        </li>
        {STARTER_TEMPLATES.filter((tpl) => tpl.title.toLowerCase().includes(query.toLowerCase())).map((tpl) => (
          <li key={tpl.id}>
            <button
              className="template-row"
              onClick={() => {
                const r = canvasRect();
                const p = screenToWorld((r?.left ?? 0) + (r?.width ?? 800) / 2, (r?.top ?? 0) + (r?.height ?? 600) / 2);
                applyStarterTemplate(tpl.id, { x: p.x - 55, y: p.y - 50 }, keepContent);
                close();
              }}
              title={t(tpl.description)}
            >
              <span className="board-icon small">{tpl.icon}</span> {t(tpl.title)}
              <span className="label-chip small tag-top">{t('Top pick')}</span>
            </button>
          </li>
        ))}
        <li className="template-group">{t('Your custom templates')}</li>
        {shown.length === 0 && (
          <li className="trash-empty">{templates.length ? t('No templates found') : t('Right-click any board and choose “Convert to Template” to make your own.')}</li>
        )}
        {shown.map((tpl) => (
          <li key={tpl.id}>
            <div className="template-line">
              <button className="template-row" onClick={() => use(tpl)}>
                <span className="board-icon small">{tpl.content.icon || '▦'}</span> {tpl.content.title || t('Untitled template')}
                <span className="label-usage">{t('{n} cards', { n: dependents(tpl.id).length })}</span>
              </button>
              <button className="icon-btn small" title={t('Revert template to board')} onClick={() => revertTemplate(tpl.id, boardId)}>
                ↩
              </button>
            </div>
          </li>
        ))}
      </ul>
      <div className="side-foot">
        <label className="check">
          <input type="checkbox" checked={keepContent} onChange={(e) => setKeepContent(e.target.checked)} /> {t('Keep example content')}
        </label>
      </div>
    </aside>
  );
}

// Copies a template board (and everything in it) into `boardId`, returning the new board.
function cloneTemplate(template: ElementOf<'board'>, boardId: string, keepContent: boolean): ElementOf<'board'> {
  const { elements } = getState();
  const ids = [template.id, ...dependents(template.id)];
  const idMap = new Map(ids.map((id) => [id, uid()]));
  const now = Date.now();
  const copies: El[] = [];
  for (const id of ids) {
    const el = elements[id];
    if (!el || el.section !== 'canvas') continue;
    const copy = structuredClone(el) as El;
    copy.id = idMap.get(id)!;
    copy.parentId = id === template.id ? boardId : idMap.get(el.parentId) ?? el.parentId;
    copy.columnId = el.columnId ? idMap.get(el.columnId) ?? null : null;
    copy.createdAt = copy.updatedAt = now;
    if (copy.type === 'board' && id === template.id) copy.content = { ...copy.content, template: false };
    if (copy.type === 'line') {
      const c = copy.content;
      copy.content = { ...c, from: { ...c.from, id: c.from.id ? idMap.get(c.from.id) ?? null : null }, to: { ...c.to, id: c.to.id ? idMap.get(c.to.id) ?? null : null } };
    }
    if (!keepContent && id !== template.id) {
      if (copy.type === 'note') copy.content = { html: '' };
      if (copy.type === 'todo') copy.content = { ...copy.content, items: copy.content.items.map((i) => ({ ...i, text: '', done: false })) };
    }
    copies.push(copy);
  }
  addElements(copies, { select: false });
  return copies.find((c) => c.id === idMap.get(template.id)) as ElementOf<'board'>;
}

export function convertToTemplate(id: string) {
  const el = getState().elements[id];
  if (el?.type !== 'board') return;
  commit({ [id]: { ...el, parentId: TEMPLATES_PARENT, columnId: null, content: { ...el.content, template: true }, updatedAt: Date.now() } });
  setState({ selection: [] });
}

function revertTemplate(id: string, boardId: string) {
  const el = getState().elements[id];
  if (el?.type !== 'board') return;
  const r = allRects();
  const box = r.size ? union([...r.values()]) : { x: 0, y: 0, w: 0, h: 0 };
  commit({ [id]: { ...el, parentId: boardId, x: Math.round(box.x + box.w + 60), y: Math.round(box.y), content: { ...el.content, template: false }, updatedAt: Date.now() } });
}

// ---------------------------------------------------------------- settings

export function SettingsPanel() {
  const boardId = useStore((s) => s.boardId);
  const theme = useStore((s) => s.theme);
  const board = useStore((s) => s.elements[boardId]);
  const [prefs, setPrefs] = useState(getToolbarPrefs());
  const [loc, setLoc] = useState(getLocaleSettings());
  const updateLoc = (patch: Partial<LocaleSettings>) => {
    setLocaleSettings(patch);
    setLoc(getLocaleSettings());
  };
  const [scale, setScale] = useState(() => Number(localStorage.getItem('cn:ui-scale') || 1));
  const appearance = board?.type === 'board' ? board.content : { background: null, hideGrid: false };

  const setBoard = (patch: { background?: string | null; hideGrid?: boolean }) => {
    const existing = getState().elements[boardId];
    if (existing?.type === 'board') {
      patchElement(boardId, { content: patch });
    } else if (boardId === ROOT_ID) {
      // Home isn't an element, so its appearance lives on a hidden 'root' board element.
      const root = makeElement('board', { id: ROOT_ID, parentId: SYSTEM_PARENT, content: { title: 'Home', ...patch } });
      addElements([root], { select: false });
    }
  };

  const applyScale = (v: number) => {
    setScale(v);
    try {
      localStorage.setItem('cn:ui-scale', String(v));
    } catch {}
    document.documentElement.style.setProperty('--ui-scale', String(v));
  };

  return (
    <aside className="side-panel" aria-label={t('Settings')}>
      <div className="side-head">
        <h2>{t('Settings')}</h2>
        <button className="icon-btn" onClick={close} title={t('Close')}>
          ✕
        </button>
      </div>
      <div className="export-section">
        <h3>{t('Appearance')}</h3>
        <div className="menu-row">
          {(['system', 'light', 'dark'] as const).map((mode) => (
            <button key={mode} className={theme === mode ? 'active' : ''} onClick={() => setTheme(mode)}>
              {mode === 'system' ? t('Match system') : mode === 'light' ? t('Light') : t('Dark')}
            </button>
          ))}
        </div>
        <label className="check">
          {t('Interface size')}
          <input type="range" min="0.8" max="1.4" step="0.1" value={scale} onChange={(e) => applyScale(Number(e.target.value))} />
          <span>{Math.round(scale * 100)}%</span>
        </label>
      </div>
      <div className="export-section">
        <h3>{t('Localization')}</h3>
        <label className="field">
          {t('Language')}
          <select value={getLang()} onChange={(e) => setLang(e.target.value as Lang)}>
            {LANGUAGES.map((l) => (
              <option key={l.id} value={l.id}>
                {l.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          {t('Numbers & dates (in tables)')}
          <select value={loc.format} onChange={(e) => updateLoc({ format: e.target.value })}>
            {FORMAT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.value ? o.label : t(o.label)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          {t('Currency')}
          <select value={loc.currency} onChange={(e) => updateLoc({ currency: e.target.value })}>
            {CURRENCY_OPTIONS.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          {t('Time')}
          <select value={loc.time} onChange={(e) => updateLoc({ time: e.target.value as LocaleSettings['time'] })}>
            <option value="">{t('Follow the format above')}</option>
            <option value="12">{t('12 hour (e.g. 10:10pm)')}</option>
            <option value="24">{t('24 hour (e.g. 22:10)')}</option>
          </select>
        </label>
      </div>
      <div className="export-section">
        <h3>{t('This board’s background')}</h3>
        <div className="menu-colors">
          {[null, '#f6f1e7', '#e8eef5', '#eaf3ea', '#f5e9ee', '#ece8f6', '#2b2d31', '#16324f'].map((c) => (
            <button
              key={c ?? 'default'}
              className={`swatch-dot ${c ? '' : 'no-color'} ${(appearance.background ?? null) === c ? 'active' : ''}`}
              style={c ? { background: c } : undefined}
              title={c ?? t('Revert to default')}
              onClick={() => setBoard({ background: c })}
            />
          ))}
          <input type="color" value={appearance.background || '#eeece8'} onChange={(e) => setBoard({ background: e.target.value })} title={t('Choose custom colour')} />
        </div>
        <label className="check">
          <input type="checkbox" checked={!appearance.hideGrid} onChange={(e) => setBoard({ hideGrid: !e.target.checked })} /> {t('Show dot grid')}
        </label>
      </div>
      <div className="export-section">
        <h3>{t('Toolbar')}</h3>
        <p className="side-sub">{t('Choose which tools appear in the left toolbar.')}</p>
        <div className="toolbar-prefs">
          {ALL_TOOL_IDS.map((id) => (
            <label key={id} className="check">
              <input
                type="checkbox"
                checked={!prefs.hidden.includes(id)}
                onChange={(e) => {
                  const hidden = e.target.checked ? prefs.hidden.filter((h) => h !== id) : [...prefs.hidden, id];
                  setPrefs({ hidden });
                  setToolbarPrefs({ hidden });
                }}
              />
              {t(TOOL_LABELS[id])}
            </label>
          ))}
        </div>
      </div>
      <div className="export-section">
        <h3>{t('Labels')}</h3>
        <button onClick={() => setState({ modal: { kind: 'labels', ids: [] } })}>{t('Manage labels…')}</button>
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------- shortcuts

const SHORTCUT_SECTIONS: [string, [string, string][]][] = [
  [
    'The basics',
    [
      ['Double-click the board', 'New note'],
      ['Click a selected card / Enter', 'Edit it'],
      ['Esc', 'Deselect / stop editing'],
      ['Shift + click, or drag on empty space', 'Multi-select'],
      ['Ctrl A', 'Select all'],
      ['Ctrl D', 'Duplicate'],
      ['Ctrl C / Ctrl X / Ctrl V', 'Copy / cut / paste (cards, text, links, images)'],
      ['Ctrl Alt C / Ctrl Alt V', 'Copy / paste styles'],
      ['Delete / Backspace', 'Move to Trash'],
      ['U', 'Move to Unsorted'],
      ['Arrow keys (Shift for 10×)', 'Nudge an object'],
      ['Ctrl ] / Ctrl [', 'Bring forward / send back'],
      ['Ctrl Z / Ctrl Shift Z', 'Undo / redo'],
      ['L', 'Line tool'],
      ['D', 'New sketch'],
    ],
  ],
  [
    'Navigation',
    [
      ['Ctrl K', 'Search'],
      ['Ctrl E', 'View recent boards'],
      ['Backspace (nothing selected)', 'Go to parent board'],
      ['Alt ← / Alt →', 'Go back / forward'],
      ['Ctrl + double-click a board', 'Open board in new tab'],
      ['Space + drag, middle-drag, or scroll', 'Move around the board'],
      ['Arrow keys, nothing selected (Shift for faster)', 'Move around the board'],
      ['Ctrl Shift P', 'Presentation mode'],
    ],
  ],
  [
    'Zoom',
    [
      ['Ctrl + scroll, Ctrl + / Ctrl −', 'Zoom in / out'],
      ['Ctrl 0', 'Reset to 100%'],
      ['Shift 1', 'Scale to fit'],
    ],
  ],
  [
    'Appearance',
    [
      ['Ctrl Shift D', 'Toggle dark mode'],
      ['Ctrl Shift = / Ctrl Shift −', 'Larger / smaller interface'],
    ],
  ],
  [
    'Text formatting',
    [
      ['Ctrl B / Ctrl I / Ctrl U', 'Bold / italic / underline'],
      ['Ctrl Shift S', 'Strikethrough'],
      ['Ctrl Shift H', 'Highlight'],
      ['Ctrl K (while editing)', 'Hyperlink'],
      ['Tab / Shift Tab', 'Indent / un-indent'],
    ],
  ],
  [
    'Markdown (at the start of a new line)',
    [
      ['# space / ## space', 'Large / normal heading'],
      ['* space / 1. space', 'Bullet / numbered list'],
      ['[] space', 'Checkbox'],
      ['> space', 'Quote'],
      ['! space', 'Callout'],
      ['``` space', 'Code block'],
      ['---', 'Horizontal divider line'],
    ],
  ],
  [
    'To-do lists',
    [
      ['Enter', 'New task'],
      ['Tab / Shift Tab', 'Indent / un-indent a task'],
      ['📅 while editing', 'Add a due date'],
    ],
  ],
  [
    'Drawing',
    [
      ['P / E', 'Pen / eraser'],
      ['V', 'Switch to selection tool (drag to select, move, Delete)'],
      ['I', 'Colour eyedropper'],
      ['C', 'Toggle colour palette'],
      ['[ / ]', 'Change pen size'],
      ['X', 'Change to previous colour'],
      ['Esc or Ctrl S', 'Save current drawing'],
    ],
  ],
];

export function ShortcutsPanel() {
  return (
    <div className="overlay" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div className="dialog shortcuts-dialog" role="dialog" aria-label={t('Keyboard shortcuts')}>
        <div className="side-head">
          <h2>{t('Shortcuts')}</h2>
          <button className="icon-btn" onClick={close} title={t('Close')}>
            ✕
          </button>
        </div>
        <div className="shortcut-sections scrollable">
          {SHORTCUT_SECTIONS.map(([title, rows]) => (
            <section key={title}>
              <h3>{t(title)}</h3>
              <dl className="shortcut-list">
                {rows.map(([k, v]) => (
                  <div key={k}>
                    <dt>{t(k)}</dt>
                    <dd>{t(v)}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

export function Toast() {
  const toast = useStore((s) => s.toast);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!toast) return;
    setVisible(true);
    const t = setTimeout(() => setVisible(false), 2600);
    return () => clearTimeout(t);
  }, [toast]);
  if (!toast || !visible) return null;
  return (
    <div className="toast" role="status">
      {toast.text}
    </div>
  );
}

export const HIDDEN_PARENTS = new Set([LABELS_PARENT, TEMPLATES_PARENT, SYSTEM_PARENT]);
