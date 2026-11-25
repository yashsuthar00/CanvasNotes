// Voice notes, recorded through Chrome's fake microphone (a beep every second):
// drop the badge and it records, stop saves, play / seek / speed, undo and redo,
// deleting mid-recording, blocked microphone, failed upload, published boards.
//   node tests/run-voice.mjs [check ids]      (port 5216)
import { createSuite, rand, assert, wait, PNG } from './harness.mjs';

const suite = await createSuite('voice', { args: ['--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
const { check, shot, fact } = suite;
const S = await suite.startServer('main', 5216, { CANVASNOTES_SIGNUPS: 'open' });
const B = S.base;
const el = (id, type, extra) => ({ op: 'put', el: { id, type, parentId: 'vb', section: 'canvas', x: 0, y: 0, w: 270, z: 1, columnId: null, createdAt: 1, updatedAt: 1, ...extra } });

// A fresh account with one board holding an image.
async function open(options = {}) {
  const p = await suite.newPage({ permissions: ['microphone'], acceptDownloads: true, ...options });
  await suite.signup(p, B, `voice-${rand()}@example.com`, 'owner-password');
  const { url } = await (await p.request.post(`${B}/api/upload?name=bug.png`, { data: PNG, headers: { 'content-type': 'image/png' } })).json();
  await p.request.post(`${B}/api/ops`, {
    data: { ops: [el('vb', 'board', { parentId: 'root', w: 110, content: { title: 'Bugs', publicToken: null } }), el('img', 'image', { x: 60, y: 60, w: 400, content: { src: url, ratio: 0.6 } }), el('col', 'column', { x: 60, y: 420, w: 300, content: { title: 'Column' } })] },
  });
  await p.goto(`${B}/#/b/vb`);
  await p.waitForSelector('[data-el="img"]');
  await wait(300);
  return p;
}
const tool = (p) => p.locator('.toolbar .tool', { hasText: /^Voice$/ });
async function drop(p, x, y) {
  const b = await tool(p).boundingBox();
  await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await p.mouse.down();
  await p.mouse.move(x - 40, y, { steps: 4 });
  await p.mouse.move(x, y);
  await p.mouse.up();
}
const stop = (p) => p.locator('.world [aria-label="Stop and save"]').click();
const recording = (p) => p.locator('.world .voice.recording').waitFor({ timeout: 4000 });
const saved = (p) => p.locator('.world .voice [aria-label="Play"]').first().waitFor({ timeout: 5000 });
const onServer = async (p) => (await (await p.request.get(`${B}/api/state`)).json()).elements.filter((e) => e.type === 'voice');
const shown = (p) => p.locator('.world .item-voice').count();
// Nothing in the badge overlaps or sticks out of it.
async function tidy(p, what) {
  const bad = await p.evaluate(() => {
    const row = document.querySelector('.world .voice-row');
    const card = row.closest('.card').getBoundingClientRect();
    const kids = [...row.children].map((k) => k.getBoundingClientRect());
    const bars = row.querySelector('.voice-bars');
    const clipped = [...bars.children].filter((b) => b.getBoundingClientRect().right > bars.getBoundingClientRect().right + 0.5).length;
    return kids.some((k, i) => k.right > card.right + 0.5 || (i && k.left < kids[i - 1].right - 0.5)) || clipped > 0 || bars.clientWidth < 60 ? `bars ${bars.clientWidth}px, ${clipped} past the edge` : '';
  });
  assert(!bad, `${what}: ${bad}`);
}
async function record(p, x, y, ms = 2500) {
  await drop(p, x, y);
  await recording(p);
  await wait(ms);
  await stop(p);
  await saved(p);
  await wait(900);
}

const p = await open();
await check('A1', 'Drop the badge beside an image: it records at once, stop saves it', async () => {
  const img = await p.locator('[data-el="img"]').boundingBox();
  await drop(p, img.x + img.width + 60, img.y + 60);
  await recording(p);
  await wait(3200);
  const heights = await p.$$eval('.voice-bars.live i', (n) => n.map((i) => parseFloat(i.style.height)));
  assert(Math.max(...heights) > 30, `bars never moved (max ${Math.max(...heights)})`);
  await tidy(p, 'recording');
  await shot(p, 'recording');
  await stop(p);
  await saved(p);
  await wait(900);
  const [v] = await onServer(p);
  fact(`${v.content.mime}, ${v.content.size} bytes, ${v.content.duration} s, ${v.content.peaks.length} bars`);
  assert(v.content.duration > 2.5 && v.content.duration < 6, `duration ${v.content.duration}`);
  assert(v.content.size > 3000, `size ${v.content.size}`);
  assert(Math.max(...v.content.peaks) === 100 && v.content.peaks.length === 40, 'peaks');
  await tidy(p, 'saved');
  await shot(p, 'saved');
  return `${v.content.duration} s`;
});

await check('A2', 'Playing: time moves, pause holds, clicking the bars jumps, the end is reached', async () => {
  const time = () => p.locator('.world .voice-time').innerText();
  const before = await time();
  await p.locator('.voice [aria-label="Play"]').click();
  await wait(1300);
  assert(await p.locator('.voice [aria-label="Pause"]').count(), 'not playing');
  assert((await time()) === '0:01', `time ${await time()}`);
  assert((await p.locator('.voice-bars i.on').count()) > 5, 'bars not filled');
  await shot(p, 'playing');
  await p.locator('.voice [aria-label="Pause"]').click();
  const held = await p.locator('.voice-bars i.on').count();
  await wait(700);
  assert((await p.locator('.voice-bars i.on').count()) === held, 'kept going after pause');
  const b = await p.locator('.world .voice-bars').boundingBox();
  await p.mouse.click(b.x + b.width * 0.75, b.y + b.height / 2);
  await wait(200);
  const on = await p.locator('.voice-bars i.on').count();
  assert(on >= 29 && on <= 36, `${on} of 40 bars after jumping to 75%`);
  await p.mouse.click(b.x + b.width * 0.25, b.y + b.height / 2);
  await wait(200);
  const back = await p.locator('.voice-bars i.on').count();
  assert(back >= 9 && back <= 16, `${back} of 40 bars after jumping back to 25%`);
  await p.locator('.voice [aria-label="Play"]').waitFor({ timeout: 6000 });
  assert((await time()) === before, `after the end: ${await time()}`);
});

await check('A3', 'Reload: still there, plays again; speed is remembered', async () => {
  const rate = p.locator('.voice-rate');
  await rate.click();
  assert((await rate.innerText()) === '1.5×', await rate.innerText());
  await p.reload();
  await saved(p);
  assert((await rate.innerText()) === '1.5×', 'speed lost');
  await p.locator('.voice [aria-label="Play"]').click();
  await wait(900);
  assert(await p.locator('.voice [aria-label="Pause"]').count(), 'not playing after reload');
  await rate.click();
  await rate.click();
  assert((await rate.innerText()) === '1×', 'speed cycle');
  await p.locator('.voice [aria-label="Pause"]').click();
});

await check('A4', 'The badge drags by its bars without jumping in the sound; it can join a column', async () => {
  const a = await p.locator('.world .item-voice').boundingBox();
  const b = await p.locator('.world .voice-bars').boundingBox();
  const bars = await p.locator('.voice-bars i.on').count();
  await p.mouse.move(b.x + 90, b.y + 15);
  await p.mouse.down();
  await p.mouse.move(b.x + 150, b.y + 60, { steps: 6 });
  await p.mouse.up();
  await wait(200);
  const c = await p.locator('.world .item-voice').boundingBox();
  assert(Math.abs(c.x - a.x - 60) < 12 && Math.abs(c.y - a.y - 45) < 12, `moved ${c.x - a.x},${c.y - a.y}`);
  assert(!(await p.locator('.voice [aria-label="Pause"]').count()), 'dragging started playback');
  assert((await p.locator('.voice-bars i.on').count()) === bars, 'dragging moved the position');
  const col = await p.locator('[data-el="col"]').boundingBox();
  await drop(p, col.x + col.width / 2, col.y + col.height / 2);
  await recording(p);
  assert(await p.locator('[data-el="col"] .item-voice').count(), 'not in the column');
  await p.locator('.world [aria-label="Discard recording"]').click();
});

await check('A5', 'Pause and resume leave the pause out; discard removes the card', async () => {
  const q = await open();
  await drop(q, 700, 200);
  await recording(q);
  await wait(1000);
  await q.locator('.world [aria-label="Pause"]').click();
  await wait(2500);
  await q.locator('.world [aria-label="Resume"]').click();
  await wait(1000);
  await stop(q);
  await saved(q);
  await wait(900);
  const [v] = await onServer(q);
  assert(v.content.duration > 1.6 && v.content.duration < 3.4, `duration ${v.content.duration}`);
  await drop(q, 700, 420);
  await recording(q);
  await wait(900);
  await q.locator('.world [aria-label="Discard recording"]').click();
  await wait(1200);
  assert((await onServer(q)).length === 1 && (await shown(q)) === 1, 'discarded card still there');
  return `${v.content.duration} s`;
});

await check('A6', 'One undo removes the note, redo brings it back with its sound', async () => {
  const q = await open();
  await record(q, 700, 200, 1500);
  await q.mouse.click(1000, 600);
  await q.keyboard.press('Control+z');
  await wait(300);
  assert((await shown(q)) === 0, 'still shown after one undo');
  await q.keyboard.press('Control+Shift+z');
  await wait(900);
  const [v] = await onServer(q);
  assert(v?.content.src, 'redo brought back an empty card');
  await saved(q);
});

await check('A7', 'Deleting the card mid-recording turns the microphone off; redo / Restore has the sound', async () => {
  const q = await open();
  await drop(q, 700, 200);
  await recording(q);
  await wait(1500);
  await q.keyboard.press('Delete');
  await wait(1500);
  const [v] = await onServer(q);
  assert(v.section === 'trash' && v.content.src, `${v.section} ${v.content.src}`);
  await drop(q, 700, 420);
  await recording(q);
  await wait(1500);
  await q.keyboard.press('Control+z');
  await wait(1200);
  assert((await shown(q)) === 0, 'undo did not remove it');
  await q.keyboard.press('Control+Shift+z');
  await wait(900);
  assert((await onServer(q)).every((e) => e.content.src), 'redone card lost its sound');
});

await check('A8', 'A second badge saves the first; leaving the board keeps recording with Stop in reach', async () => {
  const q = await open();
  await drop(q, 700, 200);
  await recording(q);
  await wait(1300);
  await drop(q, 700, 420);
  await wait(1800);
  let list = await onServer(q);
  assert(list.length === 2 && list.filter((e) => e.content.src).length === 1, 'first one not saved');
  assert(!(await q.locator('.voice-dock').count()), 'dock shown while the card is in view');
  await q.goto(`${B}/#/`);
  await q.locator('.voice-dock').waitFor({ timeout: 3000 });
  await shot(q, 'recording on another board');
  await q.locator('.voice-dock [aria-label="Stop and save"]').click();
  await wait(1500);
  list = await onServer(q);
  assert(list.every((e) => e.content.src), 'second one not saved');
});

await check('A9', 'Microphone blocked: clear message, audio can be uploaded instead', async () => {
  const q = await open({ permissions: [] });
  await drop(q, 700, 200);
  await q.locator('.voice-message').waitFor({ timeout: 4000 });
  assert(/blocked/i.test(await q.locator('.voice-message').innerText()), await q.locator('.voice-message').innerText());
  await shot(q, 'microphone blocked');
  const wav = Buffer.alloc(44 + 16000);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + 16000, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(16000, 40);
  const chooser = q.waitForEvent('filechooser');
  await q.locator('.voice-actions button', { hasText: 'Upload audio' }).click();
  await (await chooser).setFiles({ name: 'said.wav', mimeType: 'audio/wav', buffer: wav });
  await saved(q);
  await wait(900);
  const [v] = await onServer(q);
  assert(v.content.name === 'said.wav' && Math.abs(v.content.duration - 1) < 0.05, JSON.stringify(v.content));
});

await check('A10', 'Upload fails: the recording is kept, Try again saves it', async () => {
  const q = await open();
  await q.route('**/api/upload*', (r) => r.abort());
  await drop(q, 700, 200);
  await recording(q);
  await wait(1300);
  await stop(q);
  await q.locator('.voice-message').waitFor({ timeout: 4000 });
  await shot(q, 'upload failed');
  const dl = q.waitForEvent('download');
  await q.locator('.voice-actions button', { hasText: 'Download' }).click();
  fact((await dl).suggestedFilename());
  await q.unroute('**/api/upload*');
  await q.locator('.voice-actions button', { hasText: 'Try again' }).click();
  await saved(q);
  await wait(900);
  assert((await onServer(q))[0].content.src, 'not saved');
});

await check('A11', 'Record Again replaces it, undo brings the old one back; duplicates play too', async () => {
  const q = await open();
  await record(q, 700, 200, 1200);
  const first = (await onServer(q))[0].content.src;
  await q.locator('.world .voice-time').click({ button: 'right' });
  await q.locator('.menu button', { hasText: 'Record Again' }).click();
  await recording(q);
  await wait(1800);
  await stop(q);
  await saved(q);
  await wait(900);
  assert((await onServer(q))[0].content.src !== first, 'not replaced');
  await q.mouse.click(1000, 600);
  await q.keyboard.press('Control+z');
  await wait(900);
  assert((await onServer(q))[0].content.src === first, 'undo did not bring the first one back');
  await q.locator('.world .voice-time').click();
  await q.keyboard.press('Control+d');
  await wait(900);
  assert((await onServer(q)).every((e) => e.content.src === first) && (await shown(q)) === 2, 'duplicate');
});

await check('A12', 'Published board: a signed-out visitor can play it but not record; private ones stay private', async () => {
  const q = await open();
  await record(q, 700, 200, 1500);
  const [v] = await onServer(q);
  const guest = await suite.newPage();
  assert((await guest.request.get(`${B}${v.content.src}`)).status() === 401, 'file readable signed out');
  await q.request.post(`${B}/api/ops`, { data: { ops: [el('vb', 'board', { parentId: 'root', w: 110, content: { title: 'Bugs', publicToken: 'tok-voice-0123456789' } }), el('blank', 'voice', { x: 700, y: 500, w: 250, content: { src: '', name: '', size: 0, mime: '', duration: 0 } })] } });
  await guest.goto(`${B}/p/tok-voice-0123456789`);
  await saved(guest);
  assert(!(await guest.locator('.voice-round.record').count()), 'visitor can record');
  await guest.locator('.voice [aria-label="Play"]').click();
  await wait(700);
  assert(await guest.locator('.voice [aria-label="Pause"]').count(), 'not playing');
  await shot(guest, 'published board');
});

await check('A13', 'Server: byte ranges, sound types, microphone only for this site, files in the ZIP', async () => {
  const [v] = await onServer(p);
  const url = `${B}${v.content.src}`;
  const get = (range) => p.request.get(url, { headers: range ? { range } : {} });
  const all = await get();
  const body = await all.body();
  assert(all.status() === 200 && all.headers()['accept-ranges'] === 'bytes' && /^audio\//.test(all.headers()['content-type']), all.headers()['content-type']);
  for (const [range, from, to] of [['bytes=0-9', 0, 10], ['bytes=100-', 100, body.length], ['bytes=-20', body.length - 20, body.length], ['bytes=5-99999999', 5, body.length]]) {
    const r = await get(range);
    const part = await r.body();
    assert(r.status() === 206 && part.equals(body.subarray(from, to)), `${range}: ${r.status()} ${part.length}`);
    assert(r.headers()['content-range'] === `bytes ${from}-${to - 1}/${body.length}`, r.headers()['content-range']);
  }
  assert((await get('bytes=99999999-')).status() === 416, 'past the end');
  for (const odd of ['bytes=9-5', 'bytes=-', 'bytes=0-1,4-5', 'lines=1-2']) assert((await get(odd)).status() === 200, odd);
  assert((await get('bytes=-0')).status() === 416, 'empty suffix');
  const policy = (await p.request.get(B)).headers()['permissions-policy'];
  assert(/microphone=\(self\)/.test(policy) && /camera=\(\)/.test(policy), policy);
  const zip = await (await p.request.get(`${B}/api/board-files/vb`)).body();
  assert(zip.includes(Buffer.from(v.content.name)), 'not in the ZIP');
});

await check('A14', 'Phone: tap the tool to record, tap to stop and play', async () => {
  const q = await open({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await tool(q).scrollIntoViewIfNeeded();
  await tool(q).tap();
  await recording(q);
  await wait(1500);
  await tidy(q, 'phone recording');
  await shot(q, 'phone recording');
  await q.locator('.world [aria-label="Stop and save"]').tap();
  await saved(q);
  await q.locator('.world .voice [aria-label="Play"]').tap();
  await wait(600);
  assert(await q.locator('.voice [aria-label="Pause"]').count(), 'not playing');
  await tidy(q, 'phone playing');
  await shot(q, 'phone playing');
});

await suite.finish();
