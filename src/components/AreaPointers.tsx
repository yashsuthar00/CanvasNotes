// Arrows on the board's edges that point to content off screen, shown only
// while the view is on empty space. Areas whose arrows would land on top of
// each other share one arrow (far away, everything looks like one direction);
// coming closer splits them. Clicking an arrow flies to that content.
import { useEffect, useMemo, useRef, useState } from 'react';
import { computeAreas, goToArea, type Area } from '../areas';
import { intersects, useRectsVersion, useViewport } from '../viewport';
import { t } from '../i18n';

const INSET = 30; // px from the board's edge to the arrow's centre
const BOTTOM = 84; // more at the bottom, so arrows pass above the Select / Move switch
const MERGE = 60; // arrows closer than this become one

type Pointer = { key: string; x: number; y: number; angle: number; areas: Area[]; cards: number };

export function AreaPointers({ boardId, ids }: { boardId: string; ids: string[] }) {
  const vp = useViewport(boardId);
  const rectsVersion = useRectsVersion();
  // Re-grouped only when cards move or resize, never while panning.
  const areas = useMemo(() => computeAreas(ids), [ids, rectsVersion]);
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const ro = new ResizeObserver(() => setSize({ w: node.clientWidth, h: node.clientHeight }));
    ro.observe(node);
    return () => ro.disconnect();
  }, []);

  let pointers: Pointer[] = [];
  if (size && areas.length) {
    const { w, h } = size;
    const view = { x: -vp.x / vp.zoom, y: -vp.y / vp.zoom, w: w / vp.zoom, h: h / vp.zoom };
    const onContent = areas.some((a) => intersects(a.rect, view) && a.members.some((r) => intersects(r, view)));
    if (!onContent) pointers = place(areas, vp, w, h);
  }

  return (
    <div ref={ref} className="area-pointers" aria-hidden={pointers.length ? undefined : true}>
      {pointers.map((p) => (
        <button
          key={p.key}
          className="area-pointer"
          style={{ transform: `translate(${p.x}px, ${p.y}px)` }}
          title={p.cards === 1 ? t('Content this way: 1 card') : t('Content this way: {n} cards', { n: p.cards })}
          aria-label={p.cards === 1 ? t('Content this way: 1 card') : t('Content this way: {n} cards', { n: p.cards })}
          onPointerDown={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          onClick={() => goToArea(boardId, nearest(p.areas, vp, size!))}
        >
          <svg viewBox="0 0 24 24" width="22" height="22" style={{ transform: `rotate(${p.angle}rad)` }}>
            <path d="M5 12h13M13 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          {p.areas.length > 1 && <span className="area-count">{p.areas.length}</span>}
        </button>
      ))}
    </div>
  );
}

function screenCentre(a: Area[], vp: { x: number; y: number; zoom: number }) {
  // The middle of the group's cards, weighted by how many cards each area has.
  let x = 0, y = 0, n = 0;
  for (const area of a) {
    x += (area.rect.x + area.rect.w / 2) * area.count;
    y += (area.rect.y + area.rect.h / 2) * area.count;
    n += area.count;
  }
  return { x: (x / n) * vp.zoom + vp.x, y: (y / n) * vp.zoom + vp.y };
}

// Where the line from the middle of the arrows' frame towards a point meets that frame.
function edgePoint(target: { x: number; y: number }, w: number, h: number) {
  const cy = (INSET + h - BOTTOM) / 2;
  const dx = target.x - w / 2;
  const dy = target.y - cy;
  const s = Math.min((w / 2 - INSET) / Math.abs(dx || 1e-9), (cy - INSET) / Math.abs(dy || 1e-9));
  return { x: w / 2 + dx * s, y: cy + dy * s, angle: Math.atan2(dy, dx) };
}

function place(areas: Area[], vp: { x: number; y: number; zoom: number }, w: number, h: number): Pointer[] {
  const groups: Area[][] = [];
  const points: { x: number; y: number; angle: number }[] = [];
  // Nearest first, so a group is named (keyed) after its nearest area and stays stable while panning.
  const byDistance = areas
    .map((a) => ({ a, c: screenCentre([a], vp) }))
    .sort((p, q) => Math.hypot(p.c.x - w / 2, p.c.y - h / 2) - Math.hypot(q.c.x - w / 2, q.c.y - h / 2));
  for (const { a, c } of byDistance) {
    const p = edgePoint(c, w, h);
    const i = points.findIndex((q) => Math.hypot(q.x - p.x, q.y - p.y) < MERGE);
    if (i < 0) {
      groups.push([a]);
      points.push(p);
    } else {
      groups[i].push(a);
      points[i] = edgePoint(screenCentre(groups[i], vp), w, h);
    }
  }
  // Re-centring a group can bring it next to another one; fold those together too.
  for (let i = 0; i < groups.length; i++)
    for (let j = i + 1; j < groups.length; j++)
      if (Math.hypot(points[i].x - points[j].x, points[i].y - points[j].y) < MERGE) {
        groups[i].push(...groups[j]);
        groups.splice(j, 1);
        points.splice(j, 1);
        points[i] = edgePoint(screenCentre(groups[i], vp), w, h);
        j = i;
      }
  return groups.map((g, i) => ({
    key: g[0].id,
    x: points[i].x,
    y: points[i].y,
    angle: points[i].angle,
    areas: g,
    cards: g.reduce((n, a) => n + a.count, 0),
  }));
}

function nearest(areas: Area[], vp: { x: number; y: number; zoom: number }, size: { w: number; h: number }) {
  const d = (a: Area) => {
    const c = screenCentre([a], vp);
    return Math.hypot(c.x - size.w / 2, c.y - size.h / 2);
  };
  return areas.reduce((best, a) => (d(a) < d(best) ? a : best));
}
