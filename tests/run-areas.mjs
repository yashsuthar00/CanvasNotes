// Edge arrows that lead back to content from empty space, and N / Shift N,
// which jump between groups of cards. Runs on its own board with four groups
// far apart (A has two cards; B and C are 1200 px apart so they share an arrow
// from far away). Also measures frame time while panning.
//   node tests/run-areas.mjs [check ids]      (port 5213)
import { createSuite, rand, assert, wait } from './harness.mjs';
const suite = await createSuite('areas');
const S = await suite.startServer('main', 5213);
const p = await suite.newPage();
await suite.signup(p, S.base, `a-${rand()}@example.com`, 'owner-password');
const note = (id, x, y, text) => ({ op: 'put', el: { id, type: 'note', parentId: 'areas', section: 'canvas', x, y, z: 1, width: 220, columnId: null, createdAt: 1, updatedAt: 1, content: { html: `<p>${text}</p>` } } });
const board = { op: 'put', el: { id: 'areas', type: 'board', parentId: 'root', section: 'canvas', x: 100, y: 100, z: 1, width: 120, columnId: null, createdAt: 1, updatedAt: 1, content: { title: 'Areas' } } };
await p.request.post(`${S.base}/api/ops`, { data: { ops: [board, note('nA', 0, 0, 'Area A'), note('nA2', 260, 40, 'Area A two'), note('nB', 4000, 0, 'Area B'), note('nC', 4000, 1200, 'Area C'), note('nD', 0, 4000, 'Area D')] } });
await p.goto(`${S.base}/#/b/areas`);
await p.waitForSelector('[data-el="nA"]');
await wait(300);
const vp = () => p.$eval('.world', (n) => n.style.transform.match(/-?[\d.]+/g).map(Number));
const size = await p.$eval('.canvas', (n) => ({ w: n.clientWidth, h: n.clientHeight }));
const box = await p.$eval('.canvas', (n) => n.getBoundingClientRect().toJSON());
async function centreOn(x, y) {
  await p.mouse.move(box.x + 300, box.y + 300);
  for (let i = 0; i < 40; i++) {
    const [vx, vy] = await vp();
    const dx = vx - (size.w / 2 - x), dy = vy - (size.h / 2 - y);
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
    await p.mouse.wheel(Math.max(-3000, Math.min(3000, dx)), Math.max(-3000, Math.min(3000, dy)));
    await wait(30);
  }
}
const pointers = () => p.$$eval('.area-pointer', (n) => n.map((b) => ({ label: b.getAttribute('aria-label'), count: b.querySelector('.area-count')?.textContent ?? null, r: b.getBoundingClientRect().toJSON() })));

await suite.check('A1', 'On content: no arrows', async () => {
  const list = await pointers();
  assert(list.length === 0, `${list.length} arrows while cards are on screen`);
});
await suite.check('A2', 'Empty space between the areas: one arrow per area', async () => {
  await centreOn(2000, 1400);
  await wait(100);
  const list = await pointers();
  await suite.shot(p, 'near - four arrows');
  assert(list.length === 4, `expected 4 arrows, got ${list.length}: ${JSON.stringify(list.map((l) => l.label))}`);
  assert(list.some((l) => l.label.includes('2 cards')), 'area A should count its cards: ' + list.map((l) => l.label));
});
await suite.check('A3', 'Far away to the left: arrows that point the same way merge', async () => {
  await centreOn(-20000, 600);
  await wait(100);
  const list = await pointers();
  await suite.shot(p, 'far - merged');
  assert(list.length === 2, `expected 2 arrows, got ${list.length}: ${JSON.stringify(list)}`);
  assert(list.some((l) => l.count === '3'), 'expected one arrow standing for 3 areas');
  for (const l of list) assert(l.r.left >= box.x - 1 && l.r.right <= box.x + box.width + 1 && l.r.top >= box.y - 1 && l.r.bottom <= box.y + box.height + 1, 'arrow off the board');
});
await suite.check('A4', 'Click a merged arrow: flies to the nearest area of it, arrows gone', async () => {
  const btn = p.locator('.area-pointer', { has: p.locator('.area-count') });
  await btn.click();
  await wait(600);
  const list = await pointers();
  const visible = await p.$eval('[data-el="nA"]', (n) => { const r = n.getBoundingClientRect(); const c = document.querySelector('.canvas').getBoundingClientRect(); return r.left >= c.left && r.right <= c.right && r.top >= c.top && r.bottom <= c.bottom; });
  assert(visible, 'area A not on screen after the jump');
  assert(list.length === 0, `${list.length} arrows still showing`);
});
await suite.check('A5', 'N walks the areas in order and wraps; Shift N goes back', async () => {
  const seen = [];
  const centred = () => p.evaluate(() => {
    const c = document.querySelector('.canvas').getBoundingClientRect();
    const mid = { x: c.left + c.width / 2, y: c.top + c.height / 2 };
    let best = null, bd = 1e9;
    for (const n of document.querySelectorAll('[data-el]')) {
      const r = n.getBoundingClientRect();
      const d = Math.hypot(r.left + r.width / 2 - mid.x, r.top + r.height / 2 - mid.y);
      if (d < bd) { bd = d; best = n.dataset.el; }
    }
    return best;
  });
  for (let i = 0; i < 5; i++) {
    await p.keyboard.press('n');
    await wait(500);
    seen.push(await centred());
  }
  await p.keyboard.press('Shift+N');
  await wait(500);
  const back = await centred();
  const toast = await p.locator('.toast').textContent({ timeout: 1000 }).catch(() => '');
  suite.fact(`order ${seen.join(' → ')}, back ${back}, toast "${toast}"`);
  assert(new Set(seen.slice(0, 4).map((s) => s[1])).size === 4, `did not visit 4 areas: ${seen}`);
  assert(seen[4] === seen[0], `did not wrap: ${seen}`);
  assert(back === seen[3], `Shift N went to ${back}, expected ${seen[3]}`);
});
await suite.check('A6', 'Panning 120 frames with arrows showing stays fast', async () => {
  await centreOn(2000, 1400);
  const ms = await p.evaluate(async () => {
    const times = [];
    let last = performance.now();
    for (let i = 0; i < 120; i++) {
      document.querySelector('.canvas').dispatchEvent(new WheelEvent('wheel', { deltaX: 8, deltaY: 3, bubbles: true, cancelable: true }));
      await new Promise((r) => requestAnimationFrame(r));
      const now = performance.now();
      times.push(now - last);
      last = now;
    }
    times.sort((a, b) => a - b);
    return { median: times[60], p95: times[114] };
  });
  suite.fact(`frame time median ${ms.median.toFixed(1)} ms, p95 ${ms.p95.toFixed(1)} ms`);
  assert(ms.p95 < 34, `slow frames: ${JSON.stringify(ms)}`);
});
await suite.check('A7', 'Phone size: arrows on screen and tappable', async () => {
  const q = await suite.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, storageState: await p.context().storageState() });
  await q.goto(`${S.base}/#/b/areas`);
  await q.waitForSelector('[data-el="nA"]');
  await q.mouse.move(100, 300);
  for (let i = 0; i < 3; i++) { await q.mouse.wheel(-2500, -2500); await wait(50); }
  await wait(200);
  const list = await q.$$eval('.area-pointer', (n) => n.map((b) => b.getBoundingClientRect().toJSON()));
  await suite.shot(q, 'phone - arrows');
  assert(list.length >= 1, 'no arrows on phone');
  const c = await q.$eval('.canvas', (n) => n.getBoundingClientRect().toJSON());
  for (const r of list) assert(r.left >= c.left && r.right <= c.right && r.top >= c.top && r.bottom <= c.bottom && r.height >= 40, `arrow out of bounds or small: ${JSON.stringify(r)}`);
  await q.locator('.area-pointer').first().tap();
  await wait(600);
  assert((await q.$$('.area-pointer')).length === 0, 'tap did not bring content on screen');
});
await suite.finish();
