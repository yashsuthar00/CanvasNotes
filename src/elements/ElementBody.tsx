import { memo, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { safeUrl, sanitizeHtml } from '../sanitize';
import { columnChildren, getState, patchElement, startEditing, uid, useStore } from '../store';
import type { El, ElementOf, MediaOptions, TodoItem } from '../types';
import { pickFiles } from '../actions';
import { fillPlaceholder } from '../moreActions';
import { RichText } from './RichText';
import { ItemFrame } from '../components/ItemFrame';
import { useCanvas } from '../components/canvasContext';
import { fetchLinkPreview, hostOf, isUrl } from '../actions';
import { navigate } from '../store';
import { SketchView, StrokesSvg } from './Sketch';
import { TableBody } from './Table';
import { AliasBody, CommentBody, DocumentBody, HeadingBody } from './MoreBodies';
import { embedFor, LINK_PLACEHOLDERS } from '../embeds';
import { numLocale } from '../locale';
import { t } from '../i18n';

interface BodyProps<T extends El['type']> {
  el: ElementOf<T>;
  editing: boolean;
  selected: boolean;
}

export const ElementBody = memo(function ElementBody({ el, editing, selected }: { el: El; editing: boolean; selected: boolean }) {
  switch (el.type) {
    case 'note':
      return <NoteBody el={el} editing={editing} selected={selected} />;
    case 'board':
      return <BoardBody el={el} editing={editing} selected={selected} />;
    case 'column':
      return <ColumnBody el={el} editing={editing} selected={selected} />;
    case 'todo':
      return <TodoBody el={el} editing={editing} selected={selected} />;
    case 'image':
      return <ImageBody el={el} editing={editing} selected={selected} />;
    case 'link':
      return <LinkBody el={el} editing={editing} selected={selected} />;
    case 'swatch':
      return <SwatchBody el={el} editing={editing} selected={selected} />;
    case 'file':
      return <FileBody el={el} editing={editing} selected={selected} />;
    case 'heading':
      return <HeadingBody el={el} editing={editing} />;
    case 'alias':
      return <AliasBody el={el} />;
    case 'sketch':
      return (
        <div className="card sketch-card">
          <SketchView strokes={el.content.strokes} ratio={el.content.ratio} background={el.content.background} />
        </div>
      );
    case 'table':
      return <TableBody el={el} editing={editing} />;
    case 'document':
      return <DocumentBody el={el} />;
    case 'comment':
      return <CommentBody el={el} editing={editing} />;
    default:
      return null;
  }
});

const stopEditing = () => startEditing(null);

function useAutoFocus<T extends HTMLInputElement | HTMLTextAreaElement>(active: boolean) {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (active) {
      ref.current?.focus();
      ref.current?.select();
    }
  }, [active]);
  return ref;
}

// ---------------------------------------------------------------- note

function NoteBody({ el, editing }: BodyProps<'note'>) {
  if (editing) {
    return (
      <div className="card note">
        <RichText html={el.content.html} onChange={(html) => patchElement(el.id, { content: { html } }, { coalesce: `note:${el.id}` })} onDone={stopEditing} />
      </div>
    );
  }
  return (
    <div className="card note">
      {el.content.html ? (
        <div className="rich-text" onClick={openLinkInNote} dangerouslySetInnerHTML={{ __html: sanitizeHtml(el.content.html) }} />
      ) : (
        <div className="rich-text placeholder">{t('Empty note')}</div>
      )}
    </div>
  );
}

// Links inside a note work when it isn't being edited: board links navigate, web links open a tab.
function openLinkInNote(e: React.MouseEvent) {
  const a = (e.target as HTMLElement).closest('a');
  if (!a) return;
  e.preventDefault();
  e.stopPropagation();
  const href = a.getAttribute('href') || '';
  const board = href.match(/^#\/b\/([\w-]+)/);
  if (board) navigate(board[1]);
  else if (href === '#/') navigate('root');
  else if (safeUrl(href)) window.open(href, '_blank', 'noopener');
}

// ---------------------------------------------------------------- board

function BoardBody({ el, editing }: BodyProps<'board'>) {
  const counts = useStore((s) => {
    let cards = 0;
    for (const e of Object.values(s.elements)) if (e.parentId === el.id && e.section === 'canvas' && e.type !== 'line') cards++;
    return cards;
  });
  const ref = useAutoFocus<HTMLInputElement>(editing);
  return (
    <div className="board-card">
      <div className="board-tile">
        <span className="board-icon">
          {el.content.iconImage ? <img src={el.content.iconImage} alt="" draggable={false} /> : el.content.icon || <BoardGlyph />}
        </span>
      </div>
      {editing ? (
        <input
          ref={ref}
          className="board-title-input"
          defaultValue={el.content.title}
          placeholder={t('Board name')}
          onKeyDown={(e) => (e.key === 'Enter' || e.key === 'Escape') && (e.target as HTMLInputElement).blur()}
          onBlur={(e) => {
            const raw = e.target.value.trim();
            // A leading emoji becomes the board icon.
            const m = raw.match(/^(\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic})*)\s*(.*)$/u);
            const content = m ? { icon: m[1], title: m[2] || el.content.title } : { title: raw };
            patchElement(el.id, { content: { ...content, title: content.title || t('Untitled board') } });
            stopEditing();
          }}
        />
      ) : (
        <div className="board-title">{el.content.title || t('Untitled board')}</div>
      )}
      <div className="board-meta">
        {el.content.protected ? (el.content.unlocked ? t('🔓 Unlocked') : t('🔒 Password protected')) : counts === 0 ? t('Empty') : t(counts === 1 ? '1 card' : '{n} cards', { n: counts })}
        {el.content.publicToken ? ' · 🌐 Published' : ''}
      </div>
    </div>
  );
}

function BoardGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="30" height="30" aria-hidden>
      <rect x="3" y="4" width="8" height="10" rx="1.5" fill="currentColor" opacity=".85" />
      <rect x="13" y="4" width="8" height="6" rx="1.5" fill="currentColor" opacity=".55" />
      <rect x="13" y="12" width="8" height="8" rx="1.5" fill="currentColor" opacity=".7" />
      <rect x="3" y="16" width="8" height="4" rx="1.5" fill="currentColor" opacity=".45" />
    </svg>
  );
}

// ---------------------------------------------------------------- column

function ColumnBody({ el, editing }: BodyProps<'column'>) {
  const childKey = useStore((s) => columnChildren(el.id, s.elements).map((c) => c.id).join(','));
  const kids = childKey ? childKey.split(',') : [];
  const { drag } = useCanvas();
  const ref = useAutoFocus<HTMLInputElement>(editing);
  const dropIndex = drag?.target?.kind === 'column' && drag.target.id === el.id ? drag.target.index : -1;
  const visible = kids.filter((id) => !drag?.ids.includes(id) || !getState().elements[id]?.columnId);
  const collapsed = el.content.collapsed;

  return (
    <div className={`column ${el.content.folder ? 'folder' : ''}`}>
      <div className="column-header">
        {el.content.folder && <span className="folder-icon">{collapsed ? '📁' : '📂'}</span>}
        {editing ? (
          <input
            ref={ref}
            className="column-title-input"
            defaultValue={el.content.title}
            placeholder={t('Column title')}
            onKeyDown={(e) => (e.key === 'Enter' || e.key === 'Escape') && (e.target as HTMLInputElement).blur()}
            onBlur={(e) => {
              patchElement(el.id, { content: { title: e.target.value.trim() } });
              stopEditing();
            }}
          />
        ) : (
          <div className={`column-title ${el.content.title ? '' : 'placeholder'}`}>{el.content.title || t('Untitled column')}</div>
        )}
        <span className="column-count">{kids.length || ''}</span>
        <button
          data-nodrag
          className="icon-btn small"
          title={collapsed ? t('Expand') : t('Collapse')}
          onClick={() => patchElement(el.id, { content: { collapsed: !collapsed } })}
        >
          {collapsed ? '▸' : '▾'}
        </button>
      </div>
      {!collapsed && (
        <div className="column-body">
          {kids.length === 0 && dropIndex < 0 && <div className="column-empty">{t('Drag cards here')}</div>}
          {kids.map((id) => {
            const visibleIndex = visible.indexOf(id);
            return (
              <div key={id} className="column-slot">
                {dropIndex >= 0 && visibleIndex === dropIndex && <div className="drop-indicator" />}
                <ItemFrame id={id} inColumn />
              </div>
            );
          })}
          {dropIndex >= 0 && dropIndex >= visible.length && <div className="drop-indicator" />}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- to-do list

function TodoBody({ el, editing }: BodyProps<'todo'>) {
  const { title, items } = el.content;
  const done = items.filter((i) => i.done && i.text.trim()).length;
  const total = items.filter((i) => i.text.trim()).length;
  const [focusId, setFocusId] = useState<string | null>(null);
  const titleRef = useAutoFocus<HTMLInputElement>(editing && !title);
  // Opening a titled list for editing puts the cursor in its last task.
  useEffect(() => {
    if (editing && title) setFocusId(items[items.length - 1]?.id ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  const setItems = (next: TodoItem[], coalesce = true) =>
    patchElement(el.id, { content: { items: next } }, coalesce ? { coalesce: `todo:${el.id}` } : undefined);
  const updateItem = (id: string, patch: Partial<TodoItem>, coalesce = true) =>
    setItems(
      getCurrentItems(el.id).map((i) => (i.id === id ? { ...i, ...patch } : i)),
      coalesce,
    );

  const onItemKey = (e: KeyboardEvent<HTMLInputElement>, item: TodoItem, index: number) => {
    const current = getCurrentItems(el.id);
    if (e.key === 'Enter') {
      e.preventDefault();
      const fresh = { id: uid(), text: '', done: false, indent: item.indent ?? 0 };
      setItems([...current.slice(0, index + 1), fresh, ...current.slice(index + 1)], false);
      setFocusId(fresh.id);
    } else if (e.key === 'Tab') {
      e.preventDefault();
      const indent = Math.max(0, Math.min(3, (item.indent ?? 0) + (e.shiftKey ? -1 : 1)));
      updateItem(item.id, { indent }, false);
    } else if (e.key === 'Backspace' && item.text === '' && current.length > 1) {
      e.preventDefault();
      setItems(current.filter((i) => i.id !== item.id), false);
      setFocusId(current[Math.max(0, index - 1)].id);
    } else if (e.key === 'ArrowUp' && index > 0) {
      setFocusId(current[index - 1].id);
    } else if (e.key === 'ArrowDown' && index < current.length - 1) {
      setFocusId(current[index + 1].id);
    } else if (e.key === 'Escape') {
      stopEditing();
    }
  };

  return (
    <div className="card todo">
      <div className="todo-head">
        {editing ? (
          <input
            ref={titleRef}
            className="todo-title-input"
            defaultValue={title}
            placeholder={t('To-do list')}
            onChange={(e) => patchElement(el.id, { content: { title: e.target.value } }, { coalesce: `todo-title:${el.id}` })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                setFocusId(getCurrentItems(el.id)[0]?.id ?? null);
              } else if (e.key === 'Escape') stopEditing();
            }}
          />
        ) : (
          <div className={`todo-title ${title ? '' : 'placeholder'}`}>{title || t('To-do list')}</div>
        )}
        {total > 0 && (
          <span className="todo-progress" title={`${done} of ${total} done`}>
            <span style={{ width: `${(done / total) * 100}%` }} />
          </span>
        )}
      </div>
      <ul className="todo-items">
        {items.map((item, index) => (
          <li key={item.id} className={item.done ? 'done' : ''} style={item.indent ? { paddingLeft: item.indent * 20 } : undefined}>
            <input
              data-nodrag
              type="checkbox"
              checked={item.done}
              onChange={(e) => updateItem(item.id, { done: e.target.checked }, false)}
              aria-label={t('Done')}
            />
            {editing ? (
              <AutoInput
                value={item.text}
                focus={focusId === item.id}
                onFocused={() => setFocusId(null)}
                onChange={(text) => updateItem(item.id, { text })}
                onKeyDown={(e) => onItemKey(e, item, index)}
              />
            ) : (
              <span className={`todo-text ${item.text ? '' : 'placeholder'}`}>{item.text || t('Empty task')}</span>
            )}
            <DueDate item={item} editing={editing} onChange={(due) => updateItem(item.id, { due }, false)} />
          </li>
        ))}
      </ul>
      {editing && (
        <button
          className="todo-add"
          onClick={() => {
            const fresh = { id: uid(), text: '', done: false };
            setItems([...getCurrentItems(el.id), fresh], false);
            setFocusId(fresh.id);
          }}
        >
          {t('+ Add task')}
        </button>
      )}
    </div>
  );
}

function dueState(due: string) {
  const today = new Date().toISOString().slice(0, 10);
  return due < today ? 'overdue' : due === today ? 'today' : 'later';
}

function DueDate({ item, editing, onChange }: { item: TodoItem; editing: boolean; onChange(due: string | null): void }) {
  const [open, setOpen] = useState(false);
  if (!item.due && !editing) return null;
  if (editing && (open || item.due)) {
    return (
      <input
        type="date"
        data-nodrag
        className={`due-input ${item.due ? dueState(item.due) : ''}`}
        value={item.due ?? ''}
        autoFocus={open && !item.due}
        onChange={(e) => onChange(e.target.value || null)}
        onBlur={() => setOpen(false)}
        title={t('Due date')}
      />
    );
  }
  if (editing) {
    return (
      <button data-nodrag className="due-add" title={t('Set due date')} onClick={() => setOpen(true)}>
        📅
      </button>
    );
  }
  const d = new Date(`${item.due}T00:00:00`);
  return (
    <span className={`due-badge ${dueState(item.due!)}`} title={`Due ${d.toDateString()}`}>
      Due {d.toLocaleDateString(numLocale(), { month: 'short', day: 'numeric' })}
    </span>
  );
}

function getCurrentItems(id: string): TodoItem[] {
  const el = getState().elements[id];
  return el?.type === 'todo' ? el.content.items : [];
}

function AutoInput({
  value,
  focus,
  onFocused,
  onChange,
  onKeyDown,
}: {
  value: string;
  focus: boolean;
  onFocused(): void;
  onChange(v: string): void;
  onKeyDown(e: KeyboardEvent<HTMLInputElement>): void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (focus) {
      ref.current?.focus();
      onFocused();
    }
  }, [focus, onFocused]);
  return <input ref={ref} className="todo-input" value={value} placeholder={t('Task')} onChange={(e) => onChange(e.target.value)} onKeyDown={onKeyDown} />;
}

// ---------------------------------------------------------------- image

function ImageBody({ el, editing }: BodyProps<'image'>) {
  const ref = useAutoFocus<HTMLInputElement>(editing);
  const { src, ratio, crop, attribution } = el.content;
  if (!src) {
    // Milanote's "Image/File placeholder": an empty card waiting for a file.
    return (
      <div
        className="card image-placeholder"
        data-nodrag
        onClick={() => pickFiles('*/*', ([file]) => file && void fillPlaceholder(el.id, file))}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          const file = e.dataTransfer.files[0];
          if (file) void fillPlaceholder(el.id, file);
        }}
      >
        <span className="placeholder-icon">＋</span>
        <span>{t('Add an image or file')}</span>
      </div>
    );
  }
  // A crop shows part of the image: scale it up inside a frame with the crop's proportions.
  const c = crop ?? { x: 0, y: 0, w: 1, h: 1 };
  const frameRatio = ratio ? (ratio * c.h) / c.w : undefined;
  const cropped = !!crop;
  return (
    <figure className="card image">
      <div className={`image-frame ${cropped ? 'cropped' : ''}`} style={frameRatio ? { aspectRatio: `1 / ${frameRatio}` } : undefined}>
        <div
          className="image-inner"
          style={cropped ? { width: `${100 / c.w}%`, height: `${100 / c.h}%`, left: `${(-c.x / c.w) * 100}%`, top: `${(-c.y / c.h) * 100}%` } : undefined}
        >
          <img src={src} alt={el.content.caption || ''} draggable={false} loading="lazy" />
          {el.content.annotation?.length ? <StrokesSvg strokes={el.content.annotation} ratio={ratio ?? 0.66} className="annotation-svg" /> : null}
        </div>
      </div>
      {editing ? (
        <input
          ref={ref}
          className="caption-input"
          defaultValue={el.content.caption ?? ''}
          placeholder={t('Add a caption')}
          onKeyDown={(e) => (e.key === 'Enter' || e.key === 'Escape') && (e.target as HTMLInputElement).blur()}
          onBlur={(e) => {
            patchElement(el.id, { content: { caption: e.target.value.trim() } });
            stopEditing();
          }}
        />
      ) : (
        el.content.caption && <figcaption>{el.content.caption}</figcaption>
      )}
      {attribution && (
        <a data-nodrag className="attribution" href={safeUrl(attribution.url) ?? undefined} target="_blank" rel="noopener noreferrer">
          {t('From Wikimedia Commons')} · {attribution.label}
        </a>
      )}
    </figure>
  );
}

// ---------------------------------------------------------------- link

function LinkBody({ el, editing, selected }: BodyProps<'link'>) {
  const { url, title, description, image, site, loading, kind } = el.content;
  const embed = url ? embedFor(url, el.content.media) : null;
  const ref = useAutoFocus<HTMLInputElement>(editing);
  const [imageFailed, setImageFailed] = useState(false);
  if (editing || !url) {
    return (
      <div className="card link link-edit">
        <label className="link-label">{t(kind ? kind[0].toUpperCase() + kind.slice(1) : 'Link')}</label>
        <input
          ref={ref}
          className="link-input"
          defaultValue={url}
          placeholder={t(LINK_PLACEHOLDERS[kind ?? 'default'])}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === 'Escape') (e.target as HTMLInputElement).blur();
          }}
          onBlur={(e) => {
            let next = e.target.value.trim();
            if (next && !/^[a-z]+:\/\//i.test(next)) next = `https://${next}`;
            if (next && next !== url && isUrl(next)) void fetchLinkPreview(el.id, next);
            stopEditing();
          }}
        />
      </div>
    );
  }
  if (embed) {
    return (
      <div className={`card link link-embed embed-${embed.kind}`}>
        <div className="embed-frame" style={embed.ratio ? { aspectRatio: `1 / ${embed.ratio}` } : { height: embed.height }}>
          <iframe
            src={embed.src}
            title={title || url}
            loading="lazy"
            allow="autoplay; encrypted-media; picture-in-picture; fullscreen; clipboard-write"
            referrerPolicy="strict-origin-when-cross-origin"
            style={{ pointerEvents: selected ? 'auto' : 'none' }}
          />
          {!selected && <div className="embed-shield" title={t('Click to select, then use the player')} />}
        </div>
        <div className="link-site embed-bar">
          <span>{title && !loading ? title : site || hostOf(url)}</span>
          <a data-nodrag className="link-open" href={safeUrl(url) ?? undefined} target="_blank" rel="noopener noreferrer" title={t('Open link')}>
            ↗
          </a>
        </div>
      </div>
    );
  }
  return (
    <div className="card link">
      {image && !imageFailed && (
        <div className="link-image">
          <img src={image} alt="" draggable={false} loading="lazy" referrerPolicy="no-referrer" onError={() => setImageFailed(true)} />
        </div>
      )}
      <div className="link-text">
        <div className="link-title">{loading ? t('Loading preview…') : title || url}</div>
        {description && !loading && <div className="link-desc">{description}</div>}
        <div className="link-site">
          <img className="favicon" src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(hostOf(url))}&sz=32`} alt="" referrerPolicy="no-referrer" onError={(e) => (e.currentTarget.style.visibility = 'hidden')} />
          <span>{site || hostOf(url)}</span>
          <a data-nodrag className="link-open" href={safeUrl(url) ?? undefined} target="_blank" rel="noopener noreferrer" title={t('Open link')}>
            ↗
          </a>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- colour swatch

function SwatchBody({ el, editing }: BodyProps<'swatch'>) {
  const { hex, name } = el.content;
  const ref = useAutoFocus<HTMLInputElement>(editing);
  return (
    <div className="card swatch">
      <div className="swatch-color" style={{ background: hex }}>
        {editing && (
          <input
            data-nodrag
            type="color"
            value={/^#[0-9a-f]{6}$/i.test(hex) ? hex : '#000000'}
            onChange={(e) => patchElement(el.id, { content: { hex: e.target.value } }, { coalesce: `swatch:${el.id}` })}
            title={t('Pick colour')}
          />
        )}
      </div>
      <div className="swatch-meta">
        {editing ? (
          <input
            ref={ref}
            className="swatch-name-input"
            defaultValue={name ?? ''}
            placeholder={t('Name')}
            onKeyDown={(e) => (e.key === 'Enter' || e.key === 'Escape') && (e.target as HTMLInputElement).blur()}
            onBlur={(e) => {
              patchElement(el.id, { content: { name: e.target.value.trim() } });
              stopEditing();
            }}
          />
        ) : (
          name && <div className="swatch-name">{name}</div>
        )}
        <div className="swatch-hex">{hex.toUpperCase()}</div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- file

// Media fragments (#t=start,end) make uploaded audio/video play only that part.
function mediaSrc(src: string, media?: MediaOptions) {
  if (!media?.start && !media?.end) return src;
  return `${src}#t=${media.start ?? 0}${media.end ? `,${media.end}` : ''}`;
}

export function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function FileBody({ el }: BodyProps<'file'>) {
  const { name, size, src, mime } = el.content;
  const ext = (name.split('.').pop() || 'file').slice(0, 4).toUpperCase();
  const media = mime.startsWith('video/') ? 'video' : mime.startsWith('audio/') ? 'audio' : null;
  return (
    <div className={`card file ${media ? 'file-media' : ''}`}>
      {media === 'video' && (
        <video
          data-nodrag
          src={mediaSrc(src, el.content.media)}
          controls
          preload="metadata"
          className="file-video"
          loop={el.content.media?.loop}
          autoPlay={el.content.media?.autoplay}
          muted={el.content.media?.autoplay}
          playsInline
        />
      )}
      {media === 'audio' && (
        <audio data-nodrag src={mediaSrc(src, el.content.media)} controls preload="metadata" className="file-audio" loop={el.content.media?.loop} autoPlay={el.content.media?.autoplay} />
      )}
      {mime === 'application/pdf' && (
        <a data-nodrag className="file-preview-link" href={safeUrl(src) ?? undefined} target="_blank" rel="noopener">
          {t('Preview PDF ↗')}
        </a>
      )}
      <div className="file-row">
      <div className="file-icon" data-kind={mime.split('/')[0]}>
        {ext}
      </div>
      <div className="file-text">
        <div className="file-name" title={name}>
          {name}
        </div>
        <div className="file-size">{formatSize(size)}</div>
      </div>
        <a data-nodrag className="icon-btn small" href={safeUrl(src) ?? undefined} download={name} title={t('Download')}>
          ⤓
        </a>
      </div>
    </div>
  );
}
