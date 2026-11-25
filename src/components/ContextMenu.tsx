import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { safeUrl } from '../sanitize';
import { getState, maxZ, navigate, patchElements, startEditing, trashElements, makeElement, addElements, setState, undo, redo, setTheme } from '../store';
import { CARD_COLORS, CAPTION_TYPES, ROOT_ID, SYSTEM_PARENT, type El, type ElementType } from '../types';
import {
  alignSelection,
  boardUrl,
  connectWithLines,
  convertElement,
  copySelection,
  copyStyle,
  copyText,
  createShortcut,
  deleteCompletedTasks,
  distributeSelection,
  duplicate,
  duplicateLinkedBoard,
  fetchLinkPreview,
  groupIntoColumn,
  moveToInbox,
  pasteInternal,
  pasteStyle,
  replaceImage,
  replacePreview,
  setLocked,
  createElement,
} from '../actions';
import { startRecording } from '../voice';
import { openDrawing } from '../elements/Sketch';
import {
  REACTIONS,
  attachComment,
  convertToSketch,
  createSyncedCopy,
  cropToGrid,
  exportElement,
  newFolder,
  newPlaceholder,
  toggleReaction,
  unsync,
} from '../moreActions';
import { uid } from '../store';
import type { MediaOptions } from '../types';
import { convertToTemplate, timeAgo } from './Panels';
import { t } from '../i18n';

export interface MenuState {
  x: number;
  y: number;
  targetIds: string[];
  world?: { x: number; y: number };
}

const COLORABLE = new Set<ElementType>(['note', 'column', 'board', 'todo', 'line', 'link', 'file', 'voice', 'heading', 'table', 'document', 'comment', 'sketch']);

// How many pointers are down right now (to tell whether a menu opened mid-press).
let pointersDown = 0;
window.addEventListener('pointerdown', () => pointersDown++, true);
window.addEventListener('pointerup', () => (pointersDown = Math.max(0, pointersDown - 1)), true);
window.addEventListener('pointercancel', () => (pointersDown = Math.max(0, pointersDown - 1)), true);

export function ContextMenu({ menu, onClose }: { menu: MenuState; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: menu.x, y: menu.y });
  const [sub, setSub] = useState<string | null>(null);

  useLayoutEffect(() => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    setPos({ x: Math.max(8, Math.min(menu.x, window.innerWidth - r.width - 8)), y: Math.max(8, Math.min(menu.y, window.innerHeight - r.height - 8)) });
  }, [menu, sub]);

  // A menu opened by a long press must survive the finger lifting: the browser
  // follows the release with a compatibility click and a window blur.
  const releasedAt = useRef(pointersDown > 0 ? 0 : Date.now());
  const pressedInside = useRef(false);
  useEffect(() => {
    const settled = () => releasedAt.current > 0 && Date.now() - releasedAt.current > 350;
    const close = (e: Event) => {
      if (ref.current && e.target instanceof Node && ref.current.contains(e.target)) {
        pressedInside.current = true;
        return;
      }
      if (settled()) onClose();
    };
    const up = () => {
      if (!releasedAt.current) releasedAt.current = Date.now();
    };
    // The click that follows the long-press release can land on an item under the finger:
    // ignore a click inside the menu that no press inside the menu started.
    const swallow = (e: Event) => {
      if (!pressedInside.current && !settled() && ref.current && e.target instanceof Node && ref.current.contains(e.target)) {
        e.stopPropagation();
        e.preventDefault();
      }
    };
    const blur = () => settled() && onClose();
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('pointerdown', close, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
    window.addEventListener('click', swallow, true);
    window.addEventListener('keydown', esc);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('pointerdown', close, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', up, true);
      window.removeEventListener('click', swallow, true);
      window.removeEventListener('keydown', esc);
      window.removeEventListener('blur', blur);
    };
  }, [onClose]);

  const { elements, boardId } = getState();
  const targets = menu.targetIds.map((id) => elements[id]).filter(Boolean) as El[];
  const run = (fn: () => void) => () => {
    fn();
    onClose();
  };
  const Item = ({ children, onClick, kbd, danger }: { children: ReactNode; onClick: () => void; kbd?: string; danger?: boolean }) => (
    <button className={danger ? 'danger' : ''} onClick={run(onClick)}>
      {children}
      {kbd && <kbd>{kbd}</kbd>}
    </button>
  );
  const Sub = ({ id, label, children }: { id: string; label: string; children: ReactNode }) => (
    <>
      <button className="has-sub" onClick={() => setSub(sub === id ? null : id)}>
        {t(label)} <span className="sub-caret">{sub === id ? '▾' : '▸'}</span>
      </button>
      {sub === id && <div className="menu-sub">{children}</div>}
    </>
  );

  // ------------------------------------------------------------ board background menu

  if (targets.length === 0) {
    const addAt = (type: ElementType, kind?: 'video' | 'audio' | 'map') => () => {
      const el = makeElement(type, { x: Math.round(menu.world!.x), y: Math.round(menu.world!.y) }) as El;
      if (el.type === 'link' && kind) el.content = { ...el.content, kind };
      if (el.type === 'line') el.content = { ...el.content, from: { x: el.x, y: el.y }, to: { x: el.x + 180, y: el.y } };
      addElements([el], { edit: !['swatch', 'line', 'sketch', 'document'].includes(type) });
      if (type === 'sketch') openDrawing(el.id);
      if (type === 'document') setState({ modal: { kind: 'document', id: el.id } });
    };
    const board = elements[boardId];
    const appearance = board?.type === 'board' ? board.content : null;
    const setBoard = (patch: { background?: string | null; hideGrid?: boolean }) => {
      if (board?.type === 'board') patchElements({ [boardId]: { content: patch } });
      else if (boardId === ROOT_ID) addElements([makeElement('board', { id: ROOT_ID, parentId: SYSTEM_PARENT, content: { title: 'Home', ...patch } })], { select: false });
    };
    return (
      <div ref={ref} className="menu" style={{ left: pos.x, top: pos.y }} role="menu">
        <Item onClick={addAt('note')}>{t('New Note')}</Item>
        <Item onClick={addAt('todo')}>{t('New To-do')}</Item>
        <Item onClick={addAt('column')}>{t('New Column')}</Item>
        <Item onClick={addAt('board')}>{t('New Board')}</Item>
        <Item onClick={addAt('table')}>{t('New Table')}</Item>
        <Item onClick={addAt('comment')}>{t('New Comment')}</Item>
        <Item onClick={addAt('link')}>{t('New Link')}</Item>
        <Item onClick={() => createElement('voice', { x: menu.world!.x, y: menu.world!.y })}>{t('New Voice Note')}</Item>
        <Item onClick={addAt('line')}>{t('New Line')}</Item>
        <Item onClick={() => newFolder({ x: menu.world!.x, y: menu.world!.y })}>{t('New Folder')}</Item>
        <Item onClick={() => newPlaceholder({ x: menu.world!.x, y: menu.world!.y })}>{t('New Image/File Placeholder')}</Item>
        <Sub id="more-new" label="More">
          <Item onClick={addAt('heading')}>{t('New Heading')}</Item>
          <Item onClick={addAt('document')}>{t('New Document')}</Item>
          <Item onClick={addAt('sketch')}>{t('New Sketch')}</Item>
          <Item onClick={addAt('swatch')}>{t('New Colour')}</Item>
          <Item onClick={addAt('link', 'video')}>{t('New Video')}</Item>
          <Item onClick={addAt('link', 'audio')}>{t('New Audio')}</Item>
          <Item onClick={addAt('link', 'map')}>{t('New Map')}</Item>
          <Item onClick={() => setState({ modal: { kind: 'imageSearch', at: { x: menu.world!.x, y: menu.world!.y } } })}>{t('Search Images…')}</Item>
          <Item onClick={() => setState({ modal: { kind: 'aiIdeas', at: { x: menu.world!.x, y: menu.world!.y } } })}>{t('AI Ideas…')}</Item>
        </Sub>
        <div className="menu-sep" />
        <Item onClick={() => pasteInternal({ x: menu.world!.x, y: menu.world!.y, centered: true }) || void 0} kbd="Ctrl V">
          {t('Paste')}
        </Item>
        <Item onClick={undo} kbd="Ctrl Z">
          {t('Undo')}
        </Item>
        <Item onClick={redo} kbd="Ctrl ⇧ Z">
          {t('Redo')}
        </Item>
        <Item
          onClick={() =>
            setState({ selection: Object.values(getState().elements).filter((e) => e.parentId === boardId && e.section === 'canvas' && !e.columnId).map((e) => e.id) })
          }
          kbd="Ctrl A"
        >
          {t('Select All')}
        </Item>
        <div className="menu-sep" />
        <Sub id="bg" label="Change Board Background">
          <div className="menu-colors">
            {[null, '#f6f1e7', '#e8eef5', '#eaf3ea', '#f5e9ee', '#ece8f6', '#2b2d31', '#16324f'].map((c) => (
              <button
                key={c ?? 'default'}
                className={`swatch-dot ${c ? '' : 'no-color'} ${(appearance?.background ?? null) === c ? 'active' : ''}`}
                style={c ? { background: c } : undefined}
                title={c ?? t('Revert to default')}
                onClick={run(() => setBoard({ background: c }))}
              />
            ))}
            <input type="color" title={t('Choose custom colour')} value={appearance?.background || '#eeece8'} onChange={(e) => setBoard({ background: e.target.value })} />
          </div>
          <Item onClick={() => setBoard({ hideGrid: !appearance?.hideGrid })}>{appearance?.hideGrid ? t('Show Dot Grid') : t('Hide Dot Grid')}</Item>
        </Sub>
        <Item onClick={() => setState({ panel: 'templates' })}>{t('New Board from Template…')}</Item>
        <Item onClick={() => setTheme(getState().theme === 'dark' ? 'light' : 'dark')} kbd="Ctrl ⇧ D">
          {t('Toggle Dark Mode')}
        </Item>
      </div>
    );
  }

  // ------------------------------------------------------------ element menu

  const single = targets.length === 1 ? targets[0] : null;
  const ids = targets.map((t) => t.id);
  const colorable = targets.every((t) => COLORABLE.has(t.type));
  const lines = targets.filter((t): t is Extract<El, { type: 'line' }> => t.type === 'line');
  const cards = targets.filter((t) => t.type !== 'line');
  const allLocked = targets.every((t) => t.locked);
  const customColor = single?.color?.startsWith('#') ? single.color : '#ffd166';

  return (
    <div ref={ref} className="menu element-menu" style={{ left: pos.x, top: pos.y }} role="menu">
      {colorable && (
        <div className="menu-colors">
          {CARD_COLORS.map((c) => (
            <button
              key={c.name}
              title={t(c.name)}
              className={`swatch-dot ${c.value ? `color-${c.value}` : 'no-color'} ${single && (single.color ?? null) === c.value ? 'active' : ''}`}
              onClick={run(() => patchElements(Object.fromEntries(ids.map((id) => [id, { color: c.value }]))))}
            />
          ))}
          <label className="custom-color" title={t('Choose custom colour')}>
            <input type="color" value={customColor} onChange={(e) => patchElements(Object.fromEntries(ids.map((id) => [id, { color: e.target.value }])))} />
          </label>
        </div>
      )}
      {colorable && targets.some((t) => t.color && t.color !== 'transparent' && t.type !== 'line' && t.type !== 'heading') && (
        <div className="menu-row" title={t('Colour mode')}>
          <button className={targets.every((t) => !t.colorStrip) ? 'active' : ''} onClick={run(() => patchElements(Object.fromEntries(ids.map((id) => [id, { colorStrip: false }]))))}>
            {t('Background')}
          </button>
          <button className={targets.every((t) => t.colorStrip) ? 'active' : ''} onClick={run(() => patchElements(Object.fromEntries(ids.map((id) => [id, { colorStrip: true }]))))}>
            {t('Top strip')}
          </button>
        </div>
      )}

      {/* type-specific actions */}
      {single?.type === 'board' && (
        <>
          <Item onClick={() => navigate(single.id)}>{t('Open Board')}</Item>
          <Item onClick={() => window.open(boardUrl(single.id), '_blank')}>{t('Open in New Tab')}</Item>
          <Item onClick={() => copyText(boardUrl(single.id), 'Board link copied')}>{t('Copy a Link to This Board')}</Item>
          <Item onClick={() => createShortcut(single.id)}>{t('Create a Shortcut to This Board')}</Item>
          <Item onClick={() => setState({ modal: { kind: 'icon', id: single.id } })}>{t('Change Icon…')}</Item>
          <Item onClick={() => convertToTemplate(single.id)}>{t('Convert to Template')}</Item>
          {single.content.protected ? (
            <>
              {!single.content.unlocked && <Item onClick={() => setState({ modal: { kind: 'boardPassword', id: single.id, mode: 'unlock' } })}>{t('Unlock Board…')}</Item>}
              <Item onClick={() => setState({ modal: { kind: 'boardPassword', id: single.id, mode: 'remove' } })}>{t('Remove Password…')}</Item>
            </>
          ) : (
            <Item onClick={() => setState({ modal: { kind: 'boardPassword', id: single.id, mode: 'set' } })}>{t('Password Protect…')}</Item>
          )}
          {single.content.publicToken ? (
            <>
              <Item onClick={() => copyText(`${location.origin}/p/${single.content.publicToken}`, 'Read-only link copied')}>{t('Copy Read-only Link')}</Item>
              <Item onClick={() => patchElements({ [single.id]: { content: { publicToken: null } } })}>{t('Unpublish')}</Item>
            </>
          ) : (
            <Item
              onClick={() => {
                const token = uid() + uid();
                patchElements({ [single.id]: { content: { publicToken: token } } });
                copyText(`${location.origin}/p/${token}`, 'Published — read-only link copied');
              }}
            >
              {t('Publish Read-only Link')}
            </Item>
          )}
        </>
      )}
      {single?.type === 'alias' && (
        <>
          <Item onClick={() => navigate(single.content.boardId)}>{t('Open Board')}</Item>
          <Item
            onClick={() => {
              const target = getState().elements[single.content.boardId];
              if (target) {
                navigate(target.parentId);
                setState({ focusRequest: { id: target.id, nonce: Date.now() } });
              }
            }}
          >
            {t('Find Original Board')}
          </Item>
          <Item onClick={() => duplicate([single.id])}>{t('Duplicate This Shortcut')}</Item>
          <Item onClick={() => duplicateLinkedBoard(single.id)}>{t('Duplicate the Board It Links To')}</Item>
        </>
      )}
      {single && ['note', 'todo', 'column', 'board', 'link', 'swatch', 'line', 'heading', 'table', 'comment'].includes(single.type) && (
        <Item onClick={() => startEditing(single.id)} kbd="Enter">
          {single.type === 'line' ? t('Edit Label') : single.type === 'board' ? t('Rename') : t('Edit')}
        </Item>
      )}
      {single?.type === 'sketch' && (
        <>
          <Item onClick={() => openDrawing(single.id)}>{t('Edit Drawing')}</Item>
          <Item onClick={() => exportElement(single.id)}>{t('Download SVG')}</Item>
        </>
      )}
      {single && (isVideoLink(single) || (single.type === 'file' && /^(video|audio)\//.test(single.content.mime))) && (
        <Sub id="media" label="Video Options">
          <MediaOptionsEditor
            value={(single.content as { media?: MediaOptions }).media ?? {}}
            onChange={(media) => patchElements({ [single.id]: { content: { media } } })}
          />
        </Sub>
      )}
      {single?.type === 'document' && <Item onClick={() => setState({ modal: { kind: 'document', id: single.id } })}>{t('Open Document')}</Item>}
      {single?.type === 'image' && (
        <>
          <Item onClick={() => startEditing(single.id)}>{t('Edit Caption')}</Item>
          <Item onClick={() => openDrawing(single.id)}>{t('Draw On')}</Item>
          <Item onClick={() => void replaceImage(single.id)}>{t('Replace Image')}</Item>
          {single.content.src && <Item onClick={() => setState({ modal: { kind: 'crop', id: single.id } })}>{t('Crop Image…')}</Item>}
          {single.content.src && <Item onClick={() => cropToGrid(single.id)}>{t('Crop Image to Fit Dot Grid')}</Item>}
          {single.content.src && <Item onClick={() => convertToSketch(single.id)}>{t('Convert to Sketch Card')}</Item>}
          <Item onClick={() => setState({ modal: { kind: 'fileInfo', id: single.id } })}>{t('File Info')}</Item>
          <a className="menu-link" href={safeUrl(single.content.src) ?? undefined} download onClick={onClose}>
            {t('Download Original Image')}
          </a>
          <Item onClick={() => copyText(location.origin + single.content.src, 'Link copied')}>{t('Copy Link to File')}</Item>
        </>
      )}
      {single?.type === 'file' && (
        <>
          <Item onClick={() => safeUrl(single.content.src) && window.open(single.content.src, '_blank', 'noopener')}>{t('Open File')}</Item>
          <Item onClick={() => setState({ modal: { kind: 'fileInfo', id: single.id } })}>{t('File Info')}</Item>
          <a className="menu-link" href={safeUrl(single.content.src) ?? undefined} download={single.content.name} onClick={onClose}>
            {t('Download')}
          </a>
          <Item onClick={() => copyText(location.origin + single.content.src, 'Link copied')}>{t('Copy Link to File')}</Item>
        </>
      )}
      {single?.type === 'voice' && single.content.src && (
        <>
          {!single.locked && <Item onClick={() => startRecording(single.id)}>{t('Record Again')}</Item>}
          <Item onClick={() => setState({ modal: { kind: 'fileInfo', id: single.id } })}>{t('File Info')}</Item>
          <a className="menu-link" href={safeUrl(single.content.src) ?? undefined} download={single.content.name} onClick={onClose}>
            {t('Download')}
          </a>
          <Item onClick={() => copyText(location.origin + single.content.src, 'Link copied')}>{t('Copy Link to File')}</Item>
        </>
      )}
      {single?.type === 'link' && single.content.url && (
        <>
          <Item onClick={() => safeUrl(single.content.url) && window.open(single.content.url, '_blank', 'noopener')}>{t('Open Link')}</Item>
          <Item onClick={() => copyText(single.content.url, 'Link address copied')}>{t('Copy Link Address')}</Item>
          <Item onClick={() => void fetchLinkPreview(single.id, single.content.url)}>{t('Refresh Preview')}</Item>
          <Item onClick={() => replacePreview(single.id)}>{t('Replace Preview')}</Item>
        </>
      )}
      {single?.type === 'todo' && single.content.items.some((i) => i.done) && <Item onClick={() => deleteCompletedTasks(single.id)}>{t('Delete Completed Tasks')}</Item>}
      {single?.type === 'heading' && (
        <div className="menu-row">
          {(['large', 'medium', 'small'] as const).map((size) => (
            <button key={size} className={(single.content.size ?? 'large') === size ? 'active' : ''} onClick={run(() => patchElements({ [single.id]: { content: { size } } }))}>
              {size === 'large' ? 'H1' : size === 'medium' ? 'H2' : 'H3'}
            </button>
          ))}
        </div>
      )}
      {single && CAPTION_TYPES.includes(single.type) && (
        <Item onClick={() => setState({ captionEditId: single.id, selection: [single.id] })}>{single.caption ? t('Edit Description') : t('Add Description')}</Item>
      )}
      {cards.length > 0 && <Item onClick={() => setState({ modal: { kind: 'labels', ids: cards.map((c) => c.id) } })}>{t('Labels…')}</Item>}
      {cards.length > 0 && (
        <Sub id="reactions" label="Reactions">
          <div className="menu-row reactions-pick">
            {REACTIONS.map((r) => (
              <button key={r} className={cards.every((c) => c.reactions?.includes(r)) ? 'active' : ''} onClick={run(() => toggleReaction(cards.map((c) => c.id), r))}>
                {r}
              </button>
            ))}
          </div>
        </Sub>
      )}
      {single && single.type !== 'line' && single.type !== 'comment' && <Item onClick={() => attachComment(single.id)}>{t('Add Comment')}</Item>}
      {single && !['line', 'board', 'column', 'alias', 'label'].includes(single.type) && <Item onClick={() => createSyncedCopy(single.id)}>{t('Create Synced Copy')}</Item>}
      {single?.syncId && <Item onClick={() => unsync(single.id)}>{t('Stop Syncing This Copy')}</Item>}
      {single && !['line', 'board', 'column', 'alias', 'label'].includes(single.type) && <Item onClick={() => exportElement(single.id)}>{t('Export…')}</Item>}
      {single && ['note', 'document', 'todo', 'heading'].includes(single.type) && (
        <Sub id="convert" label="Convert to">
          {single.type !== 'note' && <Item onClick={() => convertElement(single.id, 'note')}>{t('Convert to Note')}</Item>}
          {single.type !== 'document' && <Item onClick={() => convertElement(single.id, 'document')}>{t('Convert to Document')}</Item>}
          {single.type !== 'todo' && <Item onClick={() => convertElement(single.id, 'todo')}>{t('Convert to To-do')}</Item>}
          {single.type !== 'heading' && <Item onClick={() => convertElement(single.id, 'heading')}>{t('Convert to Heading')}</Item>}
          <Item onClick={() => convertElement(single.id, 'board')}>{t('Convert to Board')}</Item>
        </Sub>
      )}

      {/* lines */}
      {lines.length > 0 && (
        <>
          <div className="menu-sep" />
          <div className="menu-label">{t('Line')}</div>
          <div className="menu-row">
            {(['end', 'both', 'none'] as const).map((arrow) => (
              <button
                key={arrow}
                title={arrow === 'end' ? t('Arrow at end') : arrow === 'both' ? t('Arrows at both ends') : t('No arrows')}
                className={lines.every((l) => l.content.arrow === arrow) ? 'active' : ''}
                onClick={run(() => patchElements(Object.fromEntries(lines.map((l) => [l.id, { content: { arrow } }]))))}
              >
                {arrow === 'end' ? '→' : arrow === 'both' ? '↔' : '—'}
              </button>
            ))}
            <button
              title={t('Dashed')}
              className={lines.every((l) => l.content.dashed) ? 'active' : ''}
              onClick={run(() => patchElements(Object.fromEntries(lines.map((l) => [l.id, { content: { dashed: !lines.every((x) => x.content.dashed) } }]))))}
            >
              ┄
            </button>
          </div>
          <div className="menu-row">
            {[1.5, 2.5, 4, 6].map((w) => (
              <button key={w} title={`Weight ${w}`} className={lines.every((l) => (l.content.weight ?? 2) === w) ? 'active' : ''} onClick={run(() => patchElements(Object.fromEntries(lines.map((l) => [l.id, { content: { weight: w } }]))))}>
                <span className="weight-sample" style={{ height: w }} />
              </button>
            ))}
          </div>
        </>
      )}

      {/* multi-card organising */}
      {cards.length > 1 && (
        <>
          <div className="menu-sep" />
          <Item onClick={() => groupIntoColumn(ids)}>{t('Group into Column')}</Item>
          <Item onClick={() => connectWithLines(ids)}>{t('Connect with Lines')}</Item>
          <Sub id="align" label="Align & Distribute">
            <div className="menu-row">
              <button title={t('Align left')} onClick={run(() => alignSelection('left', ids))}>⇤</button>
              <button title={t('Align centre')} onClick={run(() => alignSelection('center', ids))}>↔</button>
              <button title={t('Align right')} onClick={run(() => alignSelection('right', ids))}>⇥</button>
            </div>
            <div className="menu-row">
              <button title={t('Align top')} onClick={run(() => alignSelection('top', ids))}>⤒</button>
              <button title={t('Align middle')} onClick={run(() => alignSelection('middle', ids))}>↕</button>
              <button title={t('Align bottom')} onClick={run(() => alignSelection('bottom', ids))}>⤓</button>
            </div>
            <Item onClick={() => distributeSelection('horizontal', ids)}>{t('Distribute Horizontally')}</Item>
            <Item onClick={() => distributeSelection('vertical', ids)}>{t('Distribute Vertically')}</Item>
          </Sub>
        </>
      )}
      {cards.length === 1 && single && !single.columnId && single.type !== 'column' && <Item onClick={() => groupIntoColumn(ids)}>{t('Group into Column')}</Item>}

      <div className="menu-sep" />
      <Item onClick={() => copySelection() && trashElements(ids)} kbd="Ctrl X">
        {t('Cut')}
      </Item>
      <Item onClick={() => void copySelection()} kbd="Ctrl C">
        {t('Copy')}
      </Item>
      <Item onClick={() => duplicate(ids)} kbd="Ctrl D">
        {t('Duplicate')}
      </Item>
      <Sub id="style" label="Styles">
        <Item onClick={() => copyStyle(ids[0])} kbd="Ctrl Alt C">
          {t('Copy Style')}
        </Item>
        <Item onClick={() => pasteStyle(ids)} kbd="Ctrl Alt V">
          {t('Paste Styles')}
        </Item>
      </Sub>
      {targets.some((t) => !t.columnId && t.type !== 'line') && (
        <>
          <Item
            onClick={() => {
              let z = maxZ();
              patchElements(Object.fromEntries(ids.map((id) => [id, { z: ++z }])));
            }}
            kbd="Ctrl ]"
          >
            {t('Bring to Front')}
          </Item>
          <Item
            onClick={() => {
              const minZ = Math.min(...Object.values(getState().elements).filter((e) => e.parentId === getState().boardId).map((e) => e.z));
              let z = minZ - ids.length;
              patchElements(Object.fromEntries(ids.map((id) => [id, { z: z++ }])));
            }}
            kbd="Ctrl ["
          >
            {t('Send to Back')}
          </Item>
        </>
      )}
      <Item onClick={() => setLocked(ids, !allLocked)}>{allLocked ? t('Unlock Position') : t('Lock Position')}</Item>
      {cards.length > 0 && (
        <Item onClick={() => moveToInbox(ids)} kbd="U">
          {t('Move to Unsorted')}
        </Item>
      )}
      <div className="menu-sep" />
      <Item danger onClick={() => trashElements(ids)} kbd="Del">
        {t('Move to Trash')}
      </Item>
      {single && (
        <div className="menu-note">
          {single.updatedAt - single.createdAt > 5000
            ? t('Created {created}, modified {modified}', { created: timeAgo(single.createdAt), modified: timeAgo(single.updatedAt) })
            : t('Created {created}', { created: timeAgo(single.createdAt) })}
        </div>
      )}
    </div>
  );
}

function isVideoLink(el: El) {
  return el.type === 'link' && !!el.content.url && /youtu|vimeo|loom|spotify|soundcloud/.test(el.content.url);
}

function parseTime(text: string): number | null {
  const t = text.trim();
  if (!t) return null;
  const parts = t.split(':').map(Number);
  if (parts.some((n) => Number.isNaN(n))) return null;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

function fmtTime(sec?: number | null) {
  if (!sec) return '';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

// Keeps its own state: the menu itself doesn't re-render when the card changes.
function MediaOptionsEditor({ value, onChange }: { value: MediaOptions; onChange(v: MediaOptions): void }) {
  const [start, setStart] = useState(fmtTime(value.start));
  const [end, setEnd] = useState(fmtTime(value.end));
  const [flags, setFlags] = useState({ loop: !!value.loop, autoplay: !!value.autoplay });
  const save = (patch: Partial<MediaOptions>) => {
    const next = { ...flags, ...patch } as { loop: boolean; autoplay: boolean };
    setFlags({ loop: next.loop, autoplay: next.autoplay });
    onChange({ ...value, start: parseTime(start), end: parseTime(end), loop: next.loop, autoplay: next.autoplay });
  };
  return (
    <div className="media-options" onPointerDown={(e) => e.stopPropagation()}>
      <label>
        {t('Start')} <input value={start} placeholder="0:00" onChange={(e) => setStart(e.target.value)} onBlur={() => save({})} />
      </label>
      <label>
        {t('End')} <input value={end} placeholder={t('end')} onChange={(e) => setEnd(e.target.value)} onBlur={() => save({})} />
      </label>
      <label className="check">
        <input type="checkbox" checked={flags.loop} onChange={(e) => save({ loop: e.target.checked })} /> {t('Loop')}
      </label>
      <label className="check">
        <input type="checkbox" checked={flags.autoplay} onChange={(e) => save({ autoplay: e.target.checked })} /> {t('Autoplay (muted)')}
      </label>
    </div>
  );
}

