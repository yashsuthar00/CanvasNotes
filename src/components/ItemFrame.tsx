import { memo } from 'react';
import { useElement, useStore } from '../store';
import { ElementBody } from '../elements/ElementBody';
import { CardExtras } from '../elements/MoreBodies';
import { useCanvas } from './canvasContext';
import { t } from '../i18n';

const RESIZABLE = new Set(['note', 'heading', 'todo', 'image', 'link', 'column', 'file', 'voice', 'swatch', 'sketch', 'table', 'document', 'comment']);

// Positions one element on the canvas (or in a column) and routes its pointer
// events to the canvas, which owns selection and dragging.
export const ItemFrame = memo(function ItemFrame({ id, inColumn = false }: { id: string; inColumn?: boolean }) {
  const el = useElement(id);
  const selected = useStore((s) => s.selection.includes(id));
  const editing = useStore((s) => s.editingId === id);
  const ctx = useCanvas();
  if (!el || el.type === 'line') return null;

  const drag = ctx.drag;
  const dragging = !!drag && drag.ids.includes(id);
  const dropTarget = drag?.target?.id === id;
  const classes = [
    'item',
    `item-${el.type}`,
    el.color ? (el.color.startsWith('#') ? 'color-custom' : `color-${el.color}`) : '',
    el.locked ? 'locked' : '',
    el.colorStrip && el.color ? 'strip' : '',
    selected ? 'selected' : '',
    editing ? 'editing' : '',
    inColumn ? 'in-column' : '',
    dragging ? (inColumn ? 'drag-source' : 'dragging') : '',
    dropTarget ? 'drop-target' : '',
    ctx.armedId === id ? 'armed' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const custom = el.color?.startsWith('#') ? ({ '--custom-color': el.color } as React.CSSProperties) : undefined;
  const style = inColumn
    ? custom
    : {
        ...custom,
        left: el.x,
        top: el.y,
        width: el.type === 'board' || el.type === 'alias' ? undefined : el.w,
        zIndex: dragging ? 1_000_000 + el.z : el.z,
        transform: dragging ? `translate(${drag!.dx}px, ${drag!.dy}px)` : undefined,
      };

  return (
    <div
      className={classes}
      style={style}
      data-el={id}
      ref={ctx.observe}
      onPointerDown={(e) => ctx.onItemPointerDown(e, el)}
      onDoubleClick={(e) => ctx.onItemDoubleClick(e, el)}
      onContextMenu={(e) => ctx.onItemContextMenu(e, el)}
    >
      <ElementBody el={el} editing={editing} selected={selected} />
      <CardExtras el={el} />
      {selected && !inColumn && !editing && !el.locked && RESIZABLE.has(el.type) && <div className="resize-handle" data-resize title={t('Drag to resize')} />}
    </div>
  );
});
