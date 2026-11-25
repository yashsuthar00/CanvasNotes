// Board exports: PNG / print of the visible layout, and a linear document
// (Markdown, plain text, Word) that walks the board and optionally its sub-boards.
import { toPng } from 'html-to-image';
import { boardPath, columnChildren, getState, toast } from './store';
import type { El } from './types';
import { htmlToMarkdown, downloadText, htmlToWordDoc, safeFileName } from './markdown';
import { htmlToText } from './actions';
import { allRects, union } from './viewport';

function boardTitle(id: string) {
  return boardPath(id).slice(-1)[0].title;
}

// Cards in reading order: top to bottom, then left to right.
function readingOrder(boardId: string): El[] {
  const { elements } = getState();
  const rects = allRects();
  return Object.values(elements)
    .filter((e) => e.parentId === boardId && e.section === 'canvas' && !e.columnId && e.type !== 'line' && e.type !== 'label')
    .sort((a, b) => {
      const ra = rects.get(a.id) ?? { x: a.x, y: a.y };
      const rb = rects.get(b.id) ?? { x: b.x, y: b.y };
      return Math.abs(ra.y - rb.y) > 40 ? ra.y - rb.y : ra.x - rb.x;
    });
}

function escapeHtml(t: string) {
  return t.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
}

// Builds HTML for a board; Markdown and text are derived from it.
function boardHtml(boardId: string, subBoards: boolean, depth = 1, seen = new Set<string>()): string {
  if (seen.has(boardId)) return '';
  seen.add(boardId);
  const h = (n: number) => `h${Math.min(6, n)}`;
  const parts: string[] = [];
  const render = (el: El, level: number): void => {
    switch (el.type) {
      case 'note':
        parts.push(el.content.html);
        break;
      case 'heading':
        parts.push(`<${h(level + 1)}>${escapeHtml(el.content.text)}</${h(level + 1)}>`);
        break;
      case 'document':
        parts.push(`<${h(level + 1)}>${escapeHtml(el.content.title || 'Document')}</${h(level + 1)}>${el.content.html}`);
        break;
      case 'todo':
        parts.push(
          (el.content.title ? `<p><strong>${escapeHtml(el.content.title)}</strong></p>` : '') +
            `<ul data-type="taskList">${el.content.items
              .filter((i) => i.text.trim())
              .map((i) => `<li data-checked="${i.done}"><p>${escapeHtml(i.text)}${i.due ? ` (due ${i.due})` : ''}</p></li>`)
              .join('')}</ul>`,
        );
        break;
      case 'link':
        parts.push(`<p><a href="${el.content.url}">${escapeHtml(el.content.title || el.content.url)}</a>${el.content.description ? ` — ${escapeHtml(el.content.description)}` : ''}</p>`);
        break;
      case 'image':
        parts.push(`<p><img src="${location.origin}${el.content.src}" alt="${escapeHtml(el.content.caption ?? '')}">${el.content.caption ? `<br>${escapeHtml(el.content.caption)}` : ''}</p>`);
        break;
      case 'file':
        parts.push(`<p><a href="${location.origin}${el.content.src}">${escapeHtml(el.content.name)}</a></p>`);
        break;
      case 'voice':
        if (el.content.src) parts.push(`<p><a href="${location.origin}${el.content.src}">${escapeHtml(el.content.name)}</a></p>`);
        break;
      case 'swatch':
        parts.push(`<p>Colour: ${escapeHtml(el.content.name ? `${el.content.name} ` : '')}${el.content.hex}</p>`);
        break;
      case 'table': {
        const rows = el.content.cells
          .map((r, i) => `<tr>${r.map((c) => (i === 0 && el.content.header ? `<th>${escapeHtml(c)}</th>` : `<td>${escapeHtml(c)}</td>`)).join('')}</tr>`)
          .join('');
        parts.push((el.content.title ? `<p><strong>${escapeHtml(el.content.title)}</strong></p>` : '') + `<table>${rows}</table>`);
        break;
      }
      case 'comment':
        el.content.comments.forEach((c) => parts.push(`<blockquote><p>${escapeHtml(c.text)}</p></blockquote>`));
        break;
      case 'column':
        parts.push(`<${h(level + 1)}>${escapeHtml(el.content.title || 'Column')}</${h(level + 1)}>`);
        columnChildren(el.id).forEach((kid) => render(kid, level + 1));
        break;
      case 'board':
        if (subBoards) {
          parts.push(`<${h(level + 1)}>${escapeHtml(el.content.title || 'Untitled board')}</${h(level + 1)}>`);
          parts.push(boardHtml(el.id, true, level + 1, seen));
        } else {
          parts.push(`<p>▦ ${escapeHtml(el.content.title || 'Untitled board')}</p>`);
        }
        break;
      default:
        break;
    }
    if (el.caption) parts.push(`<p><em>${escapeHtml(el.caption)}</em></p>`);
  };
  readingOrder(boardId).forEach((el) => render(el, depth));
  return parts.join('\n');
}

// Markdown tables need their own handling; htmlToMarkdown flattens them.
function tablesToMarkdown(html: string) {
  return html.replace(/<table>([\s\S]*?)<\/table>/g, (_, inner: string) => {
    const rows = [...inner.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((m) => [...m[1].matchAll(/<t[hd]>([\s\S]*?)<\/t[hd]>/g)].map((c) => c[1].replace(/\|/g, '\\|')));
    if (!rows.length) return '';
    const head = rows[0];
    const lines = [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.slice(1).map((r) => `| ${r.join(' | ')} |`)];
    return `<pre data-md>${lines.join('\n')}</pre>`;
  });
}

export function exportBoardMarkdown(boardId: string, subBoards: boolean) {
  const title = boardTitle(boardId);
  const md = htmlToMarkdown(tablesToMarkdown(boardHtml(boardId, subBoards))).replace(/```\n(\|[\s\S]*?)\n```/g, '$1');
  downloadText(`${safeFileName(title)}.md`, `# ${title}\n\n${md}\n`, 'text/markdown');
}

export function exportBoardText(boardId: string, subBoards: boolean) {
  const title = boardTitle(boardId);
  downloadText(`${safeFileName(title)}.txt`, `${title}\n\n${htmlToText(boardHtml(boardId, subBoards))}\n`);
}

export function exportBoardWord(boardId: string, subBoards: boolean) {
  const title = boardTitle(boardId);
  downloadText(`${safeFileName(title)}.doc`, htmlToWordDoc(title, `<h1>${escapeHtml(title)}</h1>${boardHtml(boardId, subBoards)}`), 'application/msword');
}

const BLANK_PIXEL = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';

// Renders the whole board (not just the visible part) to a PNG, or opens it for printing as PDF.
export async function exportBoardPng(boardId: string, pixelRatio = 2, print = false) {
  const world = document.querySelector<HTMLElement>('.world');
  const canvas = document.querySelector<HTMLElement>('.canvas');
  if (!world || !canvas) return;
  const rects = [...allRects().values()];
  if (!rects.length) return toast('This board is empty');
  const box = union(rects);
  const pad = 40;
  const bg = getComputedStyle(canvas).backgroundColor;
  try {
    const render = toPng(world, {
      pixelRatio,
      backgroundColor: bg,
      width: box.w + pad * 2,
      height: box.h + pad * 2,
      style: { transform: `translate(${pad - box.x}px, ${pad - box.y}px)`, left: '0', top: '0' },
      // Images from other sites (favicons, previews) usually can't be read back: leave a blank instead.
      imagePlaceholder: BLANK_PIXEL,
      filter: (node) => !(node instanceof HTMLElement && node.classList.contains('resize-handle')),
    });
    const url = await Promise.race([render, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 30000))]);
    const title = safeFileName(boardTitle(boardId));
    if (print) {
      const w = window.open('', '_blank');
      if (!w) return;
      w.document.write(`<!doctype html><title>${title}</title><style>body{margin:0}img{width:100%}</style><img src="${url}">`);
      w.document.close();
      const img = w.document.querySelector('img');
      if (img?.complete) w.print();
      else if (img) img.onload = () => w.print();
    } else {
      const a = document.createElement('a');
      a.href = url;
      a.download = `${title}.png`;
      a.click();
    }
  } catch {
    toast("Couldn't render the board (an external image may block it)");
  }
}
