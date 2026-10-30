# Feature parity with Milanote (checked with REA)

This is the check of whether Canvas Notes covers what Milanote does. The
feature list wasn't written from memory. It comes from Milanote's own web
client, captured with REA:

1. `rea inspect-web-page --include-script-sources` on `app.milanote.com`, then
   `rea export-web-scripts`, saved the bundles: `main`, `workspace`, and
   `locales-en`, which holds every UI string.
2. The English locale bundle was split into its namespaces: `toolbar`,
   `elements`, `popup`, `canvas`, `modal.shortcuts`, `appHeader`, `settings` and
   others. Every tool, element type, menu item, popup, shortcut and export
   option has a string there, so the list below is complete as far as the UI
   goes.
3. Each entry was then built and tested in a browser (desktop, simulated
   iPhone and iPad with real touch events), or marked as not built, with the
   reason.
4. The rows are re-checked automatically by `tests/parity.e2e.js`
   (`npm run test:parity` against a server with an empty `DATA_DIR`). It drives
   the real UI in headless Chrome and verifies what the server stored: 104
   checks in sections A–K, last run 104/104 on 2026-10-30. Section J runs in a
   touch-enabled phone context and sends real touch events (double-tap,
   tap-select, hold-drag, hold-menu, pinch, swipe-pan, toolbar tap). Section K
   covers the remaining rows, including the hosted sign-in, which the runner
   tests on a second, password-protected server. The **Checks** column names
   the checks behind each row.

✅ built and tested · ◐ partly built · ✗ not built · — doesn't apply to a
single-user, self-hosted app

## Elements (`toolbar.tools.elements`, `elements.elementTypes`)

| Milanote | Status | Notes | Checks |
|---|---|---|---|
| Note (`card`) | ✅ | Rich text, Markdown shortcuts, colours | A1, D1–D5 |
| Heading | ✅ | Three sizes | A2 |
| Link | ✅ | Server-side preview: title, description, image. Replace or refresh the preview | A3, K11 |
| Video | ✅ | YouTube, Vimeo, Loom embeds. Uploaded video files play inline | A4, C4 |
| Audio | ✅ | Spotify and SoundCloud embeds. Uploaded audio plays inline | A5 |
| Map | ✅ | Google Maps and OpenStreetMap links embed | A6 |
| To-do (`taskList`, `task`) | ✅ | Title, progress, indent levels, due dates (overdue / today), delete completed | A7, K13 |
| Line | ✅ | Attaches to cards, label, arrowheads, dashed, weight, colour | B5, B6 |
| Board | ✅ | Nested boards, icon (emoji, letters, uploaded image), colour, description | A8, B8, B9, K6 |
| Shortcut (`alias`) | ✅ | Find original, duplicate the shortcut or the board it links to | A9, K7 |
| Column | ✅ | Drag in and out, ordering, collapse, colour | A10, B12 |
| Comment (`commentThread`) | ✅ | Thread card with replies, edit, delete (single user, no mentions) | A11, K14 |
| Table | ✅ | Formulas, cell types, alignment, colour, row/column operations | A12, E1–E3, K2, K3 |
| Spreadsheet | ✅ | Table card; dropping a CSV/TSV file imports it as a table | A13 |
| Image | ✅ | Upload, paste, drop, caption, replace, download original | A14, C1, K9 |
| File / Upload | ✅ | Any file. PDF preview, download, copy link | A15, K10 |
| Sketch | ✅ | Pen, eraser, 8 colours plus custom, 4 weights, undo/redo, save/discard | A16, C5, K12 |
| Annotation (draw on image) | ✅ | "Draw On" any image | A17 |
| Document | ✅ | Full-screen editor, word count, export to Markdown, text, Word, PDF | A18, C6 |
| Colour swatch | ✅ | Picker, name, hex | A19 |
| Synced copy (`clone`) | ✅ | Editing one copy updates the others; badge shows the count; stop syncing | A20, K15 |
| Folder | ✅ | A collapsible folder-style column (its exact Milanote behaviour couldn't be confirmed from the bundle) | A21 |
| Image/File placeholder | ✅ | Empty slot you drop or pick a file into | A22 |

## Selected-card tools (`toolbar.tools.selected`)

| Milanote | Status | Notes | Checks |
|---|---|---|---|
| Colour (card colour, background) | ✅ | 8 colours, default, custom colour picker | B1, K5 |
| Colour mode: top strip vs background (`popup.color.modeSwitcher`) | ✅ | Switchable per card | B2 |
| Caption / description | ✅ | Boards, shortcuts, links, files, swatches, sketches, tables, documents | B8 |
| Labels | ✅ | Create, colour, rename, delete with confirmation, usage count, filter in search | B4, F7, K16 |
| Connect | ✅ | "Connect with Lines" plus the line tool | B5 |
| Alignment, Distribute | ✅ | Left/centre/right/top/middle/bottom, distribute across or down | B7 |
| Collapse | ✅ | Columns | A10 |
| Draw on, Edit drawing | ✅ | | A17, K12 |
| Icon | ✅ | | B9 |
| Rename, Title | ✅ | | K6 |
| Preview, Media, Link info | ✅ | | A3, A4, K11 |
| File info | ✅ | Panel with name, type, size, dimensions, dates | C3 |
| Edit image (crop) | ✅ | Crop editor with handles; crop to fit the dot grid | C1, C2 |
| Transparent | ✅ | Card colour option | B3 |
| Autoplay, Loop, Start, End (video) | ✅ | For YouTube/Vimeo embeds and uploaded media | C4 |
| Reactions | ✅ | Emoji reactions on cards (single user) | B10 |

## Text editing (`toolbar.tools.editing`, `toolbar.textStyles`, `popup.textStyle`)

| Milanote | Status | Checks |
|---|---|---|
| Bold, italic, underline, strikethrough, inline code | ✅ | D1 |
| Hyperlink, link to board, divider line, emoji | ✅ | K1, D4, D2, D5 |
| Bullet list, numbered list, checkbox, indent, un-indent | ✅ | D2, D3 |
| Align left/centre/right | ✅ | D3 |
| Text colour, highlight colours | ✅ | D3 |
| Styles: normal, large heading, heading, small heading, small text, quote, callout, code block | ✅ | D2, K1 |
| Clear formatting | ✅ | D5 |
| Markdown shortcuts `#` `##` `*` `1.` `[]` `>` `!` ` ``` ` `---` | ✅ | A1, D2 |
| Font, font size | ✅ Font and size picker (Aa) in the note toolbar | D3 |
| Paragraph text indent | ✅ Indent / un-indent buttons and Tab work on paragraphs and headings, not just lists | D3 |
| Mentions, assign to user | — | — |

## Tables (`popup.table`, `canvas.contextMenuItems.table`)

| Milanote | Status | Notes | Checks |
|---|---|---|---|
| Add row/column above/below/left/right, delete, move | ✅ | | E1, K3 |
| Cell types: auto, text, number, currency, percentage, checkbox, date & time | ✅ | | E2 |
| Formulas with circular-reference, divide-by-zero and parse errors | ✅ | SUM, AVERAGE, MIN, MAX, COUNT, COUNTA, ROUND, ABS, SQRT, POWER, IF, AND, OR, NOT, CONCAT, LEN, UPPER, LOWER, TODAY, operators, ranges | A12, K2 |
| Alignment, cell colour, bold, header row, clear cell | ✅ | | K2, K3, E3 |
| Number format options (decimals, chosen currency, date format) | ✅ | Decimals, currency, date format, thousands separator | E2, H3 |
| Multi-cell selection, paste values | ✅ | Shift-select ranges, copy/cut/clear blocks, paste from spreadsheets, paste values | E3, K3 |

## Board menu (`canvas.contextMenuItems.canvas`)

| Milanote | Status | Checks |
|---|---|---|
| New note / to-do / column / board / table / comment / link / line | ✅ (plus heading, document, sketch, colour, video, audio, map) | A section |
| Paste, undo, redo, select all | ✅ | B15, K4 |
| Change board background, custom colour, revert to default, show dot grid | ✅ | F1, K4 |
| New folder, new image/file placeholder | ✅ | A21, A22 |
| New public template | — (Milanote staff tool) | — |

## Card menu (`canvas.contextMenuItems.element`)

| Milanote | Status | Checks |
|---|---|---|
| Copy, cut, paste, duplicate, move to trash | ✅ | B15, F6 |
| Bring to front, send to back | ✅ | B16 |
| Lock / unlock position | ✅ | B11 |
| Group into column, connect with lines | ✅ | B12, B5 |
| Convert to note / document / board / heading / to-do | ✅ | B13 |
| Copy a link to this board, open in new tab, create a shortcut, duplicate the board it links to, find original board | ✅ | K6, A9, K7 |
| Copy link address, copy link to file, open file, download, download original image, replace image, replace preview | ✅ | K9, K10, K11, A15 |
| Paste styles (and copy style) | ✅ | B14 |
| Rename, choose custom colour, add image (via image tool) | ✅ | K6, K5, A14 |
| Convert to template, revert template to board | ✅ | F5, K8 |
| Created / modified time | ✅ | B17 |
| Convert to sketch card | ✅ | C7 |
| Create synced copy | ✅ | A20 |
| Crop image to fit dot grid, download SVG | ✅ | C2, C5 |

## Boards, navigation and organising

| Milanote | Status | Notes | Checks |
|---|---|---|---|
| Breadcrumbs, go to parent, back/forward, drag cards onto a breadcrumb to move them up | ✅ | | A8, F2, K17 |
| Move around the board with the arrow keys | ✅ | Beyond Milanote: glides while held, diagonals, Shift for faster; with cards selected the arrows nudge them | K22 |
| Edge arrows to off-screen content, N / Shift N to jump between groups of cards | ✅ | Beyond Milanote: arrows only over empty space, merge by direction from afar, click/tap flies there | `npm run test:areas` A1–A7 |
| Select / Move switch (cursor or hand; V / H) | ✅ | Beyond Milanote: Move mode only pans, even on cards; nothing can change | `npm run test:move` M1–M8 |
| Unsorted (`canvas.inbox`) | ✅ | Per-board panel, quick add, drag out to the board, `U` to send cards there | F3 |
| Quick notes (from your phone) | ✅ | A Quick notes panel shared by every board, reachable from any device (no separate native app) | F4 |
| Templates: choose, keep example content, your custom templates, convert / revert | ✅ | No public template gallery | F5, K8 |
| Trash: restore, delete, empty trash with confirmation | ✅ | | F6 |
| Search (`appHeader.tools.boardSearch`): matches, sort by relevance / last modified / last viewed, labels, recently viewed | ✅ | "Shared with" filter doesn't apply | F7 |
| Presentation mode | ✅ | Full screen, steps through cards, opens boards | F8 |
| Board password protection | ✅ | Per-board passwords (hashed on the server; contents withheld until unlocked), on top of the app sign-in | F9 |

## Export (`appHeader.tools.export`)

| Milanote | Status | Checks |
|---|---|---|
| Current board layout as PNG | ✅ | G2 |
| As PDF | ✅ (through the browser's print dialog) | K19 |
| Linear document: Markdown, plain text, Word, include sub-boards | ✅ | G1 |
| Download all images and files as a ZIP | ✅ (includes sub-boards, one folder per board) | G3 |
| Export a single element | ✅ (notes, documents, tables, sketches) | C6 |
| Whole-account backup | ✅ (JSON export/import, not in Milanote) | G4 |

## Shortcuts (`modal.shortcuts`)

Every section is covered: the basics, navigation, zoom, appearance (dark mode,
larger/smaller interface), text formatting, Markdown, to-do lists and drawing.
The drawing tools are all there too: the colour eyedropper (I, picks a stroke's
colour or an image pixel), the selection tool (V, box-select strokes, drag to
move, Delete), and the colour-palette toggle (C). Checked by K18 (the panel lists every
section) and K12 (the drawing tools themselves).

## Settings (`settings.*`)

| Milanote | Status | Checks |
|---|---|---|
| Appearance (light / dark / system), interface size | ✅ | H1 |
| Toolbar options (choose tools) | ✅ | H2 |
| Localization: numbers & dates format, currency, 12/24-hour time | ✅ Settings → Localization; tables, due dates and timestamps follow it | H3 |
| Localization: interface language | ✅ All eleven languages in Milanote's bundle: English, Español, Français, Português, and the German, Chinese, Russian, Polish, Japanese, Dutch, Italian and Korean it keeps behind experiment flags. Every interface string is translated (596 per language) | H4 |
| Notifications, privacy, account, billing | — | — |

## Devices

| Need | Status | Checks |
|---|---|---|
| Laptop: mouse, trackpad, keyboard | ✅ | A–K (desktop Chrome) |
| iPad: touch, pinch zoom, long-press drag, long-press menu, side toolbar | ✅ | I2, I3, J3–J6 |
| Phone: bottom toolbar, sheet menus, full-screen editors, action bar for selected cards | ✅ | I1, J1, J2, J4, J7 |
| Install to home screen (manifest, icons, standalone) | ✅ | K20 |
| Hosted: password login with a one-year signed cookie, rate-limited, HTTPS-aware, Docker | ✅ | K21 |

## Out of scope (multi-user or Milanote's services)

Sharing with other people, team and billing, notifications, mentions,
assignments, real-time collaboration, sign-up and onboarding, the native
desktop and mobile apps, and the admin tools.

Added beyond the first pass, though Milanote has them: **read-only public
links** for a board (contents of password-locked boards stay hidden), **image
search** (Wikimedia Commons, no key needed), and **AI Ideas** (brainstorm cards
with Claude; needs `ANTHROPIC_API_KEY` on the server).
