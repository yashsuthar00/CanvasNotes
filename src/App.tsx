import { useEffect, useState } from 'react';
import { onLocaleChange } from './locale';
import { onLangChange } from './i18n';
import {
  boardPath,
  commit,
  getState,
  load,
  makeElement,
  addElements,
  maxZ,
  navigate,
  patchElements,
  redo,
  setState,
  setTheme,
  startEditing,
  trashElements,
  undo,
  useStore,
  subscribeState,
  loadPublic,
  toast,
} from './store';
import { Canvas } from './components/Canvas';
import { Toolbar } from './components/Toolbar';
import { TopBar } from './components/TopBar';
import { seedWelcomeBoard } from './moreActions';
import { ExportPanel, InboxPanel, SearchPalette, SettingsPanel, ShortcutsPanel, TemplatesPanel, Toast, TrashPanel, markViewed } from './components/Panels';
import { ModalHost } from './components/Modals';
import { Presentation } from './components/Presentation';
import {
  addFiles,
  addLink,
  addTextNote,
  clipboardTextIsInternal,
  columnAt,
  copySelection,
  copyStyle,
  duplicate,
  isBlank,
  isUrl,
  moveToInbox,
  pasteInternal,
  pasteStyle,
  centerPlacement,
  fetchLinkPreview,
} from './actions';
import { openDrawing } from './elements/Sketch';
import { bufferPendingKey } from './elements/RichText';
import { jumpToArea } from './areas';
import { allRects, fitRects, getViewport, setViewport, startKeyPan, stopKeyPan, zoomAt } from './viewport';
import type { El } from './types';
import { t } from './i18n';

function isTyping(target: EventTarget | null) {
  const el = target as HTMLElement | null;
  return !!el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));
}

// Where pasted things land: the last pointer position over the board, or the view centre.
let lastPointer: { x: number; y: number } | null = null;
window.addEventListener('pointermove', (e) => {
  lastPointer = { x: e.clientX, y: e.clientY };
});

function pastePlacement() {
  const canvas = document.querySelector('.canvas')?.getBoundingClientRect();
  if (lastPointer && canvas && lastPointer.x > canvas.left && lastPointer.y > canvas.top && lastPointer.x < canvas.right && lastPointer.y < canvas.bottom) {
    const vp = getViewport(getState().boardId);
    const x = (lastPointer.x - canvas.left - vp.x) / vp.zoom;
    const y = (lastPointer.y - canvas.top - vp.y) / vp.zoom;
    const column = columnAt({ x, y });
    return { x, y, ...(column ? { columnId: column.id, index: column.index } : {}) };
  }
  return centerPlacement();
}

// Discard notes and lists left empty when editing stops, like Milanote does.
let previousEditing: string | null = null;
subscribeState(() => {
  const { editingId, elements } = getState();
  if (editingId === previousEditing) return;
  const prev = previousEditing ? elements[previousEditing] : undefined;
  previousEditing = editingId;
  if (prev && isBlank(prev)) commit({ [prev.id]: null }, { history: false });
});

function setUiScale(delta: number) {
  const current = Number(localStorage.getItem('cn:ui-scale') || 1);
  const next = Math.round(Math.min(1.4, Math.max(0.8, current + delta)) * 10) / 10;
  try {
    localStorage.setItem('cn:ui-scale', String(next));
  } catch {}
  document.documentElement.style.setProperty('--ui-scale', String(next));
}

function onKeyDown(e: KeyboardEvent) {
  const state = getState();
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();

  if (state.modal) return; // modals handle their own keys
  // A published board can be searched, zoomed and panned, nothing else.
  const pan = e.key.startsWith('Arrow') && !mod && !e.altKey;
  const areaKey = e.key.toLowerCase() === 'n' && !mod && !e.altKey;
  if (state.readOnly && !(e.ctrlKey || e.metaKey) && !['Escape', '?'].includes(e.key) && !(e.shiftKey && e.code === 'Digit1') && !pan && !areaKey) return;
  if (mod && key === 'k' && !isTyping(e.target)) {
    e.preventDefault();
    setState({ panel: state.panel === 'search' ? null : 'search' });
    return;
  }
  if (mod && key === 'e') {
    e.preventDefault();
    setState({ panel: 'search' });
    return;
  }
  if (state.presenting) return; // presentation mode handles its own keys
  if (state.panel && e.key === 'Escape') {
    setState({ panel: null });
    return;
  }
  if (mod && e.shiftKey && key === 'd') {
    e.preventDefault();
    setTheme(document.documentElement.getAttribute('data-theme') === 'dark' || (state.theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches) ? 'light' : 'dark');
    return;
  }
  if (mod && e.shiftKey && (key === '+' || key === '=' || key === '_' || key === '-')) {
    e.preventDefault();
    setUiScale(key === '-' || key === '_' ? -0.1 : 0.1);
    return;
  }
  if (mod && e.shiftKey && key === 'p') {
    e.preventDefault();
    setState({ presenting: true, selection: [], editingId: null, panel: null });
    return;
  }
  if (isTyping(e.target) || state.panel === 'search') return;
  // While a card is opening for editing, keystrokes belong to it, not to the board's one-key shortcuts.
  if (state.editingId && !mod && e.key !== 'Escape') {
    const el = state.elements[state.editingId];
    if (e.key.length === 1 && (el?.type === 'note' || el?.type === 'document')) {
      e.preventDefault();
      bufferPendingKey(e.key);
    }
    return;
  }

  const { selection, boardId } = state;
  if (e.altKey && e.key === 'ArrowLeft') {
    history.back();
  } else if (e.altKey && e.key === 'ArrowRight') {
    history.forward();
  } else if (mod && e.altKey && key === 'c') {
    e.preventDefault();
    copyStyle();
  } else if (mod && e.altKey && key === 'v') {
    e.preventDefault();
    pasteStyle();
  } else if (mod && key === 'z') {
    e.preventDefault();
    if (e.shiftKey) redo();
    else undo();
  } else if (mod && key === 'y') {
    e.preventDefault();
    redo();
  } else if (mod && key === 'a') {
    e.preventDefault();
    const ids = Object.values(state.elements)
      .filter((el) => el.parentId === boardId && el.section === 'canvas' && !el.columnId)
      .map((el) => el.id);
    setState({ selection: ids, editingId: null });
  } else if (mod && key === 'd') {
    e.preventDefault();
    duplicate();
  } else if (mod && key === 'c') {
    if (copySelection()) e.preventDefault();
  } else if (mod && key === 'x') {
    if (copySelection()) {
      e.preventDefault();
      trashElements(selection);
    }
  } else if (mod && (e.key === ']' || e.key === '[')) {
    e.preventDefault();
    const zs = Object.values(state.elements).filter((el) => el.parentId === boardId).map((el) => el.z);
    let z = e.key === ']' ? maxZ() : Math.min(...zs) - selection.length - 1;
    patchElements(Object.fromEntries(selection.map((id) => [id, { z: e.key === ']' ? ++z : ++z }])));
  } else if (mod && (key === '=' || key === '+')) {
    e.preventDefault();
    zoomAt(boardId, 1.2);
  } else if (mod && key === '-') {
    e.preventDefault();
    zoomAt(boardId, 1 / 1.2);
  } else if (mod && key === '0') {
    e.preventDefault();
    setViewport(boardId, { ...getViewport(boardId), zoom: 1 });
  } else if (e.shiftKey && (e.key === '!' || e.code === 'Digit1')) {
    fitRects(boardId, [...allRects().values()]);
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    if (selection.length) {
      e.preventDefault();
      trashElements(selection);
    } else if (e.key === 'Backspace' && boardId !== 'root') {
      const path = boardPath(boardId);
      navigate(path[path.length - 2]?.id ?? 'root');
    }
  } else if (e.key === 'Escape') {
    setState({ selection: [], editingId: null, tool: null });
  } else if (e.key === 'Enter' && selection.length === 1) {
    e.preventDefault();
    const el = state.elements[selection[0]];
    if (el?.type === 'board') navigate(el.id);
    else if (el?.type === 'alias') navigate(el.content.boardId);
    else if (el?.type === 'sketch') openDrawing(el.id);
    else if (el?.type === 'document') setState({ modal: { kind: 'document', id: el.id } });
    else startEditing(selection[0]);
  } else if (key === 'l' && !mod) {
    setState({ tool: state.tool === 'line' ? null : 'line' });
  } else if (key === 'n' && !mod && !e.altKey) {
    const at = jumpToArea(e.shiftKey ? -1 : 1);
    if (at && at.total > 1) toast(t('Area {i} of {n}', { i: at.index + 1, n: at.total }));
  } else if (key === 'u' && !mod && selection.length) {
    moveToInbox(selection);
  } else if (key === 'd' && !mod) {
    const at = pastePlacement();
    const sketch = makeElement('sketch', { x: Math.round(at.x), y: Math.round(at.y) });
    addElements([sketch]);
    openDrawing(sketch.id);
  } else if (e.key === '?') {
    setState({ panel: 'shortcuts' });
  } else if (e.key.startsWith('Arrow') && selection.length) {
    e.preventDefault();
    const step = e.shiftKey ? 10 : 1;
    const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
    const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
    const patches: Record<string, Partial<El>> = {};
    for (const id of selection) {
      const el = state.elements[id];
      if (el && !el.columnId && el.type !== 'line' && !el.locked) patches[id] = { x: el.x + dx, y: el.y + dy };
    }
    patchElements(patches, { coalesce: 'nudge' });
  } else if (pan) {
    // Nothing selected: the arrows move around the board.
    e.preventDefault();
    startKeyPan(e.key, e.shiftKey);
  }
}

function onKeyUp(e: KeyboardEvent) {
  if (e.key.startsWith('Arrow')) stopKeyPan(e.key);
}

function onBlur() {
  stopKeyPan(); // a key released in another window never sends keyup here
}

function onPaste(e: ClipboardEvent) {
  const state = getState();
  if (isTyping(e.target) || state.panel || state.modal || state.readOnly) return;
  const data = e.clipboardData;
  if (!data) return;
  const at = pastePlacement();
  const files = [...data.files];
  if (files.length) {
    e.preventDefault();
    void addFiles(files, at);
    return;
  }
  const text = data.getData('text/plain');
  if (clipboardTextIsInternal(text) && pasteInternal(at)) {
    e.preventDefault();
    return;
  }
  if (!text.trim()) return;
  e.preventDefault();
  if (isUrl(text)) addLink(text, at);
  else addTextNote(text, at);
}

export function App() {
  const loaded = useStore((s) => s.loaded);
  const loadError = useStore((s) => s.loadError);
  const panel = useStore((s) => s.panel);
  const theme = useStore((s) => s.theme);
  const presenting = useStore((s) => s.presenting);
  // Re-render cards when number/date settings change.
  const [localeVersion, setLocaleVersion] = useState(0);
  useEffect(() => onLocaleChange(() => setLocaleVersion((v) => v + 1)), []);
  // Changing the interface language re-renders everything with the new strings.
  const [langVersion, setLangVersion] = useState(0);
  useEffect(() => onLangChange(() => setLangVersion((v) => v + 1)), []);
  const readOnly = useStore((s) => s.readOnly);
  const boardId = useStore((s) => s.boardId);
  const boardTitle = useStore((s) => {
    const path = boardPath(s.boardId);
    return path[path.length - 1].title;
  });

  useEffect(() => {
    document.documentElement.style.setProperty('--ui-scale', localStorage.getItem('cn:ui-scale') || '1');
    const publicToken = location.pathname.match(/^\/p\/([\w-]+)/)?.[1];
    if (publicToken) void loadPublic(publicToken);
    else
      void load().then(() => {
        if (getState().loaded && !getState().loadError) seedWelcomeBoard();
        // Finish link previews that were interrupted by a reload.
        for (const el of Object.values(getState().elements)) {
          if (el.type === 'link' && el.content.loading && el.content.url) void fetchLinkPreview(el.id, el.content.url);
        }
      });
    // A published board gets the keys too (onKeyDown lets it search, zoom and pan only).
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    window.addEventListener('paste', onPaste);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('paste', onPaste);
    };
  }, []);

  useEffect(() => {
    if (theme === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  useEffect(() => {
    document.title = boardId === 'root' ? 'Canvas Notes' : `${boardTitle} · Canvas Notes`;
    markViewed(boardId);
  }, [boardId, boardTitle]);

  if (loadError) {
    return (
      <div className="splash">
        <h1>{t('Couldn\'t reach the Canvas Notes server')}</h1>
        <p>{loadError}</p>
        <button onClick={() => void load()}>{t('Try again')}</button>
      </div>
    );
  }

  return (
    <div key={langVersion} className={`app ${presenting ? 'presenting' : ''} ${readOnly ? 'read-only' : ''}`}>
      {!presenting && <TopBar />}
      {readOnly && <div className="readonly-banner">{t('Read-only board · made with Canvas Notes')}</div>}
      <div className="main">
        {!presenting && !readOnly && <Toolbar />}
        {loaded ? <Canvas key={`${boardId}:${localeVersion}`} /> : <div className="splash">{t('Loading…')}</div>}
        {panel === 'trash' && <TrashPanel />}
        {panel === 'inbox' && <InboxPanel />}
        {panel === 'quick' && <InboxPanel scope="quick" />}
        {panel === 'export' && <ExportPanel />}
        {panel === 'templates' && <TemplatesPanel />}
        {panel === 'settings' && <SettingsPanel />}
      </div>
      {presenting && <Presentation />}
      {panel === 'search' && <SearchPalette />}
      {panel === 'shortcuts' && <ShortcutsPanel />}
      <ModalHost />
      <Toast />
    </div>
  );
}
