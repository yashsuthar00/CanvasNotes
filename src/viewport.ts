// Per-board pan/zoom, kept out of the element store so panning does not
// re-render every card. Also holds the measured world rect of every rendered
// element, used for lines, drop targets and "fit to content".
import { useSyncExternalStore } from 'react';
import type { Rect, Viewport } from './types';
import { userKey } from './api';

const DEFAULT_VP: Viewport = { x: 120, y: 90, zoom: 1 };
export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 3;

const viewports: Record<string, Viewport> = {};
const vpListeners = new Set<() => void>();
let saveTimer: ReturnType<typeof setTimeout> | null = null;

export function getViewport(boardId: string): Viewport {
  if (!viewports[boardId]) {
    let vp = DEFAULT_VP;
    try {
      const raw = localStorage.getItem(userKey(`cn:vp:${boardId}`));
      if (raw) {
        const parsed = JSON.parse(raw);
        if ([parsed.x, parsed.y, parsed.zoom].every((n) => typeof n === 'number' && Number.isFinite(n))) vp = parsed;
      }
    } catch {}
    viewports[boardId] = vp;
  }
  return viewports[boardId];
}

export function setViewport(boardId: string, vp: Viewport) {
  viewports[boardId] = { ...vp, zoom: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, vp.zoom)) };
  vpListeners.forEach((l) => l());
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(userKey(`cn:vp:${boardId}`), JSON.stringify(viewports[boardId]));
    } catch {}
  }, 300);
}

export function useViewport(boardId: string): Viewport {
  return useSyncExternalStore(
    (l) => {
      vpListeners.add(l);
      return () => vpListeners.delete(l);
    },
    () => getViewport(boardId),
  );
}

// ---------------------------------------------------------------- canvas geometry

let canvasNode: HTMLElement | null = null;
let currentBoard = 'root';

export function registerCanvas(node: HTMLElement | null, boardId: string) {
  canvasNode = node;
  currentBoard = boardId;
}

export function canvasRect(): DOMRect | null {
  return canvasNode?.getBoundingClientRect() ?? null;
}

export function isOverCanvas(clientX: number, clientY: number): boolean {
  const r = canvasRect();
  if (!r || clientX < r.left || clientX > r.right || clientY < r.top || clientY > r.bottom) return false;
  const hit = document.elementFromPoint(clientX, clientY);
  return !!hit && !!canvasNode && canvasNode.contains(hit);
}

export function screenToWorld(clientX: number, clientY: number, boardId = currentBoard) {
  const r = canvasRect();
  const vp = getViewport(boardId);
  return { x: (clientX - (r?.left ?? 0) - vp.x) / vp.zoom, y: (clientY - (r?.top ?? 0) - vp.y) / vp.zoom };
}

export function viewCenter(boardId = currentBoard) {
  const r = canvasRect();
  return screenToWorld((r?.left ?? 0) + (r?.width ?? 800) / 2, (r?.top ?? 0) + (r?.height ?? 600) / 2, boardId);
}

export function zoomAt(boardId: string, factor: number, clientX?: number, clientY?: number) {
  const r = canvasRect();
  const vp = getViewport(boardId);
  const cx = clientX ?? (r ? r.left + r.width / 2 : 0);
  const cy = clientY ?? (r ? r.top + r.height / 2 : 0);
  const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, vp.zoom * factor));
  const px = cx - (r?.left ?? 0);
  const py = cy - (r?.top ?? 0);
  setViewport(boardId, { zoom, x: px - ((px - vp.x) * zoom) / vp.zoom, y: py - ((py - vp.y) * zoom) / vp.zoom });
}

export function centerOn(boardId: string, rect: Rect, zoom?: number) {
  const r = canvasRect();
  const vp = getViewport(boardId);
  const z = zoom ?? vp.zoom;
  const w = r?.width ?? 800;
  const h = r?.height ?? 600;
  setViewport(boardId, { zoom: z, x: w / 2 - (rect.x + rect.w / 2) * z, y: h / 2 - (rect.y + rect.h / 2) * z });
}

export function fitRects(boardId: string, list: Rect[]) {
  const r = canvasRect();
  if (!r) return;
  if (list.length === 0) return setViewport(boardId, DEFAULT_VP);
  const box = union(list);
  const pad = 80;
  const zoom = Math.min(1.25, Math.max(MIN_ZOOM, Math.min((r.width - pad * 2) / box.w, (r.height - pad * 2) / box.h)));
  centerOn(boardId, box, zoom);
}

// ---------------------------------------------------------------- measured rects

let rects = new Map<string, Rect>();
let rectsVersion = 0;
const rectListeners = new Set<() => void>();

export function getRect(id: string): Rect | undefined {
  return rects.get(id);
}

export function allRects(): Map<string, Rect> {
  return rects;
}

export function replaceRects(next: Map<string, Rect>) {
  let changed = next.size !== rects.size;
  if (!changed) {
    for (const [id, r] of next) {
      const o = rects.get(id);
      if (!o || o.x !== r.x || o.y !== r.y || o.w !== r.w || o.h !== r.h) {
        changed = true;
        break;
      }
    }
  }
  if (!changed) return;
  rects = next;
  rectsVersion++;
  rectListeners.forEach((l) => l());
}

export function useRectsVersion(): number {
  return useSyncExternalStore(
    (l) => {
      rectListeners.add(l);
      return () => rectListeners.delete(l);
    },
    () => rectsVersion,
  );
}

export function union(list: Rect[]): Rect {
  const x1 = Math.min(...list.map((r) => r.x));
  const y1 = Math.min(...list.map((r) => r.y));
  const x2 = Math.max(...list.map((r) => r.x + r.w));
  const y2 = Math.max(...list.map((r) => r.y + r.h));
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

export function contains(r: Rect, p: { x: number; y: number }, pad = 0) {
  return p.x >= r.x - pad && p.x <= r.x + r.w + pad && p.y >= r.y - pad && p.y <= r.y + r.h + pad;
}

export function intersects(a: Rect, b: Rect) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

// ---------------------------------------------------------------- arrow-key panning

// Holding arrow keys glides the view (diagonally with two keys) instead of
// jumping by the keyboard's repeat rate. Speed is in screen pixels so it feels
// the same at every zoom; Shift goes faster.
const PAN_SPEED = 900; // px per second
const held = new Set<string>();
let panFast = false;
let panFrame = 0;
let panLast = 0;

function panStep(now: number) {
  const dt = Math.min(0.05, (now - panLast) / 1000);
  panLast = now;
  const dx = (held.has('ArrowLeft') ? 1 : 0) - (held.has('ArrowRight') ? 1 : 0);
  const dy = (held.has('ArrowUp') ? 1 : 0) - (held.has('ArrowDown') ? 1 : 0);
  if (!dx && !dy) {
    panFrame = 0;
    return;
  }
  const len = Math.hypot(dx, dy);
  const dist = PAN_SPEED * (panFast ? 2.5 : 1) * dt;
  const vp = getViewport(currentBoard);
  setViewport(currentBoard, { ...vp, x: vp.x + (dx / len) * dist, y: vp.y + (dy / len) * dist });
  panFrame = requestAnimationFrame(panStep);
}

export function startKeyPan(key: string, fast: boolean) {
  held.add(key);
  flight = 0; // steering by hand ends a fly-to
  panFast = fast;
  if (!panFrame) {
    panLast = performance.now();
    panFrame = requestAnimationFrame(panStep);
  }
}

export function stopKeyPan(key?: string) {
  if (key) held.delete(key);
  else held.clear();
}

export function isKeyPanning() {
  return held.size > 0;
}

// ---------------------------------------------------------------- fly to

// Glides the view to a new pan/zoom. Stops early if anything else moves the
// view meanwhile (a drag, the wheel, the arrow keys), so the user always wins.
let flight = 0;

export function flyTo(boardId: string, to: Viewport, ms = 320) {
  const from = getViewport(boardId);
  if (ms <= 0 || matchMedia('(prefers-reduced-motion: reduce)').matches) {
    flight = 0;
    return setViewport(boardId, to);
  }
  const id = ++flight;
  const t0 = performance.now();
  let last = from;
  const step = (now: number) => {
    if (id !== flight || getViewport(boardId) !== last) return;
    const k = Math.min(1, (now - t0) / ms);
    const e = 1 - (1 - k) ** 3;
    // Zoom moves in log space so zooming in and out feel equally fast.
    const zoom = from.zoom * (to.zoom / from.zoom) ** e;
    setViewport(boardId, { x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e, zoom });
    last = getViewport(boardId);
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// The view that shows a world rect in the middle of the board: the current zoom
// (at least 100% when zoomed far out, so cards are readable on arrival), or
// zoomed out just enough to fit it.
export function viewFor(boardId: string, rect: Rect, pad = 60): Viewport {
  const r = canvasRect();
  const w = r?.width ?? 800;
  const h = r?.height ?? 600;
  const current = getViewport(boardId).zoom;
  const zoom = Math.max(MIN_ZOOM, Math.min(Math.max(current, 1), (w - pad * 2) / rect.w, (h - pad * 2) / rect.h));
  return { zoom, x: w / 2 - (rect.x + rect.w / 2) * zoom, y: h / 2 - (rect.y + rect.h / 2) * zoom };
}
