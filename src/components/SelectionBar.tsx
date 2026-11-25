import { getState, navigate, setState, startEditing, trashElements, useStore } from '../store';
import { safeUrl } from '../sanitize';
import { duplicate } from '../actions';
import { openDrawing } from '../elements/Sketch';
import { openDocument } from '../elements/MoreBodies';
import type { MenuState } from './ContextMenu';
import { t } from '../i18n';

const coarse = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;

// On touch screens there's no right-click or keyboard, so selected cards get
// a floating bar with the common actions and the full menu behind "More".
export function SelectionBar({ onMenu }: { onMenu(menu: MenuState): void }) {
  const selection = useStore((s) => s.selection);
  const editing = useStore((s) => s.editingId);
  const single = useStore((s) => (s.selection.length === 1 ? s.elements[s.selection[0]] : undefined));
  if (!coarse || selection.length === 0 || editing) return null;

  const open = () => {
    if (!single) return;
    if (single.type === 'board') navigate(single.id);
    else if (single.type === 'alias') navigate(single.content.boardId);
    else if (single.type === 'sketch') openDrawing(single.id);
    else if (single.type === 'document') openDocument(single.id);
    else if (single.type === 'image' || single.type === 'file') safeUrl(single.content.src) && window.open(single.content.src, '_blank', 'noopener');
    else startEditing(single.id);
  };
  const openLabel = !single || single.type === 'voice'
    ? null
    : ['board', 'alias', 'document'].includes(single.type)
      ? t('Open')
      : single.type === 'sketch'
        ? t('Draw')
        : single.type === 'image' || single.type === 'file'
          ? t('View')
          : t('Edit');

  return (
    <div className="selection-bar" onPointerDown={(e) => e.stopPropagation()}>
      <span className="sel-count">{t('{n} selected', { n: selection.length })}</span>
      {openLabel && <button onClick={open}>{openLabel}</button>}
      <button onClick={() => duplicate()}>{t('Duplicate')}</button>
      <button
        onClick={(e) => {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          onMenu({ x: r.left, y: r.top - 8, targetIds: getState().selection });
        }}
      >
        {t('More')}
      </button>
      <button className="danger" onClick={() => trashElements(getState().selection)}>
        {t('Delete')}
      </button>
      <button onClick={() => setState({ selection: [] })} aria-label={t('Done')}>
        ✕
      </button>
    </div>
  );
}
