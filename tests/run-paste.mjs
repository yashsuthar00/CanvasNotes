// Pasting lands centred on the pointer: images (400 wide), text, links, files
// and copied cards, at several zooms; inside a column it joins the column, and
// one undo removes the paste.
//   node tests/run-paste.mjs [check ids]      (port 5215)
import { createSuite, rand, assert, wait } from './harness.mjs';

const suite = await createSuite('paste');
const { check, shot, fact } = suite;
const S = await suite.startServer('main', 5215, { CANVASNOTES_SIGNUPS: 'open' });
const B = S.base;
const p = await suite.newPage();
await suite.signup(p, B, `paste-${rand()}@example.com`, 'owner-password');
const el = (id, type, extra) => ({ op: 'put', el: { id, type, parentId: 'pb', section: 'canvas', x: 0, y: 0, w: 270, z: 1, columnId: null, createdAt: 1, updatedAt: 1, ...extra } });
await p.request.post(`${B}/api/ops`, {
  data: {
    ops: [
      el('pb', 'board', { parentId: 'root', w: 110, content: { title: 'Paste' } }),
      el('n1', 'note', { x: 60, y: 60, content: { html: '<p>One</p>' } }),
      el('n2', 'note', { x: 400, y: 160, content: { html: '<p>Two</p><p>lines</p>' } }),
      el('col', 'column', { x: 3000, y: 0, w: 300, content: { title: 'Column' } }),
      el('inCol', 'note', { columnId: 'col', order: 1, content: { html: '<p>In column</p>' } }),
    ],
  },
});
await p.goto(`${B}/#/b/pb`);
await p.waitForSelector('[data-el="n1"]');
await wait(300);

const ids = () => p.$$eval('[data-el]', (n) => n.map((x) => x.dataset.el));
// Pastes at a screen point and returns the new cards' ids and their combined box.
async function pasteAt(x, y, make, ms = 900) {
  const had = new Set(await ids());
  await p.mouse.move(x, y);
  await make();
  await wait(ms);
  const fresh = (await ids()).filter((id) => !had.has(id));
  const box = await p.evaluate((list) => {
    const rs = list.map((id) => document.querySelector(`[data-el="${id}"]`).getBoundingClientRect());
    const l = Math.min(...rs.map((r) => r.left)), t = Math.min(...rs.map((r) => r.top)), r = Math.max(...rs.map((q) => q.right)), b = Math.max(...rs.map((q) => q.bottom));
    return { cx: (l + r) / 2, cy: (t + b) / 2, w: r - l, h: b - t };
  }, fresh);
  return { fresh, ...box };
}
const clip = (kind, value = '', size = [800, 500]) => () =>
  p.evaluate(async ([kind, value, size]) => {
    const dt = new DataTransfer();
    if (kind === 'image') {
      const c = document.createElement('canvas');
      [c.width, c.height] = size;
      c.getContext('2d').fillStyle = `hsl(${Math.random() * 360} 70% 60%)`;
      c.getContext('2d').fillRect(0, 0, ...size);
      dt.items.add(new File([await new Promise((r) => c.toBlob(r))], 'shot.png', { type: 'image/png' }));
    } else if (kind === 'file') dt.items.add(new File([value], 'notes.txt', { type: 'text/plain' }));
    else dt.setData('text/plain', value);
    document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, [kind, value, size]);
const zoom = () => p.$eval('.world', (n) => Number(n.style.transform.match(/scale\(([\d.]+)\)/)[1]));
const near = (box, x, y, what) => assert(Math.abs(box.cx - x) <= 2 && Math.abs(box.cy - y) <= 2, `${what}: centre ${box.cx.toFixed(1)},${box.cy.toFixed(1)} for pointer ${x},${y}`);
const undo = async () => { await p.keyboard.press('Control+z'); await wait(150); };

await check('V1', 'Image: pointer in the middle and 400 px wide at 100%', async () => {
  const r = await pasteAt(640, 420, clip('image'));
  await shot(p, 'image pasted');
  assert(r.fresh.length === 1, `${r.fresh.length} cards`);
  near(r, 640, 420, 'image');
  assert(Math.abs(r.w - 400) <= 1 && Math.abs(r.h - 250) <= 4, `size ${r.w}×${r.h}`);
  const had = (await ids()).length;
  await undo();
  assert((await ids()).length === had - 1, 'one undo did not remove it');
  await p.keyboard.press('Control+Shift+z');
  await wait(200);
  const again = await p.locator(`[data-el="${r.fresh[0]}"]`).boundingBox();
  near({ cx: again.x + again.width / 2, cy: again.y + again.height / 2 }, 640, 420, 'after redo');
  await undo();
});

await check('V2', 'Portrait, tiny and wide images are centred too', async () => {
  for (const size of [[320, 900], [40, 40], [1600, 200]]) {
    near(await pasteAt(700, 400, clip('image', '', size)), 700, 400, size.join('×'));
    await undo();
  }
});

await check('V3', 'Text, link and file: pointer in the middle', async () => {
  near(await pasteAt(600, 380, clip('text', 'Some pasted text\nsecond line\n\nThird')), 600, 380, 'text');
  await undo();
  near(await pasteAt(620, 360, clip('text', 'http://127.0.0.1:9/nothing'), 60), 620, 360, 'link');
  await wait(800);
  await undo();
  near(await pasteAt(640, 400, clip('file', 'hello')), 640, 400, 'file');
  await undo();
});

await check('V4', 'Copied cards: the group is centred on the pointer, layout kept', async () => {
  await p.keyboard.press('Escape');
  await p.click('[data-el="n1"]', { position: { x: 5, y: 5 } });
  await p.click('[data-el="n2"]', { position: { x: 5, y: 5 }, modifiers: ['Shift'] });
  await p.keyboard.press('Control+c');
  const text = await p.evaluate(() => 'One\n\nTwo\nlines');
  const r = await pasteAt(700, 520, clip('text', text));
  fact(`${r.fresh.length} cards`);
  assert(r.fresh.length === 2, `${r.fresh.length} cards pasted`);
  near(r, 700, 520, 'group');
  const pos = await p.evaluate((list) => list.map((id) => { const b = document.querySelector(`[data-el="${id}"]`).getBoundingClientRect(); return [b.left, b.top]; }).sort((a, b) => a[0] - b[0]), r.fresh);
  assert(Math.abs(pos[1][0] - pos[0][0] - 340) < 2 && Math.abs(pos[1][1] - pos[0][1] - 100) < 2, `layout ${JSON.stringify(pos)}`);
  await undo();
});

await check('V5', 'Right-click → Paste centres on the clicked point', async () => {
  const had = new Set(await ids());
  await p.keyboard.press('Escape');
  await p.mouse.click(800, 500, { button: 'right' });
  await p.locator('.menu button', { hasText: 'Paste' }).first().click();
  await wait(400);
  const fresh = (await ids()).filter((id) => !had.has(id));
  const rs = [];
  for (const id of fresh) rs.push(await p.locator(`[data-el="${id}"]`).boundingBox());
  const l = Math.min(...rs.map((r) => r.x)), t = Math.min(...rs.map((r) => r.y)), r = Math.max(...rs.map((q) => q.x + q.width)), b = Math.max(...rs.map((q) => q.y + q.height));
  near({ cx: (l + r) / 2, cy: (t + b) / 2 }, 800, 500, 'menu paste');
  await undo();
});

await check('V6', 'Other zooms: still centred at about 200% and 50%', async () => {
  for (const [key, n] of [['Control+=', 4], ['Control+-', 8]]) {
    for (let i = 0; i < n; i++) await p.keyboard.press(key);
    await wait(150);
    const z = await zoom();
    const r = await pasteAt(650, 400, clip('image'));
    near(r, 650, 400, `zoom ${z}`);
    assert(Math.abs(r.w - 400 * z) <= 2, `width ${r.w} at zoom ${z}`);
    await undo();
    await p.keyboard.press('Control+0');
    await wait(100);
  }
});

await check('V7', 'Over a column: joins the column; a card copied out of a column pastes on the pointer', async () => {
  await p.keyboard.press('Shift+!');
  await wait(300);
  const c = await p.locator('[data-el="col"]').boundingBox();
  const r = await pasteAt(c.x + c.width / 2, c.y + c.height / 2, clip('image'));
  assert(await p.$(`[data-el="col"] [data-el="${r.fresh[0]}"]`), 'image not in the column');
  await undo();
  await p.keyboard.press('Escape');
  await p.click('[data-el="inCol"]');
  await p.keyboard.press('Control+c');
  const q = await pasteAt(640, 500, clip('text', 'In column'));
  assert(q.fresh.length === 1, `${q.fresh.length} cards`);
  near(q, 640, 500, 'card from a column');
});

await suite.finish();
