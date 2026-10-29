// Accounts and multi-user isolation, end to end in headless Chrome.
//   node tests/run-accounts.mjs [check ids, e.g. L1,L7]
// Starts its own servers (fresh data folders, ports 5192–5197), so nothing else
// needs to be running. Needs Node 24 (node:sqlite) and Chrome.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createSuite, ROOT, PNG, wait, rand, assert } from './harness.mjs';

const suite = await createSuite('accounts');
const { check, shot, fact } = suite;
const newPage = (o) => suite.newPage(o);
const startServer = (...a) => suite.startServer(...a);
const apiSignup = (...a) => suite.signup(...a);

async function state(page, base) {
  const res = await page.request.get(`${base}/api/state`);
  return { status: res.status(), body: res.ok() ? await res.json() : null };
}
async function ops(page, base, list, headers = {}) {
  return page.request.post(`${base}/api/ops`, { data: { ops: list }, headers });
}
const note = (id, text, parentId = 'root') => ({ id, type: 'note', parentId, section: 'canvas', x: 400, y: 300, z: 1, width: 220, columnId: null, createdAt: Date.now(), updatedAt: Date.now(), content: { html: `<p>${text}</p>` } });
const board = (id, title, extra = {}) => ({ id, type: 'board', parentId: 'root', section: 'canvas', x: 100, y: 100, z: 1, width: 120, columnId: null, createdAt: Date.now(), updatedAt: Date.now(), content: { title, ...extra } });
const image = (id, src, parentId) => ({ id, type: 'image', parentId, section: 'canvas', x: 300, y: 100, z: 2, width: 200, columnId: null, createdAt: Date.now(), updatedAt: Date.now(), content: { src, caption: '' } });

async function openMenuItem(page, label) {
  await page.click('.topbar button[title="More"]');
  await page.locator('.menu button', { hasText: label }).first().click();
}
async function uiSignin(page, base, email, password) {
  await page.goto(base);
  await page.fill('#email', email);
  await page.fill('#password', password);
  await page.click('#submit');
}
const S = await startServer('open', 5192);
const B = S.base;

// ------------------------------------------------------------------ sign-up / sign-in UI
let pageA, emailA, passA;
emailA = `alice-${rand()}@example.com`;
passA = 'alice-password-1';

await check('L1', 'Sign-in page: shown to signed-out visitors, switches to sign-up, fits a phone (no sideways scroll)', async () => {
  const p = await newPage({ viewport: { width: 375, height: 740 }, isMobile: true, hasTouch: true });
  await p.goto(B);
  assert(/Sign in/.test(await p.title()), `title ${await p.title()}`);
  assert(await p.isHidden('#nameRow'), 'name field visible on sign-in');
  await p.click('#switch');
  assert(await p.isVisible('#nameRow'), 'name field hidden on sign-up');
  assert((await p.textContent('#submit')) === 'Create account', `submit says ${await p.textContent('#submit')}`);
  assert((await p.getAttribute('#password', 'autocomplete')) === 'new-password', 'password autocomplete not new-password');
  const overflow = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert(overflow <= 0, `page scrolls sideways by ${overflow}px`);
  const fontSize = await p.$eval('#email', (el) => parseFloat(getComputedStyle(el).fontSize));
  assert(fontSize >= 16, `input font ${fontSize}px makes iOS zoom in`);
  await shot(p, 'phone create-account form');
  await p.goto(`${B}/#signup`);
  assert(await p.isVisible('#nameRow'), '#signup link does not open sign-up');
  fact(`sideways overflow at 375 px: ${overflow}px; email field font ${fontSize}px`);
});

await check('L2', 'Sign-up form: rejects a bad email and a short password, then creates the account and opens the app', async () => {
  pageA = await newPage();
  await pageA.goto(`${B}/#signup`);
  await pageA.fill('#name', 'Alice');
  await pageA.fill('#email', 'not-an-email');
  await pageA.fill('#password', passA);
  await pageA.click('#submit');
  await pageA.waitForFunction(() => document.getElementById('e').textContent.length > 0);
  assert(/valid email/.test(await pageA.textContent('#e')), `bad email: ${await pageA.textContent('#e')}`);
  await shot(pageA, 'bad email refused');
  await pageA.fill('#email', `  ${emailA.toUpperCase()} `);
  await pageA.fill('#password', 'short');
  await pageA.click('#submit');
  await pageA.waitForFunction(() => /8 characters/.test(document.getElementById('e').textContent));
  await shot(pageA, 'short password refused');
  await pageA.fill('#password', passA);
  await pageA.click('#submit');
  await pageA.waitForSelector('.toolbar', { timeout: 10000 });
  assert(!pageA.url().includes('#signup'), `still on #signup: ${pageA.url()}`);
  const s = await state(pageA, B);
  assert(s.body.user.email === emailA, `stored email ${s.body.user.email} (should be trimmed + lower-case)`);
  assert(s.body.user.name === 'Alice', `name ${s.body.user.name}`);
  await wait(1200);
  const after = await state(pageA, B);
  assert(after.body.elements.some((e) => e.type === 'board' && /Welcome/.test(e.content.title)), 'no welcome board for a new account');
  await shot(pageA, 'new account opens its own empty Home');
  fact(`stored email: ${s.body.user.email} (typed "  ${emailA.toUpperCase()} ")`);
});

await check('L3', 'Sign-up: the same email again (any case) is refused with a clear message', async () => {
  const p = await newPage();
  await p.goto(`${B}/#signup`);
  await p.fill('#email', emailA.replace('alice', 'ALICE'));
  await p.fill('#password', 'another-password');
  await p.click('#submit');
  await p.waitForFunction(() => document.getElementById('e').textContent.length > 0);
  assert(/already exists/.test(await p.textContent('#e')), `message: ${await p.textContent('#e')}`);
  await shot(p, 'duplicate email refused');
});

await check('L4', 'Account menu shows the email; Sign out returns to the sign-in page and the API refuses the old session', async () => {
  const p = await newPage();
  await uiSignin(p, B, emailA, passA);
  await p.waitForSelector('.toolbar');
  await p.click('.topbar button[title="More"]');
  const hint = await p.locator('.menu .menu-hint').textContent();
  assert(hint === emailA, `menu shows ${hint}`);
  await shot(p, 'menu shows the signed-in email');
  const cookieBefore = (await p.context().cookies()).find((c) => c.name === 'cn_sid');
  await p.locator('.menu button.danger', { hasText: 'Sign out' }).click();
  await p.waitForSelector('#email', { timeout: 8000 });
  const s = await state(p, B);
  assert(s.status === 401, `state after sign-out: ${s.status}`);
  // The old cookie value must be dead on the server, not just removed from the browser.
  const replay = await fetch(`${B}/api/state`, { headers: { cookie: `cn_sid=${cookieBefore.value}` } });
  assert(replay.status === 401, `old session still works: ${replay.status}`);
  await shot(p, 'after sign out');
  fact(`GET /api/state with the old cookie after sign-out → ${replay.status}`);
});

await check('L5', 'Sign-in: wrong password and unknown email get the same message; email is case-insensitive', async () => {
  const p = await newPage();
  await uiSignin(p, B, emailA, 'wrong-password');
  await p.waitForFunction(() => document.getElementById('e').textContent.length > 0);
  const wrong = await p.textContent('#e');
  await p.fill('#email', `nobody-${rand()}@example.com`);
  await p.click('#submit');
  await p.waitForFunction((prev) => document.getElementById('submit').disabled === false && document.getElementById('e').textContent.length > 0, wrong);
  const unknown = await p.textContent('#e');
  assert(wrong === unknown && /Wrong email or password/.test(wrong), `"${wrong}" vs "${unknown}"`);
  await shot(p, 'wrong password or unknown email - same message');
  await p.fill('#email', emailA.toUpperCase());
  await p.fill('#password', passA);
  await p.click('#submit');
  await p.waitForSelector('.toolbar', { timeout: 8000 });
});

await check('L6', 'Brute force: 10 wrong passwords lock that email (even from many IPs) and that IP (across emails)', async () => {
  const target = `victim-${rand()}@example.com`;
  const p = await newPage();
  await apiSignup(p, B, target, 'victim-password');
  let last;
  for (let i = 0; i < 11; i++) last = await p.request.post(`${B}/api/login`, { data: { email: target, password: `guess-${i}` }, headers: { 'x-forwarded-for': `10.50.0.${i}` } });
  assert(last.status() === 429, `email after 11 tries from different IPs: ${last.status()}`);
  const right = await p.request.post(`${B}/api/login`, { data: { email: target, password: 'victim-password' }, headers: { 'x-forwarded-for': '10.50.1.1' } });
  assert(right.status() === 429, `correct password during lockout: ${right.status()}`);
  for (let i = 0; i < 11; i++) last = await p.request.post(`${B}/api/login`, { data: { email: `x${i}-${rand()}@example.com`, password: 'x' }, headers: { 'x-forwarded-for': '10.60.0.1' } });
  assert(last.status() === 429, `IP after 11 tries across emails: ${last.status()}`);
  const ui = await newPage();
  await ui.goto(B);
  await ui.fill('#email', target);
  await ui.fill('#password', 'victim-password');
  await ui.click('#submit');
  await ui.waitForFunction(() => document.getElementById('e').textContent.length > 0);
  await shot(ui, 'locked out after 10 wrong passwords');
  fact('11th try for one email from 11 different IPs → 429; correct password during lockout → 429; 11 tries from one IP across emails → 429');
});

// ------------------------------------------------------------------ isolation
let pageB, emailB, idsA;
await check('L7', 'Isolation in the UI: a note Alice types never appears for Bob (state, search, Home)', async () => {
  const secret = `alice-secret-${rand()}`;
  await pageA.goto(B);
  await pageA.waitForSelector('.toolbar');
  await pageA.mouse.dblclick(900, 600);
  await wait(300);
  await pageA.keyboard.type(secret, { delay: 10 });
  await pageA.keyboard.press('Escape');
  await wait(1200);
  const a = await state(pageA, B);
  assert(JSON.stringify(a.body.elements).includes(secret), 'note not saved for Alice');
  idsA = { note: a.body.elements.find((e) => JSON.stringify(e.content).includes(secret)).id, secret };

  pageB = await newPage();
  emailB = `bob-${rand()}@example.com`;
  await pageB.goto(`${B}/#signup`);
  await pageB.fill('#email', emailB);
  await pageB.fill('#password', 'bob-password-1');
  await pageB.click('#submit');
  await pageB.waitForSelector('.toolbar');
  await wait(800);
  const b = await state(pageB, B);
  assert(!JSON.stringify(b.body).includes(secret), "Alice's note is in Bob's state");
  assert(!(await pageB.content()).includes(secret), "Alice's note is on Bob's screen");
  await shot(pageA, 'Alice sees her note');
  await shot(pageB, 'Bob signed in at the same time - no trace of it');
  await pageB.keyboard.press('Control+k');
  await pageB.keyboard.type(secret.slice(0, 14));
  await wait(400);
  assert(!(await pageB.locator('.search-palette, .palette').first().textContent().catch(() => '')).includes(secret), 'search finds Alice\'s note');
  await pageB.keyboard.press('Escape');
});

await check('L8', "Isolation in the API: Bob can't overwrite, delete, export or wipe Alice's data, even using her ids", async () => {
  const r1 = await ops(pageB, B, [{ op: 'put', el: { ...note(idsA.note, 'bob was here') } }, { op: 'put', el: board('root', 'Bob home', { background: '#000' }) }]);
  assert(r1.ok(), `Bob's put: ${r1.status()}`);
  const r2 = await ops(pageB, B, [{ op: 'del', id: idsA.note }]);
  assert(r2.ok(), `Bob's delete: ${r2.status()}`);
  const imp = await pageB.request.post(`${B}/api/import`, { data: { elements: [note('bob-1', 'imported')], mode: 'replace' } });
  assert(imp.ok(), `Bob's import: ${imp.status()}`);
  const a = await state(pageA, B);
  const mine = a.body.elements.find((e) => e.id === idsA.note);
  assert(mine && JSON.stringify(mine.content).includes(idsA.secret), "Alice's note was changed or deleted by Bob");
  assert(!a.body.elements.some((e) => e.id === 'root' && e.content.title === 'Bob home'), "Bob's Home appearance leaked into Alice's");
  const exp = await (await pageB.request.get(`${B}/api/export`)).json();
  assert(exp.elements.length === 1 && exp.elements[0].id === 'bob-1', `Bob's export has ${exp.elements.length} elements`);
  assert(!JSON.stringify(exp).includes(idsA.secret), "Alice's note in Bob's export");
  fact(`Bob PUT + DELETE on Alice's note id → ${r1.status()} / ${r2.status()} (applied to Bob's own space only); Alice's note unchanged`);
  fact(`Bob import "replace everything" → only Bob's data replaced; Bob's export has ${exp.elements.length} element(s)`);
});

let fileA;
await check('L9', "Files: Alice's upload loads for her, 404s for Bob and signed-out visitors, and isn't in Bob's ZIP", async () => {
  const up = await pageA.request.post(`${B}/api/upload?name=photo.png`, { data: PNG, headers: { 'content-type': 'image/png' } });
  fileA = (await up.json()).url;
  const boardId = `files-${rand()}`;
  await ops(pageA, B, [{ op: 'put', el: board(boardId, 'Alice files') }, { op: 'put', el: image(`img-${rand()}`, fileA, boardId) }]);
  assert((await pageA.request.get(`${B}${fileA}`)).status() === 200, 'owner cannot load her file');
  assert((await pageB.request.get(`${B}${fileA}`)).status() === 404, 'Bob can load Alice\'s file');
  assert((await fetch(`${B}${fileA}`)).status === 401 || (await fetch(`${B}${fileA}`)).status === 404, 'signed-out visitor can load it');
  // Bob references Alice's file from his own board and asks for the ZIP.
  const bobBoard = `bobzip-${rand()}`;
  await ops(pageB, B, [{ op: 'put', el: board(bobBoard, 'Bob zip') }, { op: 'put', el: image(`bimg-${rand()}`, fileA, bobBoard) }]);
  const zip = await pageB.request.get(`${B}/api/board-files/${bobBoard}`);
  assert(zip.status() === 404, `Bob's ZIP of Alice's file: ${zip.status()}`);
  const own = await pageA.request.get(`${B}/api/board-files/${boardId}`);
  assert(own.status() === 200, `Alice's own ZIP: ${own.status()}`);
  fact(`${fileA}: Alice 200 · Bob 404 · signed out 401 · Bob's ZIP that references it 404 · Alice's ZIP 200`);
  const bobTab = await newPage({ storageState: await pageB.context().storageState() });
  await bobTab.goto(`${B}${fileA}`);
  await shot(bobTab, "Bob opens Alice's file URL");
});

await check('L10', 'Public links: anyone can view a published board and its images; nobody can hijack the link; unpublishing hides both', async () => {
  const token = `tok${rand()}${rand()}${rand()}${rand()}`;
  const pubBoard = `pub-${rand()}`;
  const up = await pageA.request.post(`${B}/api/upload?name=pub.png`, { data: Buffer.concat([PNG, Buffer.from(rand())]), headers: { 'content-type': 'image/png' } });
  const pubFile = (await up.json()).url;
  await ops(pageA, B, [{ op: 'put', el: board(pubBoard, 'Alice public', { publicToken: token }) }, { op: 'put', el: note(`pn-${rand()}`, 'hello public', pubBoard) }, { op: 'put', el: image(`pi-${rand()}`, pubFile, pubBoard) }]);
  // Bob tries to take over the same token with his own board.
  await ops(pageB, B, [{ op: 'put', el: board(`hijack-${rand()}`, 'Bob fake', { publicToken: token }) }]);
  const anon = await newPage();
  await anon.goto(`${B}/p/${token}`);
  await anon.waitForSelector('[data-el]', { timeout: 8000 });
  assert((await anon.content()).includes('hello public'), 'published note not shown to a signed-out visitor');
  await shot(anon, 'public link opened signed out');
  const pub = await (await fetch(`${B}/api/public/${token}`)).json();
  assert(pub.board === pubBoard, `link resolves to ${pub.board} (hijacked?)`);
  assert(!JSON.stringify(pub).includes(idsA.secret), 'published view leaks unrelated notes');
  assert((await fetch(`${B}${pubFile}`)).status === 200, 'image on a published board not loadable signed-out');
  const bobView = await pageB.request.get(`${B}/api/public/${token}`);
  assert(bobView.ok(), `Bob (signed in) can't view the public board: ${bobView.status()}`);
  const bobState = await state(pageB, B);
  assert(!bobState.body.elements.some((e) => e.content?.publicToken === token), "Bob's board kept Alice's token");
  await ops(pageA, B, [{ op: 'put', el: board(pubBoard, 'Alice public', { publicToken: null }) }]);
  assert((await fetch(`${B}/api/public/${token}`)).status === 404, 'still published after unpublish');
  assert((await fetch(`${B}${pubFile}`)).status !== 200, 'image still public after unpublish');
  await anon.reload();
  await wait(800);
  await shot(anon, 'same link after unpublish');
  fact("Bob saved a board with Alice's token: the server dropped the token, the link still shows Alice's board");
});

await check('L11', "Board passwords are per account: Bob can't unlock or remove Alice's lock, and a lock hides only her board", async () => {
  const locked = `locked-${rand()}`;
  await ops(pageA, B, [{ op: 'put', el: board(locked, 'Alice locked') }, { op: 'put', el: note(`ln-${rand()}`, 'inside locked', locked) }]);
  const set = await pageA.request.post(`${B}/api/board-lock`, { data: { id: locked, password: 'board-pass' } });
  assert(set.ok(), `lock: ${set.status()}`);
  const fresh = await newPage();
  await uiSignin(fresh, B, emailA, passA);
  await fresh.waitForSelector('.toolbar');
  const s = await state(fresh, B);
  assert(!JSON.stringify(s.body.elements).includes('inside locked'), 'locked contents visible in a new browser');
  const bobTry = await pageB.request.post(`${B}/api/board-unlock`, { data: { id: locked, password: 'board-pass' } });
  assert(bobTry.status() === 404, `Bob unlocking Alice's board: ${bobTry.status()}`);
  const bobRemove = await pageB.request.post(`${B}/api/board-unlock-remove`, { data: { id: locked, password: 'board-pass' } });
  const again = await state(fresh, B);
  assert(bobRemove.ok() && !JSON.stringify(again.body.elements).includes('inside locked'), "Bob's remove call affected Alice's lock");
});

// ------------------------------------------------------------------ sessions and account settings
let pageA2;
await check('L12', 'Two browsers on one account see the same boards', async () => {
  pageA2 = await newPage();
  await uiSignin(pageA2, B, emailA, passA);
  await pageA2.waitForSelector('.toolbar');
  const marker = `shared-${rand()}`;
  await ops(pageA, B, [{ op: 'put', el: note(`sh-${rand()}`, marker) }]);
  await pageA2.reload();
  await pageA2.waitForSelector('.toolbar');
  await wait(400);
  assert((await pageA2.content()).includes(marker), 'second browser does not show the new note');
});

await check('L13', 'Change password in the Account dialog: checks the current one, signs out other browsers, old password stops working', async () => {
  await openMenuItem(pageA, 'Account');
  await pageA.waitForSelector('.account-section');
  const pw = pageA.locator('.account-section input[type="password"]');
  await pw.nth(0).fill('not-my-password');
  await pw.nth(1).fill('alice-new-pass-2');
  await pw.nth(2).fill('alice-new-pass-2');
  await pageA.locator('.account-section button[type="submit"]', { hasText: 'Change password' }).click();
  await pageA.waitForSelector('.account-section .error-text');
  assert(/current password is incorrect/.test(await pageA.textContent('.account-section .error-text')), 'no wrong-password error');
  await shot(pageA, 'wrong current password');
  await pw.nth(0).fill(passA);
  await pw.nth(2).fill('alice-new-pass-X');
  await pageA.locator('.account-section button[type="submit"]', { hasText: 'Change password' }).click();
  await pageA.waitForFunction(() => /match/.test(document.querySelector('.account-section .error-text')?.textContent || ''));
  await pw.nth(2).fill('alice-new-pass-2');
  await pageA.locator('.account-section button[type="submit"]', { hasText: 'Change password' }).click();
  await pageA.waitForSelector('.toast', { timeout: 5000 });
  await shot(pageA, 'password changed');
  passA = 'alice-new-pass-2';
  assert((await state(pageA, B)).status === 200, 'this browser was signed out');
  assert((await state(pageA2, B)).status === 401, 'the other browser is still signed in');
  const old = await fetch(`${B}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.70.0.1' }, body: JSON.stringify({ email: emailA, password: 'alice-password-1' }) });
  assert(old.status === 401, `old password: ${old.status}`);
  await pageA2.reload();
  await pageA2.waitForSelector('#email');
  await shot(pageA2, 'other browser signed out');
  fact(`other browser → ${(await state(pageA2, B)).status}; old password → ${old.status}`);
  await pageA.keyboard.press('Escape');
});

await check('L14', 'Rename in the Account dialog; Unicode and long passwords work', async () => {
  await openMenuItem(pageA, 'Account');
  await pageA.fill('#account-name', 'Alice Ünïcode');
  await pageA.locator('.account-section .row-input button').click();
  await wait(600);
  assert((await state(pageA, B)).body.user.name === 'Alice Ünïcode', 'name not saved');
  await pageA.keyboard.press('Escape');
  const p = await newPage();
  const email = `uni-${rand()}@example.com`;
  const pass = 'pässwörd-日本語-🔐-' + 'x'.repeat(150);
  assert((await apiSignup(p, B, email, pass)).ok(), 'sign-up with a Unicode password failed');
  const login = await p.request.post(`${B}/api/login`, { data: { email, password: pass }, headers: { 'x-forwarded-for': '10.71.0.1' } });
  assert(login.ok(), `sign-in with a Unicode password: ${login.status()}`);
  const tooLong = await apiSignup(p, B, `long-${rand()}@example.com`, 'y'.repeat(201));
  assert(tooLong.status() === 400, `201-character password: ${tooLong.status()}`);
});

await check('L15', 'Cross-site requests are refused; the cookie is HttpOnly, SameSite=Lax, and Secure behind HTTPS', async () => {
  const evil = await pageA.request.post(`${B}/api/ops`, { data: { ops: [{ op: 'del', id: idsA.note }] }, headers: { origin: 'https://evil.example' } });
  assert(evil.status() === 403, `foreign Origin: ${evil.status()}`);
  const stillThere = (await state(pageA, B)).body.elements.some((e) => e.id === idsA.note);
  assert(stillThere, 'the cross-site delete went through');
  const p = await newPage();
  const res = await p.request.post(`${B}/api/signup`, { data: { email: `https-${rand()}@example.com`, password: 'password-123' }, headers: { 'x-forwarded-proto': 'https', 'x-forwarded-for': '10.72.0.1' } });
  const cookie = res.headers()['set-cookie'] || '';
  assert(/HttpOnly/.test(cookie) && /SameSite=Lax/.test(cookie) && /Secure/.test(cookie) && /Max-Age=31536000/.test(cookie), `cookie: ${cookie}`);
});

await check('L16', 'Forged or garbage session cookies get the sign-in page, not an error', async () => {
  for (const value of ['garbage', 'x'.repeat(300), '"; DROP TABLE users; --']) {
    const res = await fetch(`${B}/`, { headers: { cookie: `cn_sid=${value}` } });
    const html = await res.text();
    assert(res.status === 200 && html.includes('id="email"'), `cookie "${value.slice(0, 20)}": ${res.status}`);
    const api = await fetch(`${B}/api/state`, { headers: { cookie: `cn_sid=${value}` } });
    assert(api.status === 401, `API with cookie "${value.slice(0, 20)}": ${api.status}`);
  }
});

await check('L17', "Link previews can't reach the server's private network; signed-out callers can't use the API", async () => {
  for (const target of ['http://127.0.0.1:5192/api/state', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]:5192/', 'http://10.0.0.1/', 'http://localhost:5192/']) {
    const r = await (await pageA.request.get(`${B}/api/unfurl?url=${encodeURIComponent(target)}`)).json();
    assert(!r.ok && !r.title, `${target} was fetched: ${JSON.stringify(r).slice(0, 80)}`);
  }
  for (const [method, route] of [['GET', '/api/unfurl?url=https://example.com'], ['POST', '/api/ai-ideas'], ['POST', '/api/upload'], ['GET', '/api/export'], ['POST', '/api/import']]) {
    const res = await fetch(`${B}${route}`, { method, headers: { 'content-type': 'application/json' }, body: method === 'POST' ? '{}' : undefined });
    assert(res.status === 401, `${method} ${route} signed out: ${res.status}`);
  }
});

await check('L18', 'Two sign-ups for one email at the same moment create exactly one account', async () => {
  const email = `race-${rand()}@example.com`;
  const p = await newPage();
  const all = await Promise.all(Array.from({ length: 6 }, (_, i) => p.request.post(`${B}/api/signup`, { data: { email, password: 'password-123' }, headers: { 'x-forwarded-for': `10.80.0.${i}` } })));
  const codes = all.map((r) => r.status()).sort();
  assert(codes.filter((c) => c === 200).length === 1 && codes.filter((c) => c === 409).length === 5, `statuses ${codes}`);
});

await check('L19', 'Sharing a browser: after Alice signs out, Bob signing in gets his own boards and his own first-run board', async () => {
  const p = await newPage();
  await uiSignin(p, B, emailA, passA);
  await p.waitForSelector('.toolbar');
  await wait(600);
  await p.click('.topbar button[title="More"]');
  await p.locator('.menu button.danger', { hasText: 'Sign out' }).click();
  await p.waitForSelector('#email');
  await p.click('#switch');
  const email = `carol-${rand()}@example.com`;
  await p.fill('#email', email);
  await p.fill('#password', 'carol-password');
  await p.click('#submit');
  await p.waitForSelector('.toolbar');
  await wait(1200);
  const s = await state(p, B);
  assert(s.body.user.email === email, `signed in as ${s.body.user.email}`);
  assert(s.body.elements.some((e) => e.type === 'board' && /Welcome/.test(e.content.title)), 'no welcome board: first-run flag leaked from the previous account');
  await shot(p, 'next person on the same browser gets their own boards');
  assert(!JSON.stringify(s.body).includes(idsA.secret), "Alice's data visible");
});

await check('L20', 'Language: the sign-in page follows the language chosen in the app on this device', async () => {
  const p = await newPage();
  await p.goto(B);
  await p.evaluate(() => localStorage.setItem('cn:lang', 'ja'));
  await p.reload();
  assert((await p.textContent('#submit')) === 'ログイン', `button says ${await p.textContent('#submit')}`);
  await p.fill('#email', 'x@example.com');
  await p.fill('#password', 'wrong-password');
  await p.click('#submit');
  await p.waitForFunction(() => document.getElementById('e').textContent.length > 0);
  assert(/メールアドレス/.test(await p.textContent('#e')), `error not translated: ${await p.textContent('#e')}`);
  await shot(p, 'sign-in page in Japanese');
  const ru = await newPage({ locale: 'ru-RU' });
  await ru.goto(B);
  assert((await ru.textContent('#submit')) === 'Войти', `browser language ignored: ${await ru.textContent('#submit')}`);
});

await check('L21', 'Delete account: needs the password, removes everything, keeps files another account also uploaded, frees the email', async () => {
  const p = await newPage();
  const email = `dave-${rand()}@example.com`;
  await apiSignup(p, B, email, 'dave-password');
  await p.goto(B);
  await p.waitForSelector('.toolbar');
  const shared = Buffer.concat([PNG, Buffer.from('shared-bytes')]);
  const solo = Buffer.concat([PNG, Buffer.from(`solo-${rand()}`)]);
  const sharedUrl = (await (await p.request.post(`${B}/api/upload?name=s.png`, { data: shared, headers: { 'content-type': 'image/png' } })).json()).url;
  const soloUrl = (await (await p.request.post(`${B}/api/upload?name=o.png`, { data: solo, headers: { 'content-type': 'image/png' } })).json()).url;
  await pageB.request.post(`${B}/api/upload?name=same.png`, { data: shared, headers: { 'content-type': 'image/png' } });
  await ops(p, B, [{ op: 'put', el: note(`dn-${rand()}`, 'dave note') }]);
  await openMenuItem(p, 'Account');
  const del = p.locator('.danger-zone input[type="password"]');
  await del.fill('wrong-password');
  await p.locator('.danger-zone button[type="submit"]').click();
  await p.waitForSelector('.danger-zone .error-text');
  await p.locator('.danger-zone').scrollIntoViewIfNeeded();
  await shot(p, 'delete needs the right password');
  await del.fill('dave-password');
  await p.locator('.danger-zone button[type="submit"]').click();
  await p.waitForSelector('#email', { timeout: 8000 });
  const login = await p.request.post(`${B}/api/login`, { data: { email, password: 'dave-password' }, headers: { 'x-forwarded-for': '10.90.0.1' } });
  assert(login.status() === 401, `deleted account can still sign in: ${login.status()}`);
  const files = readdirSync(path.join(S.dir, 'files'));
  assert(!files.includes(soloUrl.split('/').pop()), 'file only Dave had is still on disk');
  assert(files.includes(sharedUrl.split('/').pop()), "file Bob also uploaded was deleted from disk");
  assert((await pageB.request.get(`${B}${sharedUrl}`)).status() === 200, "Bob lost access to his copy");
  const again = await apiSignup(p, B, email, 'new-dave-password');
  assert(again.ok(), `email not reusable: ${again.status()}`);
  const fresh = await state(p, B);
  assert(!JSON.stringify(fresh.body).includes('dave note'), "the new account sees the deleted account's data");
});

await check('L22', 'Admin tool: reset-password changes it and signs out every browser on that account', async () => {
  const p = await newPage();
  const email = `erin-${rand()}@example.com`;
  await apiSignup(p, B, email, 'erin-password');
  assert((await state(p, B)).status === 200, 'not signed in');
  const out = execFileSync(process.execPath, [path.join(ROOT, 'server/admin.mjs'), 'reset-password', email, 'erin-reset-pass'], { env: { ...process.env, DATA_DIR: S.dir } }).toString();
  assert(/Password changed/.test(out), out);
  assert((await state(p, B)).status === 401, 'still signed in after reset');
  const login = await p.request.post(`${B}/api/login`, { data: { email, password: 'erin-reset-pass' }, headers: { 'x-forwarded-for': '10.91.0.1' } });
  assert(login.ok(), `new password: ${login.status()}`);
  const list = execFileSync(process.execPath, [path.join(ROOT, 'server/admin.mjs'), 'list'], { env: { ...process.env, DATA_DIR: S.dir } }).toString();
  assert(list.includes(email), 'list does not show the account');
});

// ------------------------------------------------------------------ server settings
await check('L23', 'Sign-ups closed: the first account can still be created (the owner), later ones are refused and the link is hidden', async () => {
  const s = await startServer('closed', 5193, { CANVASNOTES_SIGNUPS: 'closed' });
  const p = await newPage();
  assert((await apiSignup(p, s.base, `owner-${rand()}@example.com`)).ok(), 'owner could not sign up');
  const q = await newPage();
  const second = await apiSignup(q, s.base, `second-${rand()}@example.com`);
  assert(second.status() === 403, `second sign-up: ${second.status()}`);
  await q.goto(s.base);
  await shot(q, 'sign-ups closed');
  assert(await q.isHidden('#switch'), 'create-account link still shown');
  assert(await q.isVisible('#closed'), 'no "sign-ups are closed" note');
});

await check('L24', 'Invite code: required after the first account, wrong code refused, right code accepted', async () => {
  const s = await startServer('invite', 5194, { CANVASNOTES_INVITE_CODE: 'let-me-in' });
  const p = await newPage();
  assert((await apiSignup(p, s.base, `first-${rand()}@example.com`)).ok(), 'first account needed a code');
  const q = await newPage();
  assert((await apiSignup(q, s.base, `nocode-${rand()}@example.com`)).status() === 403, 'no code accepted');
  assert((await apiSignup(q, s.base, `bad-${rand()}@example.com`, 'password-123', { invite: 'nope' })).status() === 403, 'wrong code accepted');
  await q.goto(`${s.base}/#signup`);
  assert(await q.isVisible('#invite'), 'invite field not shown');
  await shot(q, 'invite code field');
  await q.fill('#email', `good-${rand()}@example.com`);
  await q.fill('#password', 'password-123');
  await q.fill('#invite', 'let-me-in');
  await q.click('#submit');
  await q.waitForSelector('.toolbar', { timeout: 8000 });
});

await check('L25', 'Storage quota: an upload past the per-account limit is refused with a clear error', async () => {
  const s = await startServer('quota', 5195, { CANVASNOTES_QUOTA_MB: '1' });
  const p = await newPage();
  await apiSignup(p, s.base, `q-${rand()}@example.com`);
  const ok = await p.request.post(`${s.base}/api/upload?name=a.bin`, { data: Buffer.alloc(700 * 1024, 1) });
  assert(ok.ok(), `first 700 KB: ${ok.status()}`);
  const again = await p.request.post(`${s.base}/api/upload?name=a.bin`, { data: Buffer.alloc(700 * 1024, 1) });
  assert(again.ok(), `re-uploading the same file counted twice: ${again.status()}`);
  const over = await p.request.post(`${s.base}/api/upload?name=b.bin`, { data: Buffer.alloc(700 * 1024, 2) });
  const body = await over.json();
  assert(over.status() === 413 && /storage is full/.test(body.error), `over quota: ${over.status()}`);
  fact(`1 MB quota: 700 KB ok, same file again ok (counted once), another 700 KB → ${over.status()} "${body.error}"`);
});

await check('L26', 'Upgrade: a database from before accounts is backed up, and the first account gets all its boards and files', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cn-acc-legacy-'));
  mkdirSync(path.join(dir, 'files'));
  writeFileSync(path.join(dir, 'files', 'legacyfile.png'), PNG);
  const db = new DatabaseSync(path.join(dir, 'canvasnotes.db'));
  db.exec('CREATE TABLE elements (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL); CREATE TABLE board_locks (board_id TEXT PRIMARY KEY, salt TEXT NOT NULL, hash TEXT NOT NULL);');
  const put = db.prepare('INSERT INTO elements VALUES (?, ?, ?)');
  put.run('old-board', JSON.stringify(board('old-board', 'From before accounts')), 1);
  put.run('old-img', JSON.stringify(image('old-img', '/files/legacyfile.png', 'old-board')), 1);
  db.close();
  const s = await startServer('legacy', 5196, {}, dir);
  assert(readdirSync(dir).some((f) => /before-accounts.*\.db$/.test(f)), `no backup made: ${readdirSync(dir)}`);
  fact(`backup written: ${readdirSync(dir).find((f) => /before-accounts/.test(f))}`);
  const p = await newPage();
  await apiSignup(p, s.base, `owner-${rand()}@example.com`);
  const st = await state(p, s.base);
  assert(st.body.elements.some((e) => e.id === 'old-board'), 'old boards not given to the first account');
  assert((await p.request.get(`${s.base}/files/legacyfile.png`)).status() === 200, 'old file not given to the first account');
  const q = await newPage();
  await apiSignup(q, s.base, `second-${rand()}@example.com`);
  const st2 = await state(q, s.base);
  assert(!st2.body.elements.some((e) => e.id === 'old-board'), 'second account also got the old boards');
  assert((await q.request.get(`${s.base}/files/legacyfile.png`)).status() === 404, 'second account can load the old file');
  // Restarting must not convert or back up again.
  s.proc.kill();
  await wait(300);
  const backups = readdirSync(dir).filter((f) => /before-accounts/.test(f)).length;
  const s2 = await startServer('legacy2', 5197, {}, dir);
  assert(readdirSync(dir).filter((f) => /before-accounts/.test(f)).length === backups, 'backed up again on restart');
  assert((await state(p, s2.base)).status === 200, 'session lost after restart');
});


// ------------------------------------------------------------------ deleted files are really deleted
let sweepServer;
await check('L27', 'Deleting an image frees its file and space; Trash keeps it; a copy another account uploaded stays theirs', async () => {
  // A 2-second grace period instead of 30 minutes, so the test doesn't wait.
  const s = (sweepServer = await startServer('sweep', 5198, { CANVASNOTES_FILE_GRACE_MIN: '0.03' }));
  const p = await newPage();
  const q = await newPage();
  await apiSignup(p, s.base, `sweep-${rand()}@example.com`);
  await apiSignup(q, s.base, `sweep2-${rand()}@example.com`);
  const upload = async (page, tag) => (await (await page.request.post(`${s.base}/api/upload?name=${tag}.png`, { data: Buffer.concat([PNG, Buffer.from(tag)]), headers: { 'content-type': 'image/png' } })).json()).url;
  const gone = `gone-${rand()}`;
  const trash = `trash-${rand()}`;
  const never = `never-${rand()}`;
  const shared = `shared-${rand()}`;
  const [fGone, fTrash, fNever, fShared] = [await upload(p, gone), await upload(p, trash), await upload(p, never), await upload(p, shared)];
  await upload(q, shared);
  const trashed = { ...image('img-trash', fTrash, 'root'), section: 'trash' };
  await ops(p, s.base, [{ op: 'put', el: image('img-gone', fGone, 'root') }, { op: 'put', el: trashed }, { op: 'put', el: image('img-shared', fShared, 'root') }]);
  await ops(q, s.base, [{ op: 'put', el: image('q-shared', fShared, 'root') }]);
  const before = (await (await p.request.get(`${s.base}/api/state`)).json()).storage.used;
  await ops(p, s.base, [{ op: 'del', id: 'img-gone' }, { op: 'del', id: 'img-shared' }]);
  await wait(9000);
  const disk = readdirSync(path.join(s.dir, 'files'));
  const name = (u) => u.split('/').pop();
  assert((await p.request.get(`${s.base}${fGone}`)).status() === 404 && !disk.includes(name(fGone)), 'deleted image still stored');
  assert(!disk.includes(name(fNever)), 'upload never put on a card still stored');
  assert((await p.request.get(`${s.base}${fTrash}`)).status() === 200, 'file of a card in the Trash was deleted');
  assert((await p.request.get(`${s.base}${fShared}`)).status() === 404, 'the account that deleted its card can still load the shared file');
  assert(disk.includes(name(fShared)) && (await q.request.get(`${s.base}${fShared}`)).status() === 200, "the other account lost its copy");
  const after = (await (await p.request.get(`${s.base}/api/state`)).json()).storage.used;
  assert(after < before, `storage not freed: ${before} → ${after}`);
  fact(`storage used ${before} → ${after} bytes; deleted, never-used and released files removed; Trash file kept; other account's copy kept on disk and loads for them`);
});

await check('L28', 'Undo right after deleting an image keeps the file; the Account dialog shows storage used', async () => {
  const s = sweepServer;
  const p = await newPage();
  await apiSignup(p, s.base, `undo-${rand()}@example.com`);
  const url = (await (await p.request.post(`${s.base}/api/upload?name=u.png`, { data: Buffer.concat([PNG, Buffer.from(rand())]), headers: { 'content-type': 'image/png' } })).json()).url;
  await ops(p, s.base, [{ op: 'put', el: image('undo-img', url, 'root') }]);
  await ops(p, s.base, [{ op: 'del', id: 'undo-img' }]);
  await wait(500);
  await ops(p, s.base, [{ op: 'put', el: image('undo-img', url, 'root') }]);
  await wait(9000);
  assert((await p.request.get(`${s.base}${url}`)).status() === 200, 'file deleted although the card came back');
  await p.goto(s.base);
  await p.waitForSelector('.toolbar');
  await p.click('.topbar button[title="More"]');
  await p.locator('.menu button', { hasText: 'Account' }).first().click();
  await p.waitForSelector('.storage-meter');
  const text = await p.textContent('.storage-meter');
  assert(/Storage: .* of 1\.0 GB used/.test(text), `meter says "${text}"`);
  await shot(p, 'storage meter in the Account dialog');
  fact(`meter: "${text}"`);
});

await suite.finish();
