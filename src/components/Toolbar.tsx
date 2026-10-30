import { useEffect, useRef, useState, type PointerEvent as RPointerEvent, type ReactNode } from 'react';
import { createElement, columnAt, centerPlacement, pickFiles, addFiles } from '../actions';
import { getState, setHand, setState, useStore } from '../store';
import type { ElementType } from '../types';
import { isOverCanvas, screenToWorld } from '../viewport';
import { getToolbarPrefs, onToolbarPrefs, type ToolId, TOOL_LABELS } from './toolbarPrefs';
import { newFolder } from '../moreActions';
import { t } from '../i18n';

interface Tool {
  id: ToolId;
  // Pseudo-types open a dialog or build a special card instead of a plain element.
  type: ElementType | 'folder' | 'imageSearch' | 'aiIdeas';
  kind?: 'video' | 'audio' | 'map';
  icon: ReactNode;
  hint: string;
}

const I = ({ d, children }: { d?: string; children?: ReactNode }) => (
  <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {d ? <path d={d} /> : children}
  </svg>
);

const TOOLS: Tool[] = [
  { id: 'note', type: 'note', hint: 'Rich text note', icon: <I><rect x="5" y="3.5" width="14" height="17" rx="2" /><path d="M8.5 8h7M8.5 11.5h7M8.5 15h4" /></I> },
  { id: 'link', type: 'link', hint: 'Web link with preview', icon: <I d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1" /> },
  { id: 'todo', type: 'todo', hint: 'Checklist with due dates', icon: <I><rect x="4" y="4.5" width="5" height="5" rx="1" /><path d="M5.3 7l1 1 1.6-1.8M12 7h8M12 16h8" /><rect x="4" y="13.5" width="5" height="5" rx="1" /></I> },
  { id: 'line', type: 'line', hint: 'Connect cards with an arrow (L)', icon: <I d="M5 19L19 5M19 5h-6M19 5v6" /> },
  { id: 'board', type: 'board', hint: 'A board inside this board', icon: <I><rect x="3.5" y="4" width="7" height="9" rx="1.2" /><rect x="13.5" y="4" width="7" height="5" rx="1.2" /><rect x="13.5" y="11.5" width="7" height="8.5" rx="1.2" /><rect x="3.5" y="15.5" width="7" height="4.5" rx="1.2" /></I> },
  { id: 'column', type: 'column', hint: 'Stack cards in a column', icon: <I><rect x="6" y="3.5" width="12" height="17" rx="2" /><path d="M9 7.5h6M9 11.5h6M9 15.5h6" /></I> },
  { id: 'comment', type: 'comment', hint: 'Comment thread', icon: <I d="M4 5h16v11H9l-5 4z" /> },
  { id: 'table', type: 'table', hint: 'Table with formulas', icon: <I><rect x="3.5" y="5" width="17" height="14" rx="1.5" /><path d="M3.5 10h17M3.5 14.5h17M9.5 5v14M15 5v14" /></I> },
  { id: 'image', type: 'image', hint: 'Upload images', icon: <I><rect x="3.5" y="5" width="17" height="14" rx="2" /><circle cx="9" cy="10" r="1.6" /><path d="M20.5 16l-5-5-8 8" /></I> },
  { id: 'file', type: 'file', hint: 'Upload any file', icon: <I d="M12 16V4M7 9l5-5 5 5M5 20h14" /> },
  { id: 'sketch', type: 'sketch', hint: 'Freehand sketch (D)', icon: <I d="M4 20c3-1 4-5 7-8s5-6 8-7c-1 3-4 5-7 8s-5 6-8 7zM14 6l4 4" /> },
  { id: 'document', type: 'document', hint: 'Long-form document', icon: <I><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v4h4M9 12h6M9 15.5h6" /></I> },
  { id: 'heading', type: 'heading', hint: 'Large heading text', icon: <I d="M6 5v14M18 5v14M6 12h12" /> },
  { id: 'swatch', type: 'swatch', hint: 'Colour swatch', icon: <I><circle cx="12" cy="12" r="8" /><path d="M12 4a8 8 0 0 0 0 16z" fill="currentColor" stroke="none" /></I> },
  { id: 'video', type: 'link', kind: 'video', hint: 'YouTube or Vimeo video', icon: <I><rect x="3" y="5.5" width="18" height="13" rx="2.5" /><path d="M10 9.5v5l4.5-2.5z" fill="currentColor" /></I> },
  { id: 'audio', type: 'link', kind: 'audio', hint: 'Spotify or SoundCloud', icon: <I d="M9 18V6l10-2v12M9 18a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0zM19 16a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0z" /> },
  { id: 'map', type: 'link', kind: 'map', hint: 'Google Maps location', icon: <I d="M12 21s-6-5.5-6-11a6 6 0 0 1 12 0c0 5.5-6 11-6 11zM12 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z" /> },
  { id: 'folder', type: 'folder', hint: 'A folder that holds cards', icon: <I d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" /> },
  { id: 'imageSearch', type: 'imageSearch', hint: 'Search free images', icon: <I><circle cx="10.5" cy="10.5" r="6" /><path d="M20 20l-5-5M8 11l2-2 3 3" /></I> },
  { id: 'aiIdeas', type: 'aiIdeas', hint: 'Brainstorm ideas with Claude', icon: <I d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8zM18 15l.9 2.1L21 18l-2.1.9L18 21l-.9-2.1L15 18l2.1-.9z" /> },
];

export function useToolbarPrefs() {
  const [prefs, setPrefs] = useState(getToolbarPrefs());
  useEffect(() => {
    const off = onToolbarPrefs(() => setPrefs(getToolbarPrefs()));
    return () => {
      off();
    };
  }, []);
  return prefs;
}

export function Toolbar() {
  const [ghost, setGhost] = useState<{ tool: Tool; x: number; y: number } | null>(null);
  const activeTool = useStore((s) => s.tool);
  const panel = useStore((s) => s.panel);
  const trashCount = useStore((s) => Object.values(s.elements).filter((e) => e.section === 'trash').length);
  const inboxCount = useStore((s) => Object.values(s.elements).filter((e) => e.section === 'inbox' && e.parentId === s.boardId).length);
  const prefs = useToolbarPrefs();
  const dragging = useRef(false);

  const create = (tool: Tool, at: ReturnType<typeof centerPlacement>) => {
    if (tool.type === 'folder') return newFolder(at);
    if (tool.type === 'imageSearch') return setState({ modal: { kind: 'imageSearch', at } });
    if (tool.type === 'aiIdeas') return setState({ modal: { kind: 'aiIdeas', at } });
    createElement(tool.type, at, { kind: tool.kind });
  };

  const activate = (tool: Tool) => {
    if (tool.type === 'line') {
      setState({ tool: getState().tool === 'line' ? null : 'line', selection: [], editingId: null });
      return;
    }
    create(tool, centerPlacement());
  };

  const dropAt = (tool: Tool, clientX: number, clientY: number) => {
    if (!isOverCanvas(clientX, clientY)) return;
    const p = screenToWorld(clientX, clientY);
    const column = columnAt(p);
    const at = { x: p.x - 30, y: p.y - 20, ...(column ? { columnId: column.id, index: column.index } : {}) };
    if (tool.type === 'image' || tool.type === 'file') {
      pickFiles(tool.type === 'image' ? 'image/*' : '*/*', (files) => addFiles(files, at));
    } else {
      create(tool, at);
    }
  };

  // Dragging a tool onto the board creates it where it is dropped; a plain click is handled by onClick.
  const onPointerDown = (e: RPointerEvent, tool: Tool) => {
    if (e.button !== 0 || tool.type === 'line') return;
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    dragging.current = false;
    const move = (ev: PointerEvent) => {
      if (!dragging.current && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 6) return;
      dragging.current = true;
      setGhost({ tool, x: ev.clientX, y: ev.clientY });
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setGhost(null);
      if (dragging.current) dropAt(tool, ev.clientX, ev.clientY);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const onClick = (tool: Tool) => {
    if (dragging.current) {
      dragging.current = false;
      return;
    }
    activate(tool);
  };

  const togglePanel = (p: 'trash' | 'inbox' | 'templates' | 'settings') => setState({ panel: getState().panel === p ? null : p });

  return (
    <>
      <nav className="toolbar" aria-label={t('Add to board')}>
        {TOOLS.filter((t) => !prefs.hidden.includes(t.id)).map((tool) => (
          <button
            key={tool.id}
            className={`tool ${activeTool === tool.type ? 'active' : ''}`}
            title={t('{hint} — click or drag onto the board', { hint: t(tool.hint) })}
            onPointerDown={(e) => {
              // Adding a card means editing again: leave Move mode.
              if (getState().hand) setHand(false);
              onPointerDown(e, tool);
            }}
            onClick={() => onClick(tool)}
          >
            {tool.icon}
            <span>{t(TOOL_LABELS[tool.id])}</span>
          </button>
        ))}
        <button className="tool tool-more" title={t('Choose which tools to show')} onClick={() => togglePanel('settings')}>
          <I d="M5 12h.01M12 12h.01M19 12h.01" />
          <span>{t('More')}</span>
        </button>
        <div className="toolbar-spacer" />
        <button className={`tool ${panel === 'templates' ? 'active' : ''}`} title={t('Templates')} onClick={() => togglePanel('templates')}>
          <I><rect x="4" y="4" width="16" height="16" rx="2" /><path d="M4 9h16M9 9v11" /></I>
          <span>{t('Templates')}</span>
        </button>
        <button className={`tool ${panel === 'inbox' ? 'active' : ''}`} title={t('Unsorted (U moves selected cards here)')} onClick={() => togglePanel('inbox')}>
          <I d="M4 13l2.5-8h11L20 13v6H4zM4 13h5l1 2h4l1-2h5" />
          <span>{t('Unsorted')}{inboxCount ? ` ${inboxCount}` : ''}</span>
        </button>
        <button className={`tool ${panel === 'trash' ? 'active' : ''}`} title={t('Trash')} onClick={() => togglePanel('trash')}>
          <I d="M4 7h16M9 7V4.5h6V7M6.5 7l1 13h9l1-13M10 11v5.5M14 11v5.5" />
          <span>{t('Trash')}{trashCount ? ` ${trashCount}` : ''}</span>
        </button>
      </nav>
      {ghost && (
        <div className="tool-ghost" style={{ left: ghost.x, top: ghost.y }}>
          {ghost.tool.icon}
          <span>{t(TOOL_LABELS[ghost.tool.id])}</span>
        </div>
      )}
    </>
  );
}
