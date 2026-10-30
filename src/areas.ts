// Content areas: groups of cards that sit near each other on a board. Used by
// the edge pointers that lead back to content from empty space, and by N /
// Shift N, which jump from one area to the next.
import { getState } from './store';
import type { Rect } from './types';
import { allRects, canvasRect, flyTo, getViewport, union, viewFor } from './viewport';

export type Area = { id: string; rect: Rect; members: Rect[]; count: number };

// Cards closer than this (world px) belong to the same area.
const GAP = 240;
const CELL = 800;

export function topLevelIds(boardId = getState().boardId): string[] {
  return Object.values(getState().elements)
    .filter((el) => el.parentId === boardId && el.section === 'canvas' && !el.columnId && el.type !== 'line')
    .map((el) => el.id);
}

export function computeAreas(ids: string[]): Area[] {
  const items: { id: string; r: Rect }[] = [];
  for (const id of ids) {
    const r = allRects().get(id);
    if (r) items.push({ id, r });
  }
  // Union-find over cards whose GAP-padded boxes touch; a coarse grid keeps it near-linear.
  const parent = items.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const grid = new Map<string, number[]>();
  const half = GAP / 2;
  items.forEach(({ r }, i) => {
    const x1 = Math.floor((r.x - half) / CELL), x2 = Math.floor((r.x + r.w + half) / CELL);
    const y1 = Math.floor((r.y - half) / CELL), y2 = Math.floor((r.y + r.h + half) / CELL);
    for (let gx = x1; gx <= x2; gx++)
      for (let gy = y1; gy <= y2; gy++) {
        const key = `${gx},${gy}`;
        const cell = grid.get(key);
        if (!cell) {
          grid.set(key, [i]);
          continue;
        }
        for (const j of cell) {
          const o = items[j].r;
          if (r.x - GAP < o.x + o.w && r.x + r.w + GAP > o.x && r.y - GAP < o.y + o.h && r.y + r.h + GAP > o.y) parent[find(i)] = find(j);
        }
        cell.push(i);
      }
  });
  const groups = new Map<number, { id: string; r: Rect }[]>();
  items.forEach((it, i) => {
    const root = find(i);
    const g = groups.get(root);
    if (g) g.push(it);
    else groups.set(root, [it]);
  });
  return [...groups.values()].map((g) => {
    const members = g.map((it) => it.r);
    return { id: g.map((it) => it.id).sort()[0], rect: union(members), members, count: g.length };
  });
}

// Reading order (rows top to bottom, left to right within a row), so N walks the board predictably.
export function readingOrder(areas: Area[]): Area[] {
  const row = (a: Area) => Math.floor((a.rect.y + a.rect.h / 2) / 600);
  return [...areas].sort((a, b) => row(a) - row(b) || a.rect.x - b.rect.x);
}

export function goToArea(boardId: string, area: Area) {
  lastJump = { boardId, id: area.id };
  flyTo(boardId, viewFor(boardId, area.rect));
}

// N / Shift N: the next (or previous) area after the one in the middle of the
// view; from empty space, the nearest one first.
let lastJump: { boardId: string; id: string } | null = null;

export function jumpToArea(dir: 1 | -1, boardId = getState().boardId): { index: number; total: number } | null {
  const areas = readingOrder(computeAreas(topLevelIds(boardId)));
  if (!areas.length) return null;
  const r = canvasRect();
  const vp = getViewport(boardId);
  const cx = ((r?.width ?? 800) / 2 - vp.x) / vp.zoom;
  const cy = ((r?.height ?? 600) / 2 - vp.y) / vp.zoom;
  const inside = (a: Area) => cx >= a.rect.x && cx <= a.rect.x + a.rect.w && cy >= a.rect.y && cy <= a.rect.y + a.rect.h;
  let at = areas.findIndex((a) => lastJump?.boardId === boardId && a.id === lastJump.id && inside(a));
  if (at < 0) at = areas.findIndex(inside);
  let index: number;
  if (at >= 0) index = (at + dir + areas.length) % areas.length;
  else {
    const dist = (a: Area) => Math.hypot(a.rect.x + a.rect.w / 2 - cx, a.rect.y + a.rect.h / 2 - cy);
    index = areas.reduce((best, a, i) => (dist(a) < dist(areas[best]) ? i : best), 0);
  }
  goToArea(boardId, areas[index]);
  return { index, total: areas.length };
}
