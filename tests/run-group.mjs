// Group: an image and two voice notes on it stay put when grouped, then are
// selected, moved, copied and deleted together; their stacking order survives
// a move; Ctrl-click picks one; ungroup; undo; reload; phone.
//   node tests/run-group.mjs [check ids]      (port 5217)
import { createSuite, rand, assert, wait, PNG } from './harness.mjs';

const suite = await createSuite('group');
const { check, shot } = suite;
const S = await suite.startServer('main', 5217, { CANVASNOTES_SIGNUPS: 'open' });
const B = S.base;
const el = (id, type, extra) => ({ op: 'put', el: { id, type, parentId: 'gb', section: 'canvas', x: 0, y: 0, w: 270, z: 1, columnId: null, createdAt: 1, updatedAt: 1, ...extra } });
const voice = (id, x, y, z) => el(id, 'voice', { x, y, z, w: 290, content: { src: '', name: '', size: 0, mime: '', duration: 0 } });

async function open(options = {}) {
  const p = await suite.newPage(options);
  await suite.signup(p, B, `group-${rand()}@example.com`, 'owner-password');
  const { url } = await (await p.request.post(`${B}/api/upload?name=bug.png`, { data: PNG, headers: { 'content-type': 'image/png' } })).json();
  await p.request.post(`${B}/api/ops`, {
    data: { ops: [el('gb', 'board', { parentId: 'root', w: 110, content: { title: 'Bugs' } }), el('img', 'image', { x: 60, y: 60, w: 420, z: 1, content: { src: url, ratio: 0.6 } }), voice('v1', 120, 100, 2), voice('v2', 160, 200, 3), el('other', 'note', { x: 700, y: 60, z: 4, content: { html: '<p>Other</p>' } }), el('col', 'column', { x: 700, y: 300, w: 300, z: 5, content: { title: 'Column' } })] },
  });
  await p.goto(`${B}/#/b/gb`);
  await p.waitForSelector('[data-el="v2"]');
  await wait(300);
  return p;
}
const state = async (p) => Object.fromEntries((await (await p.request.get(`${B}/api/state`)).json()).elements.map((e) => [e.id, e]));
const box = (p, id) => p.locator(`[data-el="${id}"]`).boundingBox();
const selected = (p) => p.$$eval('.item.selected', (n) => n.map((x) => x.dataset.el).sort().join(','));
const topAt = (p, x, y) => p.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest('[data-el]')?.dataset.el, [x, y]);
// Clicks a spot of the picture that no voice note covers.
const clickImage = async (p, opts) => { const b = await box(p, 'img'); await p.mouse.click(b.x + b.width - 20, b.y + b.height - 20, opts); };
async function group(p) {
  await clickImage(p);
  await p.locator('[data-el="v1"] .voice-note').click({ modifiers: ['Shift'] });
  await p.locator('[data-el="v2"] .voice-note').click({ modifiers: ['Shift'] });
  await p.keyboard.press('Control+g');
  await wait(900);
}

const p = await open();
await check('G1', 'Ctrl G: nothing moves, the three share a group, a dashed frame shows it', async () => {
  const before = await Promise.all(['img', 'v1', 'v2'].map((id) => box(p, id)));
  await group(p);
  const after = await Promise.all(['img', 'v1', 'v2'].map((id) => box(p, id)));
  assert(JSON.stringify(before) === JSON.stringify(after), 'cards moved');
  const s = await state(p);
  assert(s.img.groupId && s.img.groupId === s.v1.groupId && s.v1.groupId === s.v2.groupId && !s.other.groupId, 'groupId');
  assert(await p.locator('.group-outline').count() === 1, 'no frame');
  await shot(p, 'grouped');
});

await check('G2', 'Clicking any one selects all three; dragging the image moves them all, voice notes stay on top', async () => {
  await p.mouse.click(1100, 650);
  await p.locator('[data-el="v1"] .voice-note').click();
  assert((await selected(p)) === 'img,v1,v2', await selected(p));
  await p.mouse.click(1100, 650);
  const b = await box(p, 'img');
  const v = await box(p, 'v2');
  await p.mouse.move(b.x + b.width - 20, b.y + b.height - 20);
  await p.mouse.down();
  await p.mouse.move(b.x + b.width + 80, b.y + b.height + 40, { steps: 8 });
  await p.mouse.up();
  await wait(900);
  const v2 = await box(p, 'v2');
  assert(Math.abs(v2.x - v.x - 100) < 3 && Math.abs(v2.y - v.y - 60) < 3, `voice moved ${v2.x - v.x},${v2.y - v.y}`);
  assert((await topAt(p, v2.x + 60, v2.y + 15)) === 'v2', 'image covers the voice note after the move');
  const s = await state(p);
  assert(s.img.z < s.v1.z && s.v1.z < s.v2.z, `z ${s.img.z} ${s.v1.z} ${s.v2.z}`);
  assert(s.other.x === 700, 'an ungrouped card moved');
  await shot(p, 'moved together');
});

await check('G3', 'Ctrl-click picks just one card and moves it alone', async () => {
  await p.mouse.click(1100, 650);
  const v = await box(p, 'v1');
  const i = await box(p, 'img');
  await p.keyboard.down('Control');
  await p.mouse.move(v.x + 150, v.y + 15);
  await p.mouse.down();
  await p.mouse.move(v.x + 150, v.y + 75, { steps: 6 });
  await p.mouse.up();
  await p.keyboard.up('Control');
  await wait(300);
  assert((await selected(p)) === 'v1', await selected(p));
  const i2 = await box(p, 'img');
  assert(i2.y === i.y && Math.abs((await box(p, 'v1')).y - v.y - 60) < 3, 'moved the wrong things');
  await p.keyboard.press('Control+z');
  await wait(300);
});

await check('G4', 'Copy-paste and Duplicate make a new, separate group', async () => {
  await clickImage(p);
  await p.keyboard.press('Control+d');
  await wait(900);
  const s = await state(p);
  const copies = Object.values(s).filter((e) => !['img', 'v1', 'v2', 'other', 'col', 'gb'].includes(e.id));
  assert(copies.length === 3, `${copies.length} copies`);
  assert(new Set(copies.map((c) => c.groupId)).size === 1 && copies[0].groupId !== s.img.groupId, 'copies share the old group');
  await p.mouse.click(1100, 650);
  await p.locator(`[data-el="${copies.find((c) => c.type === 'voice').id}"] .voice-note`).click();
  assert((await selected(p)).split(',').length === 3, 'copy group');
  await p.keyboard.press('Control+z');
  await wait(300);
});

await check('G5', 'Delete takes the whole group, one undo brings it back grouped; survives a reload', async () => {
  await p.mouse.click(1100, 650);
  await p.locator('[data-el="v2"] .voice-note').click();
  await p.keyboard.press('Delete');
  await wait(900);
  let s = await state(p);
  assert(['img', 'v1', 'v2'].every((id) => s[id].section === 'trash') && s.other.section === 'canvas', 'not all trashed');
  await p.keyboard.press('Control+z');
  await wait(900);
  await p.reload();
  await p.waitForSelector('[data-el="v2"]');
  await wait(300);
  await clickImage(p);
  assert((await selected(p)) === 'img,v1,v2', await selected(p));
});

await check('G6', 'Ungroup (Ctrl Shift G and the menu): each card is on its own again', async () => {
  await p.keyboard.press('Control+Shift+g');
  await wait(700);
  let s = await state(p);
  assert(!s.img.groupId && !s.v1.groupId && !s.v2.groupId, 'still grouped');
  await p.mouse.click(1100, 650);
  await clickImage(p);
  assert((await selected(p)) === 'img', await selected(p));
  await p.keyboard.press('Control+z');
  await wait(300);
  await p.mouse.click(1100, 650);
  await clickImage(p, { button: 'right' });
  await p.locator('.menu button', { hasText: /^Ungroup/ }).click();
  await wait(700);
  s = await state(p);
  assert(!s.img.groupId, 'menu ungroup');
  await p.mouse.click(1100, 650);
  await clickImage(p);
  await p.locator('[data-el="v1"] .voice-note').click({ modifiers: ['Shift'] });
  await p.locator('[data-el="v1"] .voice-note').click({ button: 'right' });
  await p.locator('.menu button').filter({ hasText: /^Group\s*Ctrl G$/ }).click();
  await wait(700);
  s = await state(p);
  assert(s.img.groupId && s.img.groupId === s.v1.groupId && !s.v2.groupId, 'menu group');
});

await check('G7', 'Dropping a group into a column ungroups it there; one card alone cannot be grouped', async () => {
  const q = await open();
  await group(q);
  await q.mouse.click(1100, 650);
  await q.locator('[data-el="other"]').click();
  await q.keyboard.press('Control+g');
  await wait(400);
  assert((await q.locator('.toast').innerText()).includes('two or more'), 'no hint');
  const v = await box(q, 'v1');
  const c = await box(q, 'col');
  await q.mouse.click(1100, 650);
  await q.mouse.move(v.x + 150, v.y + 15);
  await q.mouse.down();
  await q.mouse.move(c.x + 100, c.y + 60, { steps: 10 });
  await q.mouse.up();
  await wait(900);
  const s = await state(q);
  assert(['img', 'v1', 'v2'].every((id) => s[id].columnId === 'col' && !s[id].groupId), JSON.stringify(['img', 'v1', 'v2'].map((id) => [s[id].columnId, s[id].groupId])));
});

await check('G8', 'Phone: tapping one card of a group selects all of it', async () => {
  const q = await open({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const s = await state(q);
  await q.request.post(`${B}/api/ops`, { data: { ops: ['img', 'v1', 'v2'].map((id) => ({ op: 'put', el: { ...s[id], groupId: 'g-phone' } })) } });
  await q.reload();
  await q.waitForSelector('[data-el="v2"]');
  await wait(400);
  const b = await box(q, 'img');
  await q.touchscreen.tap(b.x + 40, b.y + b.height - 15);
  await wait(500);
  assert((await selected(q)) === 'img,v1,v2', await selected(q));
  await shot(q, 'phone group selected');
});

await suite.finish();
