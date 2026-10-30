// The Select / Move switch. In Move mode (the hand) dragging anywhere, even on
// a card, only moves the view; clicks, double-clicks, right-clicks, keys,
// paste and drops change nothing. Arrows, N, zoom and the edge arrows still
// work, the choice survives a reload, and a phone gets the same with touch.
//   node tests/run-move.mjs [check ids]      (port 5214)
import { createSuite, rand, assert, wait } from './harness.mjs';

const suite = await createSuite('move');
const { check, shot, fact } = suite;
const S = await suite.startServer('main', 5214);
const B = S.base;
const p = await suite.newPage();
await suite.signup(p, B, `move-${rand()}@example.com`, 'owner-password');
const note = (id, x, y, text) => ({ op: 'put', el: { id, type: 'note', parentId: 'mv', section: 'canvas', x, y, z: 1, w: 220, columnId: null, createdAt: 1, updatedAt: 1, content: { html: `<p>${text}</p>` } } });
const link = { op: 'put', el: { id: 'mLink', type: 'link', parentId: 'mv', section: 'canvas', x: 700, y: 120, z: 1, w: 260, columnId: null, createdAt: 1, updatedAt: 1, content: { url: 'https://example.com/', title: 'Example link' } } };
const board = { op: 'put', el: { id: 'mv', type: 'board', parentId: 'root', section: 'canvas', x: 100, y: 100, z: 1, width: 120, columnId: null, createdAt: 1, updatedAt: 1, content: { title: 'Move mode' } } };
await p.request.post(`${B}/api/ops`, { data: { ops: [board, note('m1', 200, 150, 'First card'), note('m2', 300, 420, 'Second card'), link, note('far', 6000, 0, 'Far away')] } });
await p.goto(`${B}/#/b/mv`);
await p.waitForSelector('[data-el="m1"]');
await wait(300);

// What the server holds for this board's cards (positions and text), to prove nothing changed.
const snapshot = async () => {
  const { elements } = await (await p.request.get(`${B}/api/state`)).json();
  return JSON.stringify(Object.values(elements).filter((e) => e.parentId === 'mv').map((e) => [e.id, e.x, e.y, e.content.html ?? e.content.url]).sort());
};
const view = () => p.$eval('.world', (n) => n.style.transform.match(/-?[\d.]+/g).slice(0, 3).map(Number));
const centre = async (sel) => {
  const r = await p.locator(sel).first().boundingBox();
  return [r.x + r.width / 2, r.y + r.height / 2];
};
let before;

await check('M1', 'The switch shows Select by default; H turns on Move, V turns it off', async () => {
  const on = () => p.$eval('.mode-switch', (n) => [...n.querySelectorAll('button')].map((b) => b.getAttribute('aria-checked')).join(','));
  assert((await on()) === 'true,false', `default ${await on()}`);
  await p.keyboard.press('h');
  assert((await on()) === 'false,true', `after H ${await on()}`);
  assert(await p.$eval('.canvas', (n) => n.classList.contains('hand') && getComputedStyle(n).cursor === 'grab'), 'no grab cursor');
  await p.keyboard.press('v');
  assert((await on()) === 'true,false', `after V ${await on()}`);
  await p.click('.mode-switch button[aria-checked="false"]');
  assert((await on()) === 'false,true', 'clicking the hand did not switch');
  await shot(p, 'move mode on');
});

await check('M2', 'Move mode: dragging a card moves the view, not the card', async () => {
  before = await snapshot();
  const v0 = await view();
  const [x, y] = await centre('[data-el="m1"]');
  await p.mouse.move(x, y);
  await p.mouse.down();
  for (let i = 1; i <= 10; i++) await p.mouse.move(x + i * 15, y + i * 8);
  assert(await p.$eval('.canvas', (n) => getComputedStyle(n).cursor === 'grabbing'), 'no grabbing cursor while dragging');
  await p.mouse.up();
  await wait(700);
  const v1 = await view();
  assert(Math.abs(v1[0] - v0[0] - 150) < 2 && Math.abs(v1[1] - v0[1] - 80) < 2, `view moved ${v1[0] - v0[0]},${v1[1] - v0[1]}`);
  assert((await snapshot()) === before, 'a card changed');
});

await check('M3', 'Move mode: click, double-click and right-click on cards and the board do nothing', async () => {
  const pages = p.context().pages().length;
  const [x, y] = await centre('[data-el="m1"]');
  await p.mouse.click(x, y);
  await p.mouse.dblclick(x, y);
  const [lx, ly] = await centre('[data-el="mLink"]');
  await p.mouse.click(lx, ly);
  await p.mouse.dblclick(lx, ly);
  await p.mouse.dblclick(x + 300, y + 260); // empty board: would add a note
  await p.mouse.click(x, y, { button: 'right' });
  await wait(400);
  assert((await p.$$('.item.selected')).length === 0, 'a card got selected');
  assert(!(await p.evaluate(() => document.activeElement?.isContentEditable)), 'a card opened for editing');
  assert((await p.$$('.menu')).length === 0, 'a menu opened');
  assert((await p.$$('.dialog')).length === 0, 'a dialog opened');
  assert(p.context().pages().length === pages, 'the link opened a tab');
  assert((await snapshot()) === before, 'something changed');
});

await check('M4', 'Move mode: editing keys, paste and file drops change nothing', async () => {
  // (Backspace with nothing selected still goes up to the parent board: that's moving around.)
  for (const k of ['Delete', 'Enter', 'd', 'l', 'u', 'Control+a', 'Control+d', 'Control+z', 'Control+x', 'Control+]']) await p.keyboard.press(k);
  await p.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData('text/plain', 'pasted text');
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
    const drop = new DataTransfer();
    drop.items.add(new File(['x'], 'x.txt', { type: 'text/plain' }));
    document.querySelector('.canvas').dispatchEvent(new DragEvent('drop', { dataTransfer: drop, bubbles: true, cancelable: true, clientX: 500, clientY: 400 }));
  });
  await wait(1200);
  assert(await p.$$eval('.dialog, .sketch-editor, .drawing', (n) => n.length) === 0, 'an editor opened');
  assert(new URL(p.url()).hash.includes('/b/mv'), `left the board: ${p.url()}`);
  assert((await snapshot()) === before, 'something changed');
});

await check('M5', 'Move mode: arrow keys, N, zoom and the edge arrows still work', async () => {
  const v0 = await view();
  await p.keyboard.down('ArrowRight');
  await wait(300);
  await p.keyboard.up('ArrowRight');
  const v1 = await view();
  assert(v1[0] < v0[0] - 100, 'arrow keys did not move');
  await p.keyboard.press('Control+=');
  const v2 = await view();
  assert(v2[2] > v1[2], 'zoom did not change');
  await p.keyboard.press('Control+0');
  await p.keyboard.press('n');
  await wait(500);
  // Pan far into empty space, then use an edge arrow.
  await p.mouse.move(600, 400);
  await p.mouse.wheel(0, -4000);
  await wait(200);
  const arrows = await p.$$('.area-pointer');
  assert(arrows.length > 0, 'no edge arrows in Move mode');
  await arrows[0].click();
  await wait(600);
  assert((await p.$$('.area-pointer')).length === 0, 'edge arrow click did nothing');
  assert((await snapshot()) === before, 'something changed');
});

await check('M6', 'Move mode is remembered after a reload', async () => {
  await p.reload();
  await p.waitForSelector('[data-el="m1"]');
  assert(await p.$eval('.canvas', (n) => n.classList.contains('hand')), 'Move mode lost on reload');
});

await check('M7', 'Back to Select: cards can be selected and dragged again; picking a tool also leaves Move mode', async () => {
  await p.click('.mode-switch button[aria-checked="false"]'); // the cursor
  await p.keyboard.press('Shift+!');
  await wait(400);
  const [x, y] = await centre('[data-el="m2"]');
  await p.mouse.click(x, y);
  await wait(200);
  assert((await p.$$('.item.selected')).length === 1, 'card not selectable in Select mode');
  await p.mouse.move(x, y);
  await p.mouse.down();
  for (let i = 1; i <= 8; i++) await p.mouse.move(x + i * 10, y);
  await p.mouse.up();
  await wait(1200);
  assert((await snapshot()) !== before, 'card did not move in Select mode');
  await p.keyboard.press('Escape');
  await p.keyboard.press('h');
  await p.locator('.toolbar .tool').first().click();
  await wait(300);
  assert(!(await p.$eval('.canvas', (n) => n.classList.contains('hand'))), 'a tool did not switch back to Select');
  await p.keyboard.press('Escape');
});

await check('M8', 'Phone: one finger on a card moves the view in Move mode; taps change nothing', async () => {
  // The far card would make "fit everything" too small to touch on a phone.
  await p.request.post(`${B}/api/ops`, { data: { ops: [{ op: 'del', id: 'far' }] } });
  const q = await suite.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, storageState: await p.context().storageState() });
  await q.goto(`${B}/#/b/mv`);
  await q.waitForSelector('[data-el="m1"]');
  await q.keyboard.press('Shift+!');
  await wait(300);
  const sw = await q.locator('.mode-switch button').nth(1).boundingBox();
  assert(sw.height >= 40, `switch too small to tap: ${sw.height}px`);
  await q.locator('.mode-switch button').nth(1).tap();
  const snap = await snapshot();
  const r = await q.locator('[data-el="m1"]').boundingBox();
  const x = r.x + r.width / 2, y = r.y + r.height / 2;
  const v0 = await q.$eval('.world', (n) => n.style.transform);
  const cdp = await q.context().newCDPSession(q);
  const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([px, py]) => ({ x: px, y: py })) });
  await touch('touchStart', [[x, y]]);
  for (let i = 1; i <= 10; i++) {
    await touch('touchMove', [[x - i * 12, y + i * 6]]);
    await wait(16);
  }
  await touch('touchEnd', []);
  await wait(200);
  // Cards ignore the pointer in Move mode, so tap by position (a double tap would open a note).
  const r2 = await q.locator('[data-el="m1"]').boundingBox();
  await q.touchscreen.tap(r2.x + r2.width / 2, r2.y + r2.height / 2);
  await wait(100);
  await q.touchscreen.tap(r2.x + r2.width / 2, r2.y + r2.height / 2);
  await wait(900);
  await shot(q, 'phone move mode');
  const v1 = await q.$eval('.world', (n) => n.style.transform);
  assert(v1 !== v0, `one-finger drag on a card did not move the view (hand ${await q.$eval('.canvas', (n) => n.classList.contains('hand'))}, ${v0} → ${v1}, start ${Math.round(x)},${Math.round(y)})`);
  assert((await q.$$('.item.selected')).length === 0, 'tap selected a card');
  assert((await snapshot()) === snap, 'a card changed');
  fact(`phone switch ${Math.round(sw.width)}×${Math.round(sw.height)} px`);
});

await suite.finish();
