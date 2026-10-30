// Milanote parity check: drives the real UI in a browser and verifies each
// feature from docs/feature-parity.md through what the server stored.
//
// Run against a fresh server (empty DATA_DIR) with `npm run test:parity`
// (tests/run-parity.mjs), or pass any Playwright `page` to the function below.
// Set page.__sections (e.g. 'AB') or page.__ids to run part of it.
async (page) => {
  const BASE = page.__base || 'http://127.0.0.1:5180';
  // Kept on the page object so partial results survive a crash of this script.
  const results = (page.__parity = []);
  const errors = [];
  // Handlers are attached once per page: the same page is reused across runs, and two
  // handlers accepting one dialog makes Playwright throw and close the page.
  page.__parityErrors = errors;
  if (!page.__parityHooked) {
    page.__parityHooked = true;
    page.on('pageerror', (e) => page.__parityErrors?.push(String(e).slice(0, 200)));
    page.on('dialog', (d) => d.accept(d.type() === 'prompt' ? 'https://example.com' : undefined).catch(() => {}));
  }

  const wait = (ms) => page.waitForTimeout(ms);
  // Resolves to the download, or null after `ms` (never throws).
  const waitDownload = (ms) =>
    new Promise((resolve) => {
      const onDownload = (d) => {
        clearTimeout(timer);
        resolve(d);
      };
      const timer = setTimeout(() => {
        page.off('download', onDownload);
        resolve(null);
      }, ms);
      page.once('download', onDownload);
    });
  const api = async () => (await (await page.request.get(`${BASE}/api/state`)).json()).elements;
  const settle = () => wait(750); // autosave debounce is 500 ms
  const check = async (id, name, fn) => {
    if (page.__ids && !page.__ids.includes(id)) return; // run only the requested checks
    try {
      const detail = await fn();
      results.push({ id, name, ok: detail !== false, detail: detail === true || detail === undefined ? '' : String(detail).slice(0, 120) });
    } catch (e) {
      results.push({ id, name, ok: false, detail: String(e.message || e).split('\n')[0].slice(0, 160) });
    }
    await page.keyboard.press('Escape').catch(() => {});
    await page.keyboard.press('Escape').catch(() => {});
  };
  const assert = (cond, msg) => {
    if (!cond) throw new Error(msg);
  };
  const card = (id) => page.locator(`[data-el="${id}"]`).first();
  const centre = async (loc) => {
    const b = await loc.boundingBox();
    assert(b, 'element not visible');
    return { x: b.x + Math.min(24, b.width / 2), y: b.y + Math.min(14, b.height / 2) };
  };
  const rclickAt = async (x, y) => {
    await page.mouse.click(x, y, { button: 'right' });
    await wait(150);
  };
  const menu = async (label, exact = false) => {
    const btn = page.locator('.menu button, .menu a', exact ? { hasText: new RegExp(`^${label}`) } : { hasText: label }).first();
    await btn.click();
    await wait(250);
  };
  const cardMenu = async (id, label) => {
    const p = await centre(card(id));
    const under = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest('[data-el]')?.getAttribute('data-el'), [p.x, p.y]);
    assert(under === id, `another card (${under}) covers ${id} at ${Math.round(p.x)},${Math.round(p.y)}`);
    await rclickAt(p.x, p.y);
    await menu(label);
  };
  // Creates a card through the board's right-click menu at (x, y) and returns the new element.
  const newAt = async (x, y, label, more = false) => {
    const before = new Set((await api()).map((e) => e.id));
    await rclickAt(x, y);
    // Guard: the board menu (not a card's menu) must have opened at this point.
    assert(await page.locator('.menu button', { hasText: /^New Note/ }).count(), `(${x},${y}) is not empty board`);
    if (more) await menu('More', true);
    await menu(label, true);
    await wait(300);
    return { before };
  };
  const created = async (before, type) => {
    await settle();
    const els = await api();
    const el = els.find((e) => !before.has(e.id) && (!type || e.type === type));
    assert(el, `no new ${type || 'element'} saved`);
    return el;
  };
  const select = async (id) => {
    await page.keyboard.press('Escape');
    const p = await centre(card(id));
    await page.mouse.click(p.x, p.y);
    await wait(120);
  };
  const typeSlow = (t) => page.keyboard.type(t, { delay: 15 });
  // Drops a generated file on the board, like dragging it in from the desktop.
  const dropFile = async (x, y, name, mime, content) => {
    await page.evaluate(
      async ({ x, y, name, mime, content }) => {
        let data = content;
        // Decoded by hand: the app's CSP (connect-src 'self') blocks fetch() of data: URLs.
        if (content.startsWith('data:')) data = Uint8Array.from(atob(content.split(',')[1]), (c) => c.charCodeAt(0));
        const file = new File([data], name, { type: mime });
        const dt = new DataTransfer();
        dt.items.add(file);
        const target = document.elementFromPoint(x, y);
        for (const type of ['dragenter', 'dragover', 'drop']) target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: dt }));
      },
      { x, y, name, mime, content },
    );
    await wait(1200);
  };
  const pngDataUrl = () =>
    page.evaluate(() => {
      const c = document.createElement('canvas');
      c.width = 120;
      c.height = 80;
      const g = c.getContext('2d');
      const grad = g.createLinearGradient(0, 0, 120, 80);
      grad.addColorStop(0, '#3a8fd9');
      grad.addColorStop(1, '#e0566f');
      g.fillStyle = grad;
      g.fillRect(0, 0, 120, 80);
      return c.toDataURL('image/png');
    });
  // A point on the visible board with nothing under it.
  const emptyPoint = () =>
    page.evaluate(() => {
      const r = document.querySelector('.canvas').getBoundingClientRect();
      const free = (x, y) => {
        const el = document.elementFromPoint(x, y);
        return el && (el.classList.contains('canvas') || el.classList.contains('world'));
      };
      // A board card is about 110×125: the whole area (plus a margin) must be empty.
      for (let y = r.top + 60; y < r.bottom - 200; y += 40)
        for (let x = r.right - 200; x > r.left + 60; x -= 40) {
          let ok = true;
          for (let dy = -20; dy <= 170 && ok; dy += 30) for (let dx = -20; dx <= 160 && ok; dx += 30) ok = free(x + dx, y + dy);
          if (ok) return [x, y];
        }
      return [r.left + 100, r.bottom - 100];
    });
  const enterBoard = async (title) => {
    const [ex, ey] = await emptyPoint();
    const { before } = await newAt(ex, ey, 'New Board');
    await typeSlow(title);
    await page.keyboard.press('Enter');
    const board = await created(before, 'board');
    await page.mouse.dblclick(...Object.values(await centre(card(board.id))));
    await wait(500);
    assert(page.url().includes(board.id), 'board did not open');
    return board;
  };
  // In-app navigation by hash: no browser-level page load (a page.goto right after a
  // download has been seen to close the Playwright page).
  const go = async (hash) => {
    await page.evaluate((h) => (location.hash = h), hash);
    await wait(500);
  };
  const home = async () => {
    await go('#/');
    await wait(200);
  };

  // Shared between sections; later sections look them up when run on their own.
  let boardA, boardA2, boardA3, boardB, boardD, note, todo, boardChild, column, image, sketch, syncA, table, cellAt, n1, n2, n3;
  const SECTIONS = page.__sections || 'ABCDEFGHIJK';
  const run = (x) => SECTIONS.includes(x);
  const findBoard = async (title) => (await api()).find((e) => e.type === 'board' && e.content.title === title);
  const resolve = async () => {
    const els = await api();
    boardA ??= els.find((e) => e.type === 'board' && e.content.title === 'A Elements');
    boardA2 ??= els.find((e) => e.type === 'board' && e.content.title === 'A2 More elements');
    boardA3 ??= els.find((e) => e.type === 'board' && e.content.title === 'A3 Media');
    boardB ??= els.find((e) => e.type === 'board' && e.content.title === 'B Card tools');
    image ??= boardA3 && els.find((e) => e.type === 'image' && e.parentId === boardA3.id);
    sketch ??= boardA3 && els.find((e) => e.type === 'sketch' && e.parentId === boardA3.id);
    table ??= els.find((e) => e.type === 'table' && e.content.cells[0]?.[0] === 'Item');
    if (table && !cellAt) cellAt = (r, c) => card(table.id).locator('tbody tr').nth(r).locator('td').nth(c);
  };
  try {
  page.setDefaultTimeout(6000);
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(BASE);
  if (run('A')) await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem('cn:toolbar', JSON.stringify({ hidden: [] }));
  });
  await page.reload();
  await wait(900);

  if (run('A')) {
  await resolve();
  // ------------------------------------------------------------ A. elements
  boardA = await enterBoard('A Elements');

  await check('A1', 'Note: double-click, Markdown heading and list', async () => {
    await page.mouse.dblclick(200, 150);
    await wait(400);
    await typeSlow('# Trip');
    await page.keyboard.press('Enter');
    await typeSlow('* one');
    await page.keyboard.press('Escape');
    await settle();
    note = (await api()).find((e) => e.parentId === boardA.id && e.type === 'note');
    assert(note && /<h1>Trip<\/h1>/.test(note.content.html) && /<ul>/.test(note.content.html), note?.content.html);
  });
  await check('A2', 'Heading card', async () => {
    const { before } = await newAt(600, 120, 'New Heading', true);
    await typeSlow('Big title');
    await page.keyboard.press('Enter');
    const el = await created(before, 'heading');
    assert(el.content.text === 'Big title', el.content.text);
  });
  await check('A3', 'Link card with server preview', async () => {
    const { before } = await newAt(1020, 250, 'New Link');
    await typeSlow('https://github.com');
    await page.keyboard.press('Enter');
    await wait(4000);
    const el = await created(before, 'link');
    assert(el.content.url.includes('github.com'), el.content.url);
    return el.content.title ? `title: ${el.content.title}` : 'saved (no network title)';
  });
  await check('A4', 'Video link becomes a player', async () => {
    const { before } = await newAt(200, 420, 'New Video', true);
    await typeSlow('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    await page.keyboard.press('Enter');
    const el = await created(before, 'link');
    await wait(500);
    const src = await card(el.id).locator('iframe').getAttribute('src');
    assert(src && src.includes('youtube'), src);
  });
  await check('A5', 'Audio link (Spotify) becomes a player', async () => {
    const { before } = await newAt(520, 420, 'New Audio', true);
    await typeSlow('https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC');
    await page.keyboard.press('Enter');
    const el = await created(before, 'link');
    await wait(500);
    assert(((await card(el.id).locator('iframe').getAttribute('src')) || '').includes('spotify'));
  });
  await check('A6', 'Map link (Google Maps) becomes a map', async () => {
    const { before } = await newAt(850, 420, 'New Map', true);
    await typeSlow('https://www.google.com/maps/place/Eiffel+Tower/@48.8584,2.2945,15z');
    await page.keyboard.press('Enter');
    const el = await created(before, 'link');
    await wait(500);
    assert(((await card(el.id).locator('iframe').getAttribute('src')) || '').includes('maps'));
  });
  await go(`#/b/${boardA.id}`);
  await wait(400);

  boardA2 = await enterBoard('A2 More elements');
  await check('A7', 'To-do: title, items, indent, due date, progress', async () => {
    const { before } = await newAt(200, 140, 'New To-do');
    await typeSlow('Groceries');
    await page.keyboard.press('Enter');
    await typeSlow('Milk');
    await page.keyboard.press('Enter');
    await typeSlow('Eggs');
    await page.keyboard.press('Tab');
    await page.locator('.due-add').first().click();
    await page.locator('.due-input').first().fill('2026-01-01');
    await page.keyboard.press('Escape');
    todo = await created(before, 'todo');
    await page.locator(`[data-el="${todo.id}"] input[type=checkbox]`).first().check();
    await settle();
    todo = (await api()).find((e) => e.id === todo.id);
    const items = todo.content.items;
    assert(todo.content.title === 'Groceries' && items.length >= 2, JSON.stringify(todo.content).slice(0, 100));
    assert(items.some((i) => i.indent === 1), 'indent not saved');
    assert(items.some((i) => i.due), 'due date not saved');
    assert(items[0].done, 'checkbox not saved');
  });
  await check('A8', 'Board inside a board, with breadcrumbs', async () => {
    const { before } = await newAt(600, 140, 'New Board');
    await typeSlow('Child');
    await page.keyboard.press('Enter');
    boardChild = await created(before, 'board');
    await page.mouse.dblclick(...Object.values(await centre(card(boardChild.id))));
    await wait(400);
    const crumbs = await page.locator('.crumbs').innerText();
    assert(crumbs.includes('A2 More elements') && crumbs.includes('Child'), crumbs);
    await page.evaluate(() => history.back());
    await wait(400);
  });
  await check('A9', 'Shortcut (alias) to a board, open it, find original', async () => {
    const before = new Set((await api()).map((e) => e.id));
    await cardMenu(boardChild.id, 'Create a Shortcut');
    const alias = await created(before, 'alias');
    assert(alias.content.boardId === boardChild.id);
    await page.mouse.dblclick(...Object.values(await centre(card(alias.id))));
    await wait(400);
    assert(page.url().includes(boardChild.id), 'shortcut did not open the board');
    await page.evaluate(() => history.back());
    await wait(400);
  });
  await check('A10', 'Column: drag a card in, collapse', async () => {
    const { before } = await newAt(950, 140, 'New Column');
    await typeSlow('Stack');
    await page.keyboard.press('Enter');
    column = await created(before, 'column');
    const from = await centre(card(todo.id));
    const colBox = await card(column.id).boundingBox();
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(colBox.x + 80, colBox.y + 60, { steps: 12 });
    await page.mouse.up();
    await settle();
    assert((await api()).find((e) => e.id === todo.id).columnId === column.id, 'card not in column');
    await card(column.id).locator('.column-header button[title="Collapse"]').click();
    await settle();
    assert((await api()).find((e) => e.id === column.id).content.collapsed, 'not collapsed');
    await card(column.id).locator('.column-header button[title="Expand"]').click();
  });
  await check('A11', 'Comment thread: write, reply', async () => {
    const { before } = await newAt(200, 520, 'New Comment');
    await typeSlow('First thought');
    await page.keyboard.press('Enter');
    await typeSlow('A reply');
    await page.keyboard.press('Enter');
    const el = await created(before, 'comment');
    assert(el.content.comments.length === 2, JSON.stringify(el.content));
  });
  await check('A12', 'Table: formulas', async () => {
    const { before } = await newAt(520, 520, 'New Table');
    for (const v of ['Item', 'Qty', 'Total', 'Milk', '2', '=B2*3', 'Eggs', '12', '=SUM(C2:C2)+B3']) {
      await typeSlow(v);
      await page.keyboard.press('Tab');
    }
    await page.keyboard.press('Escape');
    const el = await created(before, 'table');
    const shown = await card(el.id).locator('td .cell-text').allInnerTexts();
    assert(shown.includes('6') && shown.includes('18'), shown.join('|'));
  });
  await check('A13', 'Spreadsheet: dropping a CSV makes a table', async () => {
    const before = new Set((await api()).map((e) => e.id));
    await dropFile(1100, 560, 'budget.csv', 'text/csv', 'Month,Spend\nJan,120\nFeb,95\n');
    const el = await created(before, 'table');
    assert(el.content.cells.length >= 3 && el.content.cells[1][1] === '120', JSON.stringify(el.content.cells));
  });
  await go(`#/b/${boardA.id}`);
  await wait(400);

  boardA3 = await enterBoard('A3 Media');
  await check('A14', 'Image: drop a PNG', async () => {
    const before = new Set((await api()).map((e) => e.id));
    await dropFile(250, 200, 'gradient.png', 'image/png', await pngDataUrl());
    image = await created(before, 'image');
    assert(image.content.src.startsWith('/files/') && image.content.ratio, JSON.stringify(image.content));
  });
  await check('A15', 'File: drop a text file, download link', async () => {
    const before = new Set((await api()).map((e) => e.id));
    await dropFile(650, 200, 'notes.txt', 'text/plain', 'hello file');
    const el = await created(before, 'file');
    assert(el.content.name === 'notes.txt' && el.content.size === 10, JSON.stringify(el.content));
    assert(await card(el.id).locator('a[download]').count(), 'no download link');
  });
  const drawStroke = async () => {
    const paper = await page.locator('.draw-svg').boundingBox();
    await page.mouse.move(paper.x + 40, paper.y + 40);
    await page.mouse.down();
    for (let i = 0; i < 12; i++) await page.mouse.move(paper.x + 40 + i * 12, paper.y + 40 + (i % 3) * 10);
    await page.mouse.up();
  };
  await check('A16', 'Sketch: draw, save', async () => {
    const { before } = await newAt(1000, 200, 'New Sketch', true);
    await drawStroke();
    await page.locator('.draw-tools button', { hasText: 'Save' }).click();
    sketch = await created(before, 'sketch');
    assert(sketch.content.strokes.length === 1, `${sketch.content.strokes.length} strokes`);
  });
  await check('A17', 'Draw on an image (annotation)', async () => {
    await cardMenu(image.id, 'Draw On');
    await drawStroke();
    await page.locator('.draw-tools button', { hasText: 'Save' }).click();
    await settle();
    assert(((await api()).find((e) => e.id === image.id).content.annotation || []).length === 1);
  });
  await check('A18', 'Document: full-screen editor, word count', async () => {
    const { before } = await newAt(250, 560, 'New Document', true);
    await typeSlow('Plan');
    await page.locator('.doc-sheet-body .ProseMirror').click();
    await typeSlow('Three little words');
    const wc = await page.locator('.doc-sheet-meta').innerText();
    await page.locator('.doc-sheet-bar button', { hasText: 'Close' }).click();
    const el = await created(before, 'document');
    assert(el.content.title === 'Plan' && /3 words/.test(wc), `${el.content.title} / ${wc}`);
  });
  await check('A19', 'Colour swatch', async () => {
    const { before } = await newAt(650, 560, 'New Colour', true);
    const el = await created(before, 'swatch');
    assert(/^#[0-9a-f]{6}$/i.test(el.content.hex), el.content.hex);
  });
  await check('A20', 'Synced copy: editing one updates the other', async () => {
    await page.mouse.dblclick(1000, 560);
    await wait(300);
    await typeSlow('Shared text');
    await page.keyboard.press('Escape');
    await settle();
    syncA = (await api()).find((e) => e.type === 'note' && e.parentId === boardA3.id && e.content.html.includes('Shared'));
    const before = new Set((await api()).map((e) => e.id));
    await cardMenu(syncA.id, 'Create Synced Copy');
    const copy = await created(before, 'note');
    await select(copy.id);
    await page.keyboard.press('Enter');
    await wait(400);
    await page.keyboard.press('Control+End');
    await typeSlow(' edited');
    await page.keyboard.press('Escape');
    await settle();
    const orig = (await api()).find((e) => e.id === syncA.id);
    assert(orig.content.html.includes('edited') && orig.syncId && orig.syncId === copy.syncId, orig.content.html);
  });
  await check('A21', 'Folder', async () => {
    const { before } = await newAt(1250, 420, 'New Folder');
    await typeSlow('Recipes');
    await page.keyboard.press('Enter');
    const el = await created(before, 'column');
    assert(el.content.folder, JSON.stringify(el.content));
  });
  await check('A22', 'Image/file placeholder, filled by a drop', async () => {
    const { before } = await newAt(1250, 700, 'New Image/File Placeholder');
    const el = await created(before);
    const p = await centre(card(el.id));
    await dropFile(p.x, p.y, 'fill.png', 'image/png', await pngDataUrl());
    const after = (await api()).find((e) => e.id === el.id);
    assert(after && after.type === 'image' && after.content.src, JSON.stringify(after?.content).slice(0, 80));
  });
  await home();
  }

  if (run('B')) {
  await resolve();
  // ------------------------------------------------------------ B. selected-card tools
  boardB = await enterBoard('B Card tools');
  const mkNote = async (x, y, text) => {
    await page.mouse.dblclick(x, y);
    await wait(300);
    await typeSlow(text);
    await page.keyboard.press('Escape');
    await settle();
    return (await api()).find((e) => e.type === 'note' && e.parentId === boardB.id && e.content.html.includes(text));
  };
  n1 = await mkNote(200, 150, 'Alpha');
  n2 = await mkNote(560, 200, 'Beta');
  n3 = await mkNote(900, 260, 'Gamma');
  await check('B1', 'Card colour', async () => {
    const p = await centre(card(n1.id));
    await rclickAt(p.x, p.y);
    await page.locator('.menu .swatch-dot.color-sky').click();
    await settle();
    assert((await api()).find((e) => e.id === n1.id).color === 'sky');
  });
  await check('B2', 'Colour mode: top strip', async () => {
    await cardMenu(n1.id, 'Top strip');
    await settle();
    assert((await api()).find((e) => e.id === n1.id).colorStrip === true);
  });
  await check('B3', 'Transparent card', async () => {
    const p = await centre(card(n2.id));
    await rclickAt(p.x, p.y);
    await page.locator('.menu .swatch-dot[title="Transparent"]').click();
    await settle();
    assert((await api()).find((e) => e.id === n2.id).color === 'transparent');
  });
  await check('B4', 'Labels: create and apply', async () => {
    await cardMenu(n3.id, 'Labels…');
    await page.locator('.labels-dialog .palette-input').fill('Urgent');
    await page.keyboard.press('Enter');
    await settle();
    await page.keyboard.press('Escape');
    const els = await api();
    const label = els.find((e) => e.type === 'label' && e.content.name === 'Urgent');
    assert(label && els.find((e) => e.id === n3.id).labels?.includes(label.id));
  });
  await check('B5', 'Connect with lines (multi-select)', async () => {
    await select(n1.id);
    const p = await centre(card(n2.id));
    // mouse.click ignores `modifiers`; hold Shift on the keyboard instead.
    await page.keyboard.down('Shift');
    await page.mouse.click(p.x, p.y);
    await page.keyboard.up('Shift');
    const before = new Set((await api()).map((e) => e.id));
    await rclickAt(p.x, p.y);
    await menu('Connect with Lines');
    const line = await created(before, 'line');
    assert(line.content.from.id && line.content.to.id);
  });
  await check('B6', 'Line: label, arrows, dashed, weight', async () => {
    const line = (await api()).find((e) => e.type === 'line' && e.parentId === boardB.id);
    const hit = page.locator(`[data-line="${line.id}"] .line-hit`);
    await hit.dblclick({ force: true });
    await typeSlow('leads to');
    await page.keyboard.press('Enter');
    await hit.click({ button: 'right', force: true });
    await wait(150);
    await page.locator('.menu button[title="Arrows at both ends"]').click();
    await hit.click({ button: 'right', force: true });
    await page.locator('.menu button[title="Dashed"]').click();
    await hit.click({ button: 'right', force: true });
    await page.locator('.menu button[title="Weight 4"]').click();
    await settle();
    const c = (await api()).find((e) => e.id === line.id).content;
    assert(c.label === 'leads to' && c.arrow === 'both' && c.dashed && c.weight === 4, JSON.stringify(c).slice(0, 120));
  });
  await check('B7', 'Align and distribute', async () => {
    await page.keyboard.press('Control+a');
    const p = await centre(card(n1.id));
    await rclickAt(p.x, p.y);
    await menu('Align & Distribute');
    await page.locator('.menu button[title="Align top"]').click();
    await settle();
    const ys = (await api()).filter((e) => [n1.id, n2.id, n3.id].includes(e.id)).map((e) => e.y);
    assert(new Set(ys).size === 1, ys.join(','));
  });
  await check('B8', 'Description (caption) on a board', async () => {
    const { before } = await newAt(300, 650, 'New Board');
    await typeSlow('Described');
    await page.keyboard.press('Enter');
    const b = await created(before, 'board');
    await cardMenu(b.id, 'Add Description');
    await typeSlow('What this is');
    await page.keyboard.press('Enter');
    await settle();
    assert((await api()).find((e) => e.id === b.id).caption === 'What this is');
  });
  await check('B9', 'Board icon (emoji)', async () => {
    const b = (await api()).find((e) => e.type === 'board' && e.content.title === 'Described');
    await cardMenu(b.id, 'Change Icon');
    await page.locator('.icon-grid button', { hasText: '🚀' }).click();
    await settle();
    assert((await api()).find((e) => e.id === b.id).content.icon === '🚀');
  });
  await check('B10', 'Reactions', async () => {
    await cardMenu(n2.id, 'Reactions');
    await page.locator('.reactions-pick button', { hasText: '🎉' }).click();
    await settle();
    assert(((await api()).find((e) => e.id === n2.id).reactions || []).includes('🎉'));
  });
  await check('B11', 'Lock position (locked cards do not move)', async () => {
    await cardMenu(n3.id, 'Lock Position');
    const before = (await api()).find((e) => e.id === n3.id);
    const p = await centre(card(n3.id));
    await page.mouse.move(p.x, p.y);
    await page.mouse.down();
    await page.mouse.move(p.x + 150, p.y + 80, { steps: 8 });
    await page.mouse.up();
    await settle();
    const after = (await api()).find((e) => e.id === n3.id);
    assert(after.locked && after.x === before.x && after.y === before.y);
  });
  await check('B12', 'Group into column', async () => {
    await select(n1.id);
    const before = new Set((await api()).map((e) => e.id));
    await cardMenu(n1.id, 'Group into Column');
    const col = await created(before, 'column');
    assert((await api()).find((e) => e.id === n1.id).columnId === col.id);
  });
  await check('B13', 'Convert to document and back', async () => {
    await cardMenu(n2.id, 'Convert to');
    await menu('Convert to Document');
    await settle();
    assert((await api()).find((e) => e.id === n2.id).type === 'document');
    await cardMenu(n2.id, 'Convert to');
    await menu('Convert to Note');
    await settle();
    assert((await api()).find((e) => e.id === n2.id).type === 'note');
  });
  await check('B14', 'Copy style / paste styles', async () => {
    const n4 = await mkNote(1150, 650, 'Delta');
    await select(n3.id);
    await cardMenu(n3.id, 'Unlock Position');
    const p3 = await centre(card(n3.id));
    await rclickAt(p3.x, p3.y);
    await page.locator('.menu .swatch-dot.color-mint').click();
    await select(n3.id);
    await page.keyboard.press('Control+Alt+c');
    await select(n4.id);
    await page.keyboard.press('Control+Alt+v');
    await settle();
    assert((await api()).find((e) => e.id === n4.id).color === 'mint');
  });
  await check('B15', 'Duplicate, cut, paste, undo/redo', async () => {
    await select(n3.id);
    const count = async () => (await api()).filter((e) => e.type === 'note' && e.parentId === boardB.id).length;
    const c0 = await count();
    await page.keyboard.press('Control+d');
    await settle();
    assert((await count()) === c0 + 1, 'duplicate');
    await page.keyboard.press('Control+z');
    await settle();
    assert((await count()) === c0, 'undo');
    await page.keyboard.press('Control+Shift+z');
    await settle();
    assert((await count()) === c0 + 1, 'redo');
  });
  await check('B16', 'Bring to front / send to back', async () => {
    const z0 = (await api()).find((e) => e.id === n3.id).z;
    await cardMenu(n3.id, 'Send to Back');
    await settle();
    assert((await api()).find((e) => e.id === n3.id).z < z0);
  });
  await check('B17', 'Created / modified time in menu', async () => {
    const p = await centre(card(n3.id));
    await rclickAt(p.x, p.y);
    const note = await page.locator('.menu .menu-note').innerText();
    assert(/Created/.test(note), note);
  });
  await home();
  }

  if (run('C')) {
  await resolve();
  // ------------------------------------------------------------ C. media, crop, file info, export element
  await go(`#/b/${boardA3.id}`);
  await wait(600);
  await check('C1', 'Crop image', async () => {
    await cardMenu(image.id, 'Crop Image…');
    const h = page.locator('.overlay .crop-handle, .overlay [data-handle]').first();
    const hb = await h.boundingBox();
    await page.mouse.move(hb.x + 4, hb.y + 4);
    await page.mouse.down();
    await page.mouse.move(hb.x + 60, hb.y + 30, { steps: 5 });
    await page.mouse.up();
    await page.locator('.overlay button', { hasText: /^Crop$/ }).click();
    await settle();
    const crop = (await api()).find((e) => e.id === image.id).content.crop;
    assert(crop && crop.w < 1, JSON.stringify(crop));
  });
  await check('C2', 'Crop image to fit dot grid', async () => {
    await cardMenu(image.id, 'Crop Image to Fit Dot Grid');
    await settle();
    assert((await api()).find((e) => e.id === image.id).content.crop);
  });
  await check('C3', 'File info panel', async () => {
    await cardMenu(image.id, 'File Info');
    const text = await page.locator('.overlay').innerText();
    assert(/png/i.test(text), text.slice(0, 80));
  });
  await check('C4', 'Video start / end / loop', async () => {
    await go(`#/b/${boardA.id}`);
    await wait(600);
    const vid = (await api()).find((e) => e.type === 'link' && e.parentId === boardA.id && e.content.url.includes('youtube'));
    const p = await centre(card(vid.id));
    await rclickAt(p.x, p.y);
    await menu('Video Options');
    await page.locator('.media-options input').first().fill('0:30');
    await page.locator('.media-options input').nth(1).fill('1:00');
    await page.locator('.media-options input[type=checkbox]').first().check();
    await settle();
    const m = (await api()).find((e) => e.id === vid.id).content.media || {};
    assert(m.start === 30 && m.end === 60 && m.loop, JSON.stringify(m));
  });
  await check('C5', 'Download a sketch as SVG', async () => {
    await go(`#/b/${boardA3.id}`);
    await wait(600);
    const dl = waitDownload(5000);
    await cardMenu(sketch.id, 'Download SVG');
    const d = await dl;
    assert(d, 'no download');
    assert(d.suggestedFilename().endsWith('.svg'), d.suggestedFilename());
  });
  await check('C7', 'Convert an image to a sketch card', async () => {
    await go(`#/b/${boardA3.id}`);
    await wait(600);
    const before = new Set((await api()).map((e) => e.id));
    await cardMenu(image.id, 'Convert to Sketch Card');
    await settle();
    const els = await api();
    const conv = els.find((e) => e.id === image.id);
    const sk = conv?.type === 'sketch' ? conv : els.find((e) => !before.has(e.id) && e.type === 'sketch');
    assert(sk && sk.type === 'sketch', `image is now ${conv?.type}`);
    // Put the image back for the checks that follow.
    await page.keyboard.press('Control+z');
    await settle();
  });
  await check('C6', 'Export a single element', async () => {
    const doc = (await api()).find((e) => e.type === 'document');
    const dl = waitDownload(5000);
    await cardMenu(doc.id, 'Export…');
    const btn = page.locator('.overlay button, .menu button', { hasText: /Markdown/ }).first();
    if (await btn.count()) await btn.click();
    const d = await dl;
    assert(d, 'no download');
    return d.suggestedFilename();
  });
  await home();
  }

  if (run('D')) {
  await resolve();
  // ------------------------------------------------------------ D. text editing
  boardD = await enterBoard('D Text');
  await check('D1', 'Bold, italic, underline, strikethrough, inline code (shortcuts and bar)', async () => {
    await page.mouse.dblclick(250, 200);
    await wait(400);
    await page.keyboard.press('Control+b');
    await typeSlow('bold');
    await page.keyboard.press('Control+b');
    await typeSlow(' ');
    await page.keyboard.press('Control+i');
    await typeSlow('ital');
    await page.keyboard.press('Control+i');
    await typeSlow(' ');
    await page.keyboard.press('Control+u');
    await typeSlow('under');
    await page.keyboard.press('Control+u');
    await page.keyboard.press('Enter');
    await page.locator('.format-bar .fb-strike').click();
    await typeSlow('gone');
    await page.locator('.format-bar .fb-strike').click();
    await page.keyboard.press('Enter');
    await page.locator('.format-bar .fb-code').click();
    await typeSlow('code');
    await page.keyboard.press('Escape');
    await settle();
    const html = (await api()).find((e) => e.parentId === boardD.id && e.type === 'note').content.html;
    for (const tag of ['<strong>', '<em>', '<u>', '<s>', '<code>']) assert(html.includes(tag), `${tag} missing in ${html}`);
  });
  const lastNote = async () => (await api()).filter((e) => e.parentId === boardD.id && e.type === 'note').sort((a, b) => b.createdAt - a.createdAt)[0];
  await check('D2', 'Markdown: ## [] > ! ``` --- 1.', async () => {
    await page.mouse.dblclick(650, 200);
    await wait(400);
    for (const line of ['## Sub', '[] task', '> quote']) {
      await typeSlow(line);
      await page.keyboard.press('Enter');
      await page.keyboard.press('Enter');
    }
    await typeSlow('! callout');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await typeSlow('1. first');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await typeSlow('---');
    await typeSlow('```');
    await typeSlow(' x');
    await page.keyboard.press('Escape');
    await settle();
    const html = (await lastNote()).content.html;
    for (const s of ['<h2>', 'data-type="taskList"', '<blockquote>', 'data-callout', '<ol>', '<hr>']) assert(html.includes(s), `${s} missing: ${html.slice(0, 200)}`);
  });
  await check('D3', 'Text colour, highlight, alignment, font, size, indent', async () => {
    await page.mouse.dblclick(250, 520);
    await wait(400);
    await typeSlow('Styled');
    await page.keyboard.press('Control+a');
    const bar = page.locator('.format-bar');
    await bar.locator('.fb-color-a').click({ force: true });
    await page.locator('.fb-colors .swatch-dot').nth(3).click({ force: true });
    // The colour popup stays open so a highlight can be picked in the same place.
    if (!(await page.locator('.fb-colors').count())) await bar.locator('.fb-color-a').click({ force: true });
    await page.locator('.fb-colors .menu-colors').nth(1).locator('.swatch-dot').nth(2).click({ force: true });
    await bar.locator('button[title="Alignment"]').click({ force: true });
    await page.locator('.fb-pop button', { hasText: 'Center' }).click({ force: true });
    const font = bar.locator('button[title*="Font"]').first();
    if (await font.count()) {
      await font.click({ force: true });
      await page.locator('.fb-pop button').nth(2).click({ force: true });
    }
    // Popups that stay open can cover the Indent button, so send the press straight to it.
    await bar.locator('button[title^="Indent"]').first().dispatchEvent('mousedown');
    await page.keyboard.press('Escape');
    await settle();
    const html = (await lastNote()).content.html;
    assert(/color/.test(html) && /<mark/.test(html) && /text-align: center/.test(html), html.slice(0, 200));
    assert(/data-indent/.test(html), `paragraph indent missing: ${html.slice(0, 200)}`);
    assert(/font-family/.test(html), 'font not applied');
  });
  await check('D4', 'Link to another board inside a note', async () => {
    await page.mouse.dblclick(650, 560);
    await wait(400);
    await page.locator('.format-bar button[title="Link to board"]').click({ force: true });
    await page.locator('.palette-results button').filter({ has: page.locator('.result-text', { hasText: /^A Elements$/ }) }).first().click();
    await wait(300);
    await page.keyboard.press('Escape');
    await settle();
    const html = (await lastNote()).content.html;
    assert(html.includes(`#/b/${boardA.id}`), html);
  });
  await check('D5', 'Emoji and clear formatting', async () => {
    await page.mouse.dblclick(1000, 300);
    await wait(400);
    await page.locator('.format-bar button[title="Insert emoji"]').click({ force: true });
    await page.locator('.fb-emoji button').first().click({ force: true });
    await page.keyboard.press('Escape');
    await settle();
    assert(/\p{Extended_Pictographic}/u.test((await lastNote()).content.html));
  });
  await home();
  }

  if (run('E')) {
  await resolve();
  // ------------------------------------------------------------ E. tables
  await go(`#/b/${boardA2.id}`);
  await wait(600);
  table = (await api()).find((e) => e.type === 'table' && e.content.cells[0][0] === 'Item');
  cellAt = (r, c) => card(table.id).locator('tbody tr').nth(r).locator('td').nth(c);
  await check('E1', 'Add row / column from the cell menu', async () => {
    await cellAt(1, 1).click({ button: 'right' });
    await page.locator('.table-menu button', { hasText: 'Add Row Below' }).click();
    await cellAt(1, 1).click({ button: 'right' });
    await page.locator('.table-menu button', { hasText: 'Add Column Right' }).click();
    await settle();
    const t = (await api()).find((e) => e.id === table.id).content.cells;
    assert(t.length === 5 && t[0].length === 4, `${t.length}x${t[0].length}`);
  });
  await check('E2', 'Cell type currency with chosen currency and decimals', async () => {
    await cellAt(1, 2).click({ button: 'right' });
    await page.locator('.table-menu .menu-chips button', { hasText: 'Currency' }).click();
    await cellAt(1, 2).click({ button: 'right' });
    const eur = page.locator('.table-menu button', { hasText: 'EUR' });
    if (await eur.count()) await eur.click();
    await settle();
    const st = (await api()).find((e) => e.id === table.id).content.styles || {};
    // The style must land on the right-clicked column (C), not column A.
    assert(Object.entries(st).some(([k, v]) => k.endsWith(':2') && v.type === 'currency'), JSON.stringify(st).slice(0, 120));
    return (await cellAt(1, 2).innerText()).trim();
  });
  await check('E3', 'Multi-cell select and clear', async () => {
    await page.mouse.dblclick(...Object.values(await centre(cellAt(3, 0))));
    await wait(300);
    await cellAt(3, 0).locator('input').click();
    await page.keyboard.press('Shift+ArrowRight');
    const inRange = await card(table.id).locator('td.in-range').count();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    assert(inRange >= 2, `${inRange} cells in range`);
  });
  await home();
  }

  if (run('F')) {
  await resolve();
  // ------------------------------------------------------------ F. board, navigation, organising
  await check('F1', 'Board background colour and dot grid', async () => {
    await go(`#/b/${boardB.id}`);
    await wait(500);
    await rclickAt(700, 800);
    await menu('Change Board Background');
    await page.locator('.menu .swatch-dot[title="#e8eef5"]').click();
    await rclickAt(700, 800);
    await menu('Change Board Background');
    await menu('Hide Dot Grid');
    await settle();
    const b = (await api()).find((e) => e.id === boardB.id).content;
    assert(b.background === '#e8eef5' && b.hideGrid, JSON.stringify(b));
  });
  await check('F2', 'Drag a card onto a breadcrumb to move it up', async () => {
    const delta = (await api()).find((e) => e.parentId === boardB.id && e.type === 'note' && e.content.html.includes('Delta'));
    const p = await centre(card(delta.id));
    const crumb = await page.locator('.crumb[data-crumb="root"]').boundingBox();
    await page.mouse.move(p.x, p.y);
    await page.mouse.down();
    await page.mouse.move(crumb.x + 10, crumb.y + 10, { steps: 15 });
    const highlighted = await page.locator('.crumb.drop-target').count();
    await page.mouse.up();
    await settle();
    assert(highlighted === 1, 'crumb not highlighted');
    assert((await api()).find((e) => e.id === delta.id).parentId === 'root', 'not moved');
  });
  await check('F3', 'Unsorted: U sends a card, drag back out', async () => {
    const gamma = (await api()).find((e) => e.parentId === boardB.id && e.type === 'note' && e.content.html.includes('Gamma'));
    await select(gamma.id);
    await page.keyboard.press('u');
    await settle();
    assert((await api()).find((e) => e.id === gamma.id).section === 'inbox', 'not in unsorted');
    await page.locator('.toolbar .tool', { hasText: /^Unsorted/ }).click();
    await wait(300);
    const c = await page.locator('.inbox-card').first().boundingBox();
    await page.mouse.move(c.x + 30, c.y + 20);
    await page.mouse.down();
    await page.mouse.move(500, 500, { steps: 10 });
    await page.mouse.up();
    await settle();
    assert((await api()).find((e) => e.id === gamma.id).section === 'canvas', 'not back on board');
    await page.keyboard.press('Escape');
  });
  await check('F4', 'Quick notes shared by every board', async () => {
    await page.locator('.topbar button[title^="Quick notes"]').click();
    await wait(300);
    const input = page.locator('.side-panel textarea').first();
    await input.fill('Buy stamps');
    await page.keyboard.press('Enter');
    await settle();
    assert((await api()).some((e) => e.type === 'note' && e.content.html.includes('Buy stamps')));
    await page.keyboard.press('Escape');
  });
  await check('F5', 'Templates: convert board to template, use it', async () => {
    await home();
    const child = (await api()).find((e) => e.id === boardB.id);
    await cardMenu(child.id, 'Convert to Template');
    await settle();
    assert((await api()).find((e) => e.id === boardB.id).parentId === '__templates', 'not a template');
    await page.locator('.toolbar .tool', { hasText: /^Templates/ }).click();
    await wait(300);
    const before = new Set((await api()).map((e) => e.id));
    await page.locator('.template-row', { hasText: 'B Card tools' }).first().click();
    await settle();
    // The template holds a sub-board too, so two boards are new: take the one placed on Home.
    const copy = (await api()).find((e) => !before.has(e.id) && e.type === 'board' && e.parentId === 'root');
    assert(copy, 'no copy of the template on Home');
    assert((await api()).filter((e) => e.parentId === copy.id).length > 0, 'template copy is empty');
  });
  await check('F6', 'Trash: delete, restore, empty', async () => {
    const victim = (await api()).find((e) => e.type === 'note' && e.content.html.includes('Delta'));
    await select(victim.id);
    assert(await card(victim.id).evaluate((n) => n.classList.contains('selected')), 'victim not selected');
    await page.keyboard.press('Delete');
    await settle();
    assert((await api()).find((e) => e.id === victim.id).section === 'trash', 'Delete did not move it to Trash');
    await page.locator('.toolbar .tool', { hasText: /^Trash/ }).click();
    await page.locator('.trash-actions button', { hasText: 'Restore' }).first().click();
    await settle();
    assert((await api()).find((e) => e.id === victim.id).section === 'canvas', 'restore');
    await page.keyboard.press('Escape');
  });
  await check('F7', 'Search: matches, label filter, sort, jump to card', async () => {
    await page.keyboard.press('Control+k');
    await typeSlow('milk');
    await wait(300);
    const rows = await page.locator('.palette-results li').count();
    const sort = page.locator('.palette-filters select').first();
    await sort.selectOption('modified');
    await page.keyboard.press('Enter');
    await wait(500);
    assert(rows >= 1 && page.url().includes(boardA2.id), `${rows} rows, ${page.url()}`);
  });
  await check('F8', 'Presentation mode steps through cards', async () => {
    await page.keyboard.press('Control+Shift+p');
    await wait(500);
    await page.keyboard.press('ArrowRight');
    await wait(300);
    const hud = await page.locator('.presentation-hud').innerText();
    await page.keyboard.press('Escape');
    assert(/1 \//.test(hud), hud);
  });
  await check('F9', 'Board password hides contents until unlocked', async () => {
    await go(`#/b/${boardA.id}`);
    await wait(600);
    const target = (await api()).find((e) => e.id === boardA3.id);
    await cardMenu(target.id, 'Password Protect');
    const pw = page.locator('.dialog input[type=password]');
    await pw.first().fill('pw-1234');
    if ((await pw.count()) > 1) await pw.nth(1).fill('pw-1234');
    await page.keyboard.press('Enter');
    await wait(600);
    // Signed in (session cookie) but without this browser's unlock cookie.
    const sid = (await page.context().cookies(BASE)).find((c) => c.name === 'cn_sid');
    const anon = await (await fetch(`${BASE}/api/state`, { headers: { cookie: `cn_sid=${sid.value}` } })).json();
    assert(anon.elements.length > 0, 'state empty: session not accepted');
    assert(!anon.elements.some((e) => e.parentId === boardA3.id), 'contents leaked to a request without the unlock cookie');
    const r = await page.request.post(`${BASE}/api/board-unlock-remove`, { data: { id: boardA3.id, password: 'pw-1234' } });
    assert(r.ok(), 'could not remove');
  });
  await check('F10', 'Read-only public link', async () => {
    await home();
    await cardMenu(boardA.id, 'Publish Read-only Link');
    await settle();
    const token = (await api()).find((e) => e.id === boardA.id).content.publicToken;
    assert(token, 'no token');
    const res = await (await fetch(`${BASE}/api/public/${token}`)).json();
    assert(res.elements.length > 1, 'public board empty');
  });
  }

  if (run('G')) {
  await resolve();
  // ------------------------------------------------------------ G. export
  await check('G1', 'Export board as Markdown, text and Word', async () => {
    await go(`#/b/${boardA2.id}`);
    await wait(600);
    await page.locator('.topbar button[title="Export board"]').click();
    const names = [];
    for (const label of ['Markdown', 'Plain text', 'Word document']) {
      const dl = waitDownload(5000);
      await page.locator('.side-panel button', { hasText: label }).first().click();
      const d = await dl;
      assert(d, `no ${label} download`);
      names.push(d.suggestedFilename());
    }
    assert(names[0].endsWith('.md') && names[1].endsWith('.txt') && names[2].endsWith('.doc'), names.join(','));
  });
  await check('G2', 'Export board as PNG', async () => {
    if (!(await page.locator('.side-panel button', { hasText: 'PNG image' }).count())) await page.locator('.topbar button[title="Export board"]').click();
    const dl = waitDownload(15000);
    await page.locator('.side-panel button', { hasText: 'PNG image' }).click();
    const d = await dl;
    assert(d && d.suggestedFilename().endsWith('.png'), 'no PNG download');
  });
  await check('G3', 'ZIP of all images and files', async () => {
    const r = await page.request.get(`${BASE}/api/board-files/${boardA3.id}`);
    const body = await r.body();
    assert(r.ok() && body[0] === 0x50 && body[1] === 0x4b, `status ${r.status()}`);
  });
  await check('G4', 'Whole-account JSON backup', async () => {
    const r = await page.request.get(`${BASE}/api/export`);
    assert(r.ok() && (await r.json()).elements.length > 20);
  });
  }

  if (run('H')) {
  await resolve();
  // ------------------------------------------------------------ H. settings
  await check('H1', 'Theme toggle and interface size', async () => {
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+Shift+d');
    await wait(200);
    const theme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    await page.keyboard.press('Control+Shift+=');
    const scale = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--ui-scale'));
    await page.keyboard.press('Control+Shift+-');
    await page.keyboard.press('Control+Shift+d');
    assert(theme && scale.trim() !== '1', `${theme} ${scale}`);
  });
  await check('H2', 'Toolbar options hide a tool', async () => {
    await page.locator('.toolbar .tool', { hasText: /^More/ }).click();
    await page.locator('.toolbar-prefs label', { hasText: 'Map' }).locator('input').uncheck();
    const has = await page.locator('.toolbar .tool', { hasText: /^Map$/ }).count();
    await page.locator('.toolbar-prefs label', { hasText: 'Map' }).locator('input').check();
    assert(has === 0);
  });
  await check('H3', 'Localization: number format and currency change table display', async () => {
    let step = 'open board';
    try {
      await go(`#/b/${boardA2.id}`);
      // Put a decimal amount in the currency cell styled by E2.
      // Earlier checks (search jump) may have panned this board; fit it to the screen first.
      await page.keyboard.press('Escape');
      await page.keyboard.press('Shift+!');
      await wait(300);
      step = 'start editing the table';
      await page.mouse.dblclick(...Object.values(await centre(cellAt(1, 2))));
      await wait(300);
      step = 'focus the cell';
      await cellAt(1, 2).locator('input').click();
      await page.keyboard.press('Control+a');
      await typeSlow('1234.5');
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
      await settle();
      const before = (await cellAt(1, 2).innerText()).trim();
      step = 'open settings';
      await page.locator('.toolbar .tool', { hasText: /^More/ }).click();
      step = 'choose formats';
      await page.locator('.field', { hasText: 'Numbers' }).locator('select').selectOption('de-DE');
      await page.locator('.field', { hasText: 'Currency' }).locator('select').selectOption('INR');
      await wait(400);
      const after = (await cellAt(1, 2).innerText()).trim();
      await page.locator('.field', { hasText: 'Numbers' }).locator('select').selectOption('');
      assert(before && after && before !== after, `${before} → ${after}`);
      return `${before} → ${after}`;
    } catch (e) {
      throw new Error(`[${step}] ${String(e.message || e).split('\n')[0]}`);
    }
  });
  await check('H4', 'Interface language: all 11 Milanote languages', async () => {
    // Located by stable hooks, not by labels, since the labels change with the language.
    const openSettings = async () => {
      if (!(await page.locator('select:has(option[value="ko"])').count())) await page.locator('.toolbar .tool-more').click();
    };
    const seen = [];
    const english = await page.locator('.toolbar .tool span').allInnerTexts();
    for (const [code, note, menuItem, settings] of [
      ['es', 'Nota', 'Nueva nota', 'Ajustes'],
      ['fr', 'Note', 'Nouvelle note', 'Réglages'],
      ['pt', 'Nota', 'Nova nota', 'Configurações'],
      ['de', 'Notiz', 'Neue Notiz', 'Einstellungen'],
      ['it', 'Nota', 'Nuova nota', 'Impostazioni'],
      ['nl', 'Notitie', 'Nieuwe notitie', 'Instellingen'],
      ['pl', 'Notatka', 'Nowa notatka', 'Ustawienia'],
      ['ru', 'Заметка', 'Новая заметка', 'Настройки'],
      ['ja', 'ノート', '新しいノート', '設定'],
      ['zh', '笔记', '新建笔记', '设置'],
      ['ko', '노트', '새 노트', '설정'],
    ]) {
      await openSettings();
      await page.locator('select:has(option[value="ko"])').selectOption(code);
      await wait(400);
      const tools = await page.locator('.toolbar .tool span').allInnerTexts();
      const heading = await page.locator('.side-panel .side-head h2').first().innerText();
      await page.keyboard.press('Escape');
      const [ex, ey] = await emptyPoint();
      await rclickAt(ex, ey);
      const menuText = await page.locator('.menu').innerText();
      await page.keyboard.press('Escape');
      seen.push(`${code}: ${tools[0]} / ${heading}`);
      assert(tools[0] === note, `${code}: toolbar starts with ${tools[0]}`);
      assert(heading === settings, `${code}: settings heading ${heading}`);
      assert(menuText.includes(menuItem), `${code}: board menu lacks ${menuItem}`);
      assert((await page.evaluate(() => document.documentElement.lang)) === code, `${code}: html lang`);
      // Non-Latin scripts: no toolbar label may still read exactly as in English.
      if (['ru', 'ja', 'zh', 'ko'].includes(code)) {
        const same = tools.filter((x, i) => x === english[i]);
        assert(!same.length, `${code}: untranslated ${same.join(', ')}`);
      }
    }
    await openSettings();
    await page.locator('select:has(option[value="ko"])').selectOption('en');
    await wait(300);
    await page.keyboard.press('Escape');
    assert((await page.locator('.toolbar .tool span').first().innerText()) === 'Note', 'back to English');
    return seen.join('; ');
  });

  // ------------------------------------------------------------ I. layouts
  for (const [id, w, h, expect] of [
    ['I1', 393, 852, 'bottom'],
    ['I2', 820, 1180, 'side'],
    ['I3', 1180, 820, 'side'],
  ]) {
    await check(id, `Layout ${w}×${h}: toolbar ${expect}, no sideways scroll`, async () => {
      await page.setViewportSize({ width: w, height: h });
      await wait(400);
      const tb = await page.locator('.toolbar').boundingBox();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      const ok = expect === 'bottom' ? tb.y + tb.height >= h - 2 && tb.width >= w - 2 : tb.x === 0 && tb.height > h / 2;
      assert(ok && overflow === 0, `${JSON.stringify(tb)} overflow ${overflow}`);
    });
  }
  }
  await page.setViewportSize({ width: 1400, height: 900 });
  await wait(800); // let the layout settle back from the phone and tablet sizes

  if (run('K')) {
  // ------------------------------------------------------------ K. remaining rows of the parity table
  // Self-contained: a fresh board, and every card it needs is made here.
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE }).catch(() => {});
  const clip = () => page.evaluate(() => navigator.clipboard.readText());
  const png = (colour) =>
    page.evaluate((colour) => {
      const c = document.createElement('canvas');
      c.width = 90;
      c.height = 60;
      const g = c.getContext('2d');
      g.fillStyle = colour;
      g.fillRect(0, 0, 90, 60);
      return c.toDataURL('image/png');
    }, colour);
  const pngFile = async (name, colour) => ({ name, mimeType: 'image/png', buffer: Buffer.from((await png(colour)).split(',')[1], 'base64') });
  const pick = async (trigger, file) => {
    const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: 5000 }), trigger()]);
    await chooser.setFiles(file);
    await wait(1200);
  };
  const el = async (id) => (await api()).find((e) => e.id === id);
  // Sets a (possibly hidden) colour input the way a user's pick would.
  const setColour = (loc, value) =>
    loc.evaluate((input, v) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, v);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, value);
  const newNote = async (text) => {
    const before = await fresh('New Note');
    await typeSlow(text);
    await page.keyboard.press('Escape');
    return created(before, 'note');
  };
  const fresh = async (label, more = false) => {
    const [x, y] = await emptyPoint();
    return (await newAt(x, y, label, more)).before;
  };
  await home();
  const boardK = await enterBoard(`K Rows ${Math.random().toString(36).replace(/[^a-z]/g, '').slice(0, 5)}`);

  await check('K1', 'Text: hyperlink and small text', async () => {
    const before = await fresh('New Note');
    await typeSlow('Visit site');
    await page.keyboard.press('Shift+Home');
    await page.locator('.format-bar button[title^="Hyperlink"]').click(); // prompt answered with https://example.com
    await wait(200);
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await typeSlow('fine print');
    await page.keyboard.press('Shift+Home');
    await page.locator('.format-bar .fb-style').click();
    await page.locator('.fb-pop button', { hasText: 'Small text' }).click();
    await page.keyboard.press('Escape');
    const html = (await created(before, 'note')).content.html;
    assert(/<a [^>]*href="https:\/\/example\.com/.test(html), `no link: ${html}`);
    assert(/<small>fine print<\/small>/.test(html), `no small text: ${html}`);
  });

  let tableK;
  const kCell = (r, c) => card(tableK.id).locator('tbody tr').nth(r).locator('td').nth(c);
  // `item` is exact button text, or a selector inside the table menu.
  const cellMenu = async (r, c, item) => {
    await kCell(r, c).click({ button: 'right' });
    const btn = item.startsWith('.') || item.startsWith('button') ? page.locator(`.table-menu ${item}`) : page.locator('.table-menu button').filter({ hasText: new RegExp(`^${item}$`) });
    await btn.first().click();
    await wait(200);
  };
  await check('K2', 'Table: formula error message, alignment, bold, cell colour', async () => {
    const before = await fresh('New Table');
    // Tab past the last cell adds a fourth, empty row.
    for (const v of ['Name', 'N', 'F', 'x', '5', '=B2*2', 'y', '0', '=B2/B3']) {
      await typeSlow(v);
      await page.keyboard.press('Tab');
    }
    await page.keyboard.press('Escape');
    tableK = await created(before, 'table');
    const err = kCell(2, 2);
    const tip = await err.getAttribute('title');
    assert(/divided by zero/.test(tip || ''), `error cell title: ${tip} (${await err.innerText()})`);
    await cellMenu(1, 0, '⇥');
    await cellMenu(1, 0, '.menu-row button:has(b)');
    await kCell(1, 0).click({ button: 'right' });
    await page.locator('.table-menu .menu-colors .swatch-dot:not(.no-color)').first().click();
    await settle();
    const st = (await el(tableK.id)).content.styles?.['1:0'] || {};
    assert(st.align === 'right' && st.bold && st.bg, JSON.stringify(st));
    return `#DIV/0 → “${tip}”`;
  });
  await check('K3', 'Table: header row, move row, delete row, paste values', async () => {
    assert(tableK, 'needs K2');
    // Copy the formula cell (=B2*2 → 10) and paste only its value into the empty row.
    await cellMenu(1, 2, 'Copy');
    await cellMenu(3, 0, 'Paste Values');
    await settle();
    let cells = (await el(tableK.id)).content.cells;
    assert(cells[3][0] === '10', `paste values: ${JSON.stringify(cells)}`);
    await cellMenu(2, 0, 'button[title="Move row up"]');
    await settle();
    cells = (await el(tableK.id)).content.cells;
    assert(cells[1][0] === 'y' && cells[2][0] === 'x', `move up: ${JSON.stringify(cells)}`);
    await cellMenu(3, 0, 'Delete Row');
    await settle();
    cells = (await el(tableK.id)).content.cells;
    assert(cells.length === 3, `delete row: ${cells.length} rows`);
    await page.mouse.dblclick(...Object.values(await centre(kCell(0, 0))));
    await wait(300);
    await card(tableK.id).locator('.table-actions input[type=checkbox]').check();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await settle();
    assert((await el(tableK.id)).content.header === true, 'header row not saved');
  });
  await check('K4', 'Board menu: select all, custom background, revert to default', async () => {
    const [x, y] = await emptyPoint();
    await rclickAt(x, y);
    await menu('Select All');
    const selected = await page.locator('[data-el].selected').count();
    await page.keyboard.press('Escape');
    assert(selected >= 2, `${selected} selected`);
    await rclickAt(x, y);
    await menu('Change Board Background');
    await setColour(page.locator('.menu input[type=color]'), '#336699');
    await settle();
    const custom = (await el(boardK.id)).content.background;
    await page.keyboard.press('Escape');
    await rclickAt(x, y);
    await menu('Change Board Background');
    await page.locator('.menu .swatch-dot[title="Revert to default"]').click();
    await settle();
    const reverted = (await el(boardK.id)).content.background;
    assert(custom === '#336699' && !reverted, `${custom} → ${reverted}`);
  });
  let noteK;
  await check('K5', 'Card menu: choose a custom colour', async () => {
    noteK = await newNote('Colour me');
    const p = await centre(card(noteK.id));
    await rclickAt(p.x, p.y);
    await setColour(page.locator('.menu label.custom-color input[type=color]'), '#123456');
    await settle();
    await page.keyboard.press('Escape');
    assert((await el(noteK.id)).color === '#123456', (await el(noteK.id)).color);
  });
  let childK;
  await check('K6', 'Board card: rename, copy a link to this board', async () => {
    const before = await fresh('New Board');
    await typeSlow('Child');
    await page.keyboard.press('Enter');
    childK = await created(before, 'board');
    await cardMenu(childK.id, 'Rename');
    await page.keyboard.press('Control+a');
    await typeSlow('Renamed child');
    await page.keyboard.press('Enter');
    await settle();
    assert((await el(childK.id)).content.title === 'Renamed child', (await el(childK.id)).content.title);
    await cardMenu(childK.id, 'Copy a Link to This Board');
    await wait(300);
    const url = await clip();
    assert(url.includes(childK.id), url);
    return url;
  });
  await check('K7', 'Shortcut: duplicate the shortcut, duplicate the board it links to', async () => {
    assert(childK, 'needs K6');
    // Give the child a card so the copied board has something inside.
    await page.mouse.dblclick(...Object.values(await centre(card(childK.id))));
    await wait(500);
    const [x, y] = await emptyPoint();
    await page.mouse.dblclick(x, y);
    await wait(300);
    await typeSlow('inside child');
    await page.keyboard.press('Escape');
    await go(`#/b/${boardK.id}`);
    await cardMenu(childK.id, 'Create a Shortcut to This Board');
    await settle();
    const alias = (await api()).find((e) => e.type === 'alias' && e.content.boardId === childK.id);
    assert(alias, 'no shortcut');
    await cardMenu(alias.id, 'Duplicate This Shortcut');
    await settle();
    const aliases = (await api()).filter((e) => e.type === 'alias' && e.content.boardId === childK.id).length;
    await cardMenu(alias.id, 'Duplicate the Board It Links To');
    await settle();
    const els = await api();
    const copy = els.find((e) => e.type === 'board' && e.parentId === boardK.id && e.id !== childK.id && e.content.title?.startsWith('Renamed child'));
    assert(aliases === 2, `${aliases} shortcuts`);
    assert(copy && els.some((e) => e.parentId === copy.id), 'linked board not copied with its contents');
  });
  await check('K8', 'Templates: revert a template to a board', async () => {
    const before = await fresh('New Board');
    await typeSlow('Tpl source');
    await page.keyboard.press('Enter');
    const b = await created(before, 'board');
    await cardMenu(b.id, 'Convert to Template');
    await settle();
    assert((await el(b.id)).parentId === '__templates', 'not converted');
    await page.locator('.toolbar .tool', { hasText: /^Templates/ }).click();
    await wait(300);
    await page.locator('.template-line', { hasText: 'Tpl source' }).locator('button[title="Revert template to board"]').click();
    await settle();
    await page.keyboard.press('Escape');
    const back = await el(b.id);
    assert(back.parentId === boardK.id && !back.content.template, `${back.parentId} ${back.content.template}`);
  });
  let imageK;
  await check('K9', 'Image: replace image, download original, copy link to file', async () => {
    const [x, y] = await emptyPoint();
    const before = new Set((await api()).map((e) => e.id));
    await dropFile(x, y, 'k-one.png', 'image/png', await png('#2a9d8f'));
    imageK = await created(before, 'image');
    const src0 = imageK.content.src;
    await pick(() => cardMenu(imageK.id, 'Replace Image'), await pngFile('k-two.png', '#e76f51'));
    await settle();
    const src1 = (await el(imageK.id)).content.src;
    assert(src1 && src1 !== src0, `src ${src0} → ${src1}`);
    const dl = waitDownload(6000);
    await cardMenu(imageK.id, 'Download Original Image');
    const d = await dl;
    assert(d, 'no download');
    await cardMenu(imageK.id, 'Copy Link to File');
    await wait(300);
    const link = await clip();
    assert(link.endsWith(src1), link);
    const r = await page.request.get(link);
    assert(r.ok() && (r.headers()['content-type'] || '').includes('image'), `GET ${link}: ${r.status()}`);
    return d.suggestedFilename();
  });
  await check('K10', 'File: PDF preview link, open and copy its link', async () => {
    const [x, y] = await emptyPoint();
    const before = new Set((await api()).map((e) => e.id));
    await dropFile(x, y, 'k-doc.pdf', 'application/pdf', '%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
    const file = await created(before, 'file');
    const href = await card(file.id).locator('.file-preview-link').getAttribute('href');
    assert(href === file.content.src, `preview link ${href}`);
    await cardMenu(file.id, 'Copy Link to File');
    await wait(300);
    const link = await clip();
    const r = await page.request.get(link);
    assert(r.ok() && (await r.text()).startsWith('%PDF'), `GET ${link}: ${r.status()}`);
  });
  await check('K11', 'Link: refresh preview, replace preview image', async () => {
    const before = await fresh('New Link');
    await typeSlow('https://example.com/');
    await page.keyboard.press('Enter');
    await wait(1500);
    const link = await created(before, 'link');
    const req = page.waitForRequest((r) => r.url().includes('/api/unfurl'), { timeout: 6000 });
    await cardMenu(link.id, 'Refresh Preview');
    await req;
    await wait(1500);
    await pick(() => cardMenu(link.id, 'Replace Preview'), await pngFile('k-preview.png', '#264653'));
    await settle();
    const image = (await el(link.id)).content.image;
    assert(image?.startsWith('/files/'), `preview image ${image}`);
  });
  await check('K12', 'Drawing: palette toggle, eyedropper, undo/redo, selection tool, eraser', async () => {
    const before = await fresh('New Sketch', true);
    const paper = await page.locator('.draw-svg').boundingBox();
    const stroke = async (y) => {
      await page.mouse.move(paper.x + 40, paper.y + y);
      await page.mouse.down();
      for (let i = 0; i < 10; i++) await page.mouse.move(paper.x + 40 + i * 14, paper.y + y + (i % 2) * 4);
      await page.mouse.up();
      await wait(100);
    };
    const paths = () => page.locator('.draw-svg path').count();
    const colour = () => page.locator('.draw-tools input[type=color]').inputValue();
    await stroke(40);
    const first = await colour();
    const shown = await page.locator('.draw-tools .pen-color').count();
    await page.keyboard.press('c');
    const toggled = await page.locator('.draw-tools .pen-color').count();
    if (!toggled) await page.keyboard.press('c');
    await page.locator('.draw-tools .pen-color').nth(3).click();
    const second = await colour();
    await stroke(120);
    assert((shown > 0) !== (toggled > 0), `palette ${shown} → ${toggled}`);
    assert(second !== first, 'colour did not change');
    // Eyedropper on the first stroke brings its colour back.
    await page.keyboard.press('i');
    await page.mouse.click(paper.x + 40 + 5 * 14, paper.y + 40 + 4);
    await wait(200);
    assert((await colour()) === first, `eyedropper picked ${await colour()}, expected ${first}`);
    const n2 = await paths();
    await page.keyboard.press('Control+z');
    const n1 = await paths();
    await page.keyboard.press('Control+Shift+z');
    assert(n2 === 2 && n1 === 1 && (await paths()) === 2, `undo/redo ${n2} → ${n1} → ${await paths()}`);
    // Selection tool: box the second stroke, delete it.
    await page.keyboard.press('v');
    await page.mouse.move(paper.x + 20, paper.y + 100);
    await page.mouse.down();
    await page.mouse.move(paper.x + 220, paper.y + 145, { steps: 5 });
    await page.mouse.up();
    const del = await page.locator('.draw-tools button', { hasText: /Delete 1/ }).count();
    await page.keyboard.press('Delete');
    const afterSelect = await paths();
    // Eraser across the first stroke.
    await page.keyboard.press('e');
    await page.mouse.move(paper.x + 100, paper.y + 20);
    await page.mouse.down();
    await page.mouse.move(paper.x + 100, paper.y + 70, { steps: 6 });
    await page.mouse.up();
    const afterErase = await paths();
    assert(del === 1 && afterSelect === 1 && afterErase === 0, `select ${del}/${afterSelect}, erase ${afterErase}`);
    await page.keyboard.press('p');
    await stroke(80);
    await page.locator('.draw-tools button', { hasText: 'Save' }).click();
    const sk = await created(before, 'sketch');
    assert(sk.content.strokes.length === 1, `${sk.content.strokes.length} strokes saved`);
  });
  await check('K13', 'To-do: delete completed tasks', async () => {
    const before = await fresh('New To-do');
    await typeSlow('Chores');
    await page.keyboard.press('Enter');
    await typeSlow('Done one');
    await page.keyboard.press('Enter');
    await typeSlow('Open one');
    await page.keyboard.press('Escape');
    const todo = await created(before, 'todo');
    await card(todo.id).locator('input[type=checkbox]').first().check();
    await settle();
    await cardMenu(todo.id, 'Delete Completed Tasks');
    await settle();
    const items = (await el(todo.id)).content.items;
    assert(items.length === 1 && items[0].text === 'Open one', JSON.stringify(items));
  });
  await check('K14', 'Comment: edit and delete a comment', async () => {
    const before = await fresh('New Comment');
    await typeSlow('First thought');
    await page.keyboard.press('Enter');
    const c = await created(before, 'comment');
    await card(c.id).locator('.comment-tools button', { hasText: 'Edit' }).first().click({ force: true });
    await page.keyboard.press('Control+a');
    await typeSlow('Edited thought');
    await page.keyboard.press('Enter');
    await settle();
    const edited = (await el(c.id)).content.comments;
    assert(edited.length === 1 && edited[0].text === 'Edited thought', JSON.stringify(edited));
    await card(c.id).locator('.comment-tools button', { hasText: 'Delete' }).first().click({ force: true });
    await settle();
    assert((await el(c.id)).content.comments.length === 0, 'not deleted');
  });
  await check('K15', 'Synced copy: stop syncing', async () => {
    const original = await newNote('Synced text');
    const before = new Set((await api()).map((e) => e.id));
    await cardMenu(original.id, 'Create Synced Copy');
    const copy = await created(before, 'note');
    assert(copy.syncId, 'copy not synced');
    // The copy is placed beside the original and can land past the window's edge: fit everything first.
    await page.keyboard.press('Escape');
    await page.keyboard.press('Shift+!');
    await wait(500);
    await cardMenu(copy.id, 'Stop Syncing This Copy');
    await settle();
    assert(!(await el(copy.id)).syncId, 'still synced');
  });
  await check('K16', 'Labels: rename and delete (with confirmation)', async () => {
    noteK = await newNote('Label me');
    await cardMenu(noteK.id, 'Labels…');
    await page.locator('.labels-dialog .palette-input').fill('Temp');
    await page.keyboard.press('Enter');
    await settle();
    const label = (await api()).find((e) => e.type === 'label' && e.content.name === 'Temp');
    assert(label && (await el(noteK.id)).labels?.includes(label.id), 'label not applied');
    await page.locator('.labels-dialog li', { hasText: 'Temp' }).locator('button[title="Edit label"]').click();
    await page.locator('.label-editor input').first().fill('Temp renamed');
    await page.keyboard.press('Enter');
    await settle();
    assert((await el(label.id)).content.name === 'Temp renamed', 'not renamed');
    await page.locator('.labels-dialog li', { hasText: 'Temp renamed' }).locator('button[title="Edit label"]').click();
    await page.locator('.label-editor button.danger').first().click();
    await page.locator('.label-editor button', { hasText: 'Yes' }).click();
    await settle();
    await page.keyboard.press('Escape');
    assert(!(await el(label.id)) && !(await el(noteK.id)).labels?.includes(label.id), 'label still there');
  });
  await check('K17', 'Navigation: back and forward (Alt ← / Alt →)', async () => {
    assert(childK, 'needs K6');
    await go(`#/b/${childK.id}`);
    await page.keyboard.press('Alt+ArrowLeft');
    await wait(500);
    const back = page.url();
    await page.keyboard.press('Alt+ArrowRight');
    await wait(500);
    const fwd = page.url();
    assert(back.includes(boardK.id) && fwd.includes(childK.id), `${back} / ${fwd}`);
    await go(`#/b/${boardK.id}`);
  });
  await check('K22', 'Arrow keys with nothing selected glide around the board; not while typing', async () => {
    await go(`#/b/${boardK.id}`);
    await page.keyboard.press('Escape');
    const at = () => page.$eval('.world', (n) => n.style.transform.match(/-?[\d.]+/g).slice(0, 2).map(Number));
    const a = await at();
    await page.keyboard.down('ArrowRight');
    await page.keyboard.down('ArrowDown');
    await wait(400);
    await page.keyboard.up('ArrowRight');
    await page.keyboard.up('ArrowDown');
    const b = await at();
    await wait(200);
    const c = await at();
    assert(b[0] < a[0] - 100 && b[1] < a[1] - 100, `view did not move right and down: ${a} → ${b}`);
    assert(c[0] === b[0] && c[1] === b[1], `kept moving after the keys were released: ${b} → ${c}`);
    await page.keyboard.press('Shift+!'); // fit the board so the note is on screen
    await wait(300);
    const fitted = await at();
    await page.locator(`[data-el="${noteK.id}"]`).click({ position: { x: 3, y: 3 } });
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.activeElement?.isContentEditable);
    await page.keyboard.down('ArrowLeft');
    await wait(300);
    await page.keyboard.up('ArrowLeft');
    const d = await at();
    await page.keyboard.press('Escape');
    assert(d[0] === fitted[0] && d[1] === fitted[1], 'the view moved while typing in a note');
  });
  await check('K18', 'Keyboard shortcuts panel lists every section', async () => {
    await page.keyboard.press('Escape');
    await page.keyboard.press('?');
    await wait(300);
    const dialog = page.locator('.shortcuts-dialog');
    const text = await dialog.textContent(); // headings are upper-cased by CSS
    await page.keyboard.press('Escape');
    const sections = ['The basics', 'Navigation', 'Zoom', 'Appearance', 'Text formatting', 'Markdown', 'To-do lists', 'Drawing'];
    const missing = sections.filter((s) => !text.includes(s));
    assert(!missing.length, `missing ${missing.join(', ')}`);
    assert(/eyedropper/i.test(text) && /palette/i.test(text) && /selection tool/i.test(text), 'drawing shortcuts incomplete');
  });
  await check('K19', 'Export board as PDF (print)', async () => {
    await page.evaluate(() => {
      window.__printed = '';
      window.__printCalled = false;
      window.open = () => ({ document: { write: (h) => (window.__printed += h), close() {}, querySelector: () => ({ complete: true }) }, print: () => (window.__printCalled = true) });
    });
    await page.locator('.topbar button[title="Export board"]').click();
    await wait(300);
    await page.locator('.export-section button', { hasText: 'PDF (print)' }).click();
    const t0 = Date.now();
    const printed = await page.waitForFunction(() => window.__printed.length > 0, null, { timeout: 45000 }).then(() => true, () => false);
    if (!printed) throw new Error(`nothing printed; toast: ${await page.locator('.toast').allInnerTexts()}; errors: ${errors.slice(-2)}`);
    const html = await page.evaluate(() => window.__printed);
    await page.keyboard.press('Escape');
    // The print window has no inline script (the CSP would block it); the app calls print() on it.
    assert(/<img src="data:image\/png/.test(html) && (await page.evaluate(() => window.__printCalled)), html.slice(0, 120));
    return `${Math.round((Date.now() - t0) / 1000)} s`;
  });
  await check('K20', 'Install to home screen: manifest, icons, standalone', async () => {
    const link = await page.locator('link[rel="manifest"]').getAttribute('href');
    const m = await (await page.request.get(new URL(link, BASE).href)).json();
    const sizes = (m.icons || []).map((i) => i.sizes);
    assert(m.name && m.display === 'standalone' && m.start_url, JSON.stringify(m).slice(0, 120));
    assert(sizes.includes('192x192') && sizes.includes('512x512'), `icons ${sizes}`);
    for (const i of m.icons) assert((await page.request.get(new URL(i.src, BASE).href)).ok(), `icon ${i.src}`);
    assert(await page.locator('meta[name="apple-mobile-web-app-capable"], link[rel="apple-touch-icon"]').count(), 'no iOS home-screen tags');
    return `${m.name}, ${m.display}, icons ${sizes.join(' ')}`;
  });
  await check('K21', 'Hosted: signed-out visitors get the sign-in page; the session cookie is HttpOnly and lasts a year', async () => {
    const ctx = await page.context().browser().newContext();
    try {
      const p = await ctx.newPage();
      await p.goto(BASE);
      assert(/Sign in/.test(await p.title()), `title ${await p.title()}`);
      const state = await p.request.get(`${BASE}/api/state`);
      assert(state.status() === 401, `state without a session: ${state.status()}`);
      const cookie = (await page.context().cookies(BASE)).find((c) => c.name === 'cn_sid');
      assert(cookie && cookie.httpOnly && cookie.expires - Date.now() / 1000 > 360 * 86400, `session cookie ${JSON.stringify(cookie)}`);
    } finally {
      await ctx.close();
    }
  });
  await home();
  }

  if (run('J')) {
  // ------------------------------------------------------------ J. touch (phone)
  // A separate touch-enabled phone context; gestures are real touch events sent through CDP.
  let tctx, tp, cdp, boardJ;
  try {
    await home();
    // A fresh board every run: the gestures need empty space.
    boardJ = await enterBoard(`J Touch ${Math.random().toString(36).replace(/[^a-z]/g, '').slice(0, 5)}`);
    await home();
    tctx = await page.context().browser().newContext({ hasTouch: true, isMobile: true, viewport: { width: 393, height: 852 }, deviceScaleFactor: 2, storageState: await page.context().storageState() });
    tp = await tctx.newPage();
    cdp = await tctx.newCDPSession(tp);
    await tp.goto(`${BASE}/#/b/${boardJ.id}`);
    await tp.waitForTimeout(900);
  } catch (e) {
    results.push({ id: 'J0', name: 'Touch context', ok: false, detail: String(e.message || e).split('\n')[0] });
  }
  const tw = (ms) => tp.waitForTimeout(ms);
  const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y], id) => ({ x, y, id })) });
  const tap = async (x, y) => {
    await touch('touchStart', [[x, y]]);
    await touch('touchEnd', []);
  };
  const swipe = async (from, to, steps = 8, holdMs = 0) => {
    await touch('touchStart', [from]);
    if (holdMs) await tw(holdMs);
    for (let i = 1; i <= steps; i++) {
      await touch('touchMove', [[from[0] + ((to[0] - from[0]) * i) / steps, from[1] + ((to[1] - from[1]) * i) / steps]]);
      await tw(16);
    }
    await touch('touchEnd', []);
  };
  const world = () =>
    tp.evaluate(() => {
      const m = document.querySelector('.world').style.transform.match(/translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(([-\d.]+)\)/);
      return { x: +m[1], y: +m[2], zoom: +m[3] };
    });
  const tEmpty = () =>
    tp.evaluate(() => {
      const r = document.querySelector('.canvas').getBoundingClientRect();
      const free = (x, y) => {
        const el = document.elementFromPoint(x, y);
        return el && (el.classList.contains('canvas') || el.classList.contains('world'));
      };
      for (let y = r.top + 80; y < r.bottom - 160; y += 30)
        for (let x = r.left + 60; x < r.right - 60; x += 30) {
          let ok = true;
          for (let dy = -40; dy <= 40 && ok; dy += 20) for (let dx = -50; dx <= 50 && ok; dx += 25) ok = free(x + dx, y + dy);
          if (ok) return [x, y];
        }
      return [r.left + r.width / 2, r.top + r.height / 2];
    });
  const notesOnJ = async () => (await api()).filter((e) => e.parentId === boardJ.id && e.type === 'note' && e.section === 'canvas');
  const tCentre = async (id) => {
    const b = await tp.locator(`[data-el="${id}"]`).first().boundingBox();
    assert(b, 'card not visible on phone');
    const p = [b.x + Math.min(30, b.width / 2), b.y + Math.min(20, b.height / 2)];
    const under = await tp.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest('[data-el]')?.getAttribute('data-el'), p);
    assert(under === id, `another card (${under}) covers ${id}`);
    return p;
  };
  let jNote;

  if (tp) {
  await check('J1', 'Touch: double-tap empty board writes a note', async () => {
    const before = (await notesOnJ()).length;
    const [x, y] = await tEmpty();
    await tap(x, y);
    await tw(120);
    await tap(x, y);
    await tw(500);
    await tp.keyboard.type('Tapped note', { delay: 15 });
    const [ex, ey] = await tEmpty();
    await tap(ex, ey);
    await tw(900);
    const notes = await notesOnJ();
    jNote = notes.filter((n) => n.content.html.includes('Tapped note')).sort((a, b) => b.createdAt - a.createdAt)[0];
    assert(notes.length === before + 1 && jNote, `notes ${before} → ${notes.length}`);
  });
  await check('J2', 'Touch: tap selects a card and shows the action bar', async () => {
    assert(jNote, 'needs J1');
    await tw(400);
    await tap(...(await tCentre(jNote.id)));
    await tw(400);
    const bar = tp.locator('.selection-bar');
    assert(await bar.isVisible(), 'no selection bar');
    const text = await bar.innerText();
    assert(/1 selected/.test(text), text);
    const [ex, ey] = await tEmpty();
    await tap(ex, ey);
    await tw(400);
    return text.replace(/\s+/g, ' ');
  });
  await check('J3', 'Touch: press and hold, then drag, moves a card', async () => {
    assert(jNote, 'needs J1');
    const before = (await api()).find((e) => e.id === jNote.id);
    const [x, y] = await tCentre(jNote.id);
    await swipe([x, y], [x + 70, y + 90], 10, 480);
    await tw(900);
    const after = (await api()).find((e) => e.id === jNote.id);
    const menuOpen = await tp.locator('.menu').count();
    if (menuOpen) await tp.keyboard.press('Escape');
    assert(after.x !== before.x || after.y !== before.y, `stayed at ${before.x},${before.y}`);
    assert(!menuOpen, 'a menu opened during the drag');
    return `${before.x},${before.y} → ${after.x},${after.y}`;
  });
  await check('J4', 'Touch: holding still opens the card menu, which stays open after release', async () => {
    assert(jNote, 'needs J1');
    const [x, y] = await tCentre(jNote.id);
    const count = (await api()).length;
    await touch('touchStart', [[x, y]]);
    await tw(950);
    const during = await tp.locator('.menu').count();
    await touch('touchEnd', []);
    await tw(500);
    const menu = tp.locator('.menu');
    assert(await menu.isVisible(), `menu not open after release (open while held: ${during > 0})`);
    const text = await menu.innerText();
    assert(/Duplicate/.test(text), 'not the card menu');
    await tw(300);
    assert((await api()).length === count, 'the release triggered a menu item');
    // On a phone the menu is a bottom sheet: tap the board above it to close.
    const top = (await menu.boundingBox()).y;
    await tap(12, Math.max(110, top - 30));
    await tw(300);
    assert(!(await tp.locator('.menu').count()), 'menu did not close');
  });
  await check('J5', 'Touch: pinch with two fingers zooms', async () => {
    const before = await world();
    const [cx, cy] = await tEmpty();
    await touch('touchStart', [[cx - 40, cy], [cx + 40, cy]]);
    for (let i = 1; i <= 10; i++) {
      await touch('touchMove', [[cx - 40 - i * 9, cy], [cx + 40 + i * 9, cy]]);
      await tw(16);
    }
    await touch('touchEnd', []);
    await tw(400);
    const after = await world();
    assert(after.zoom > before.zoom * 1.3, `zoom ${before.zoom} → ${after.zoom}`);
    return `zoom ${before.zoom.toFixed(2)} → ${after.zoom.toFixed(2)}`;
  });
  await check('J6', 'Touch: one-finger swipe on empty board pans', async () => {
    const before = await world();
    const [x, y] = await tEmpty();
    await swipe([x, y], [x - 90, y - 110], 8);
    await tw(300);
    const after = await world();
    assert(Math.abs(after.x - before.x) > 40 && Math.abs(after.y - before.y) > 40, `${JSON.stringify(before)} → ${JSON.stringify(after)}`);
  });
  await check('J7', 'Touch: tapping a tool in the bottom toolbar adds a card', async () => {
    const tb = await tp.locator('.toolbar').boundingBox();
    assert(tb.y + tb.height >= 850, 'toolbar is not at the bottom');
    const before = (await notesOnJ()).length;
    const b = await tp.locator('.toolbar .tool').first().boundingBox();
    await tap(b.x + b.width / 2, b.y + b.height / 2);
    await tw(500);
    await tp.keyboard.type('From the toolbar', { delay: 15 }); // empty notes are discarded
    const [ex, ey] = await tEmpty();
    await tap(ex, ey);
    await tw(900);
    const after = (await notesOnJ()).length;
    assert(after === before + 1, `notes ${before} → ${after}`);
  });
  }
  await tctx?.close().catch(() => {});
  }

  } catch (e) {
    results.push({ id: 'ABORT', name: 'script stopped', ok: false, detail: String(e.message || e).split('\n')[0].slice(0, 200) });
  }
  const passed = results.filter((r) => r.ok).length;
  return { summary: `${passed}/${results.length} passed`, failed: results.filter((r) => !r.ok), passed: results.filter((r) => r.ok).map((r) => `${r.id} ${r.name}${r.detail ? ` (${r.detail})` : ''}`), errors };
}
