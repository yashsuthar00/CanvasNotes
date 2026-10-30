# Canvas Notes

A self-hosted visual notes app in the style of Milanote. Put notes,
headings, to-do lists, tables, sketches, documents, images, files, links,
videos, maps and colour swatches anywhere on an endless board. Group them in
columns, connect them with arrows, label them, and put boards inside boards.
It works on a laptop, an iPad and a phone.

Everyone who uses it signs up with an email and password and gets their own
boards; nobody can see anyone else's. Data stays on your server: notes are kept
in a SQLite file and uploads in a folder, both under `data/`.

`docs/feature-parity.md` compares every Milanote feature (taken from its UI
strings with REA) against what's built here. `docs/rea-findings.md` explains how
the data model was studied.

## Run it locally

Needs Node.js 22.13 or newer (it uses the built-in `node:sqlite`). The repo's
`.nvmrc` pins Node 24.

```bash
npm install
npm run build
npm start            # http://127.0.0.1:5180
```

For development with hot reload: `npm run dev` (same port; Vite runs inside the server).

`npm start` and `npm run dev` read a `.env` file in the project folder if there is
one (it's git-ignored). To open it from your phone or iPad on the same Wi-Fi:

```bash
printf 'HOST=0.0.0.0\nCANVASNOTES_SIGNUPS=closed\n' > .env
npm start            # prints the http://<ip>:5180 addresses to open
```

The first visit shows the sign-in page: choose **Create account**. With
`CANVASNOTES_SIGNUPS=closed` that first account is still allowed (it's yours),
and nobody else on the network can make one.

| Variable | Default | What it does |
| --- | --- | --- |
| `PORT` | `5180` | Port to listen on |
| `HOST` | `127.0.0.1` | `0.0.0.0` to accept connections from other devices |
| `DATA_DIR` | `./data` | Where the database and uploads live |
| `CANVASNOTES_SIGNUPS` | `open` | `closed` stops new accounts (the very first one is always allowed) |
| `CANVASNOTES_INVITE_CODE` | unset | If set, new accounts need this code (except the first) |
| `CANVASNOTES_QUOTA_MB` | `1024` | Upload space per account |
| `CANVASNOTES_DATA_MB` | `200` | Space for cards (notes, boards…) per account |
| `CANVASNOTES_FILE_GRACE_MIN` | `30` | Minutes an upload no card uses any more is kept before it's deleted |
| `CANVASNOTES_TRUST_PROXY` | unset | `1` behind a reverse proxy (Caddy, nginx), so rate limits see the real client IP |
| `ANTHROPIC_API_KEY` | unset | Optional. Turns on **AI Ideas** (brainstorm cards with Claude) |

The interface language (English, Español, Français, Português, Deutsch,
Italiano, Nederlands, Polski, Русский, 日本語, 中文, 한국어), number and date
formats, the default currency and 12/24-hour time are set per device in
**Settings → Localization**.

## Host it (for phone, iPad and laptop)

1. **Run it on a server** (a VPS, a home server or a Raspberry Pi):

   ```bash
   echo 'CANVASNOTES_SIGNUPS=open' > .env   # or closed / an invite code, see above
   mkdir -p data                 # must be writable by uid 1000 (the container's user)
   docker compose up -d          # data is kept in ./data
   ```

   The container only listens on `127.0.0.1:5180`, for the HTTPS proxy in step 2.
   Without Docker: `CANVASNOTES_TRUST_PROXY=1 npm start` behind the same proxy,
   kept running with systemd or pm2.

2. **Put HTTPS in front of it.** The session cookie is marked `Secure` behind
   HTTPS. Never type the password over plain HTTP on the internet. With
   [Caddy](https://caddyserver.com), which gets certificates automatically:

   ```
   notes.example.com {
       reverse_proxy 127.0.0.1:5180
   }
   ```

   Serve it at the root of a domain or subdomain, not under a sub-path. For
   private access without a public domain, Tailscale works too: it gives you
   HTTPS on your own devices.

3. **On iPhone or iPad**, open the site in Safari, then Share → *Add to Home
   Screen*. It opens full screen like an app and stays signed in for a year.
   On Android, use Chrome → *Install app*.

### Accounts

- Passwords are hashed with scrypt. Signing in sets an HttpOnly, SameSite cookie
  that lasts a year; the server keeps only a hash of it, and signing out ends it
  on the server too.
- **⋯ → Account** changes your name or password (other devices are signed out)
  or deletes the account with everything in it.
- Ten wrong passwords in 15 minutes block that email, and that IP, for a while.
- Each account's uploads are private: a file loads only for its owner, or for
  anyone when it's on a published board. Uploaded HTML, SVG and other active
  files download inside a sandbox instead of opening as the site.
- Note content is cleaned before it's shown, and a Content-Security-Policy only
  lets the app run its own scripts. Requests that change data must come from
  the app's own pages. Link previews can't reach private network addresses.
- Deleting really deletes: once no card of the account uses an uploaded file
  any more (cards in the Trash still count as using it), the file is deleted
  after `CANVASNOTES_FILE_GRACE_MIN` minutes, so Undo right after a delete still
  works. The space comes back to the account, and the file leaves the disk once
  no other account uploaded the same file. **⋯ → Account** shows the space used.
- Limits: 5 MB per card, `CANVASNOTES_DATA_MB` (200) of cards per account,
  `CANVASNOTES_QUOTA_MB` (1024) of uploads per account.
- There's no email service, so a forgotten password is reset on the server:
  `node server/admin.mjs reset-password <email> <new password>`
  (`node server/admin.mjs list` shows the accounts). Use the same `DATA_DIR`.
- Upgrading from a version without accounts: the database is backed up to
  `data/canvasnotes-before-accounts-<time>.db`, and the first account created
  gets all the existing boards and files. `CANVASNOTES_PASSWORD` is no longer used.

Back up by copying `data/`, or use **⋯ → Export backup** for one JSON file.
**Import backup** can merge that file in or replace everything.

## Using it

**Laptop.** Double-click the board for a note. Drag tools in from the left, or
click one to drop it in the middle of the view. Scroll or hold space and drag to
move around. Ctrl + scroll zooms. Drag on empty space to select several cards.
Right-click anything for its menu. `?` lists every shortcut.

**iPad and phone.**
- Double-tap the board to write a note.
- Tap a tool (along the bottom on a phone) to add it.
- Pinch to zoom. Drag with one finger to move around.
- Press and hold a card, then drag, to move it. Hold it still to open its menu.
- Press and hold empty space, then drag, to select several cards.
- Selected cards get an action bar: Edit, Duplicate, More, Delete.

**Cards.**
- Notes support Markdown shortcuts (`# `, `## `, `* `, `1. `, `[] `, `> `,
  `! ` for a callout, ```` ``` ````, `---`), text colours, highlights,
  alignment, and links to other boards.
- To-do lists have indent levels (Tab) and due dates.
- Tables calculate formulas like `=SUM(B2:B9)` and `=IF(C2>10,"big","small")`.
- Paste or drop links, images and files straight onto the board. YouTube,
  Vimeo, Spotify, SoundCloud and Google Maps links become players and maps.

**Organising.**
- **Move around** with the arrow keys when nothing is selected (Shift goes faster); with cards selected they nudge the cards instead.
- **Lost in empty space?** Arrows on the board's edges point to every group of cards off screen; click or tap one to fly there. Groups that lie in nearly the same direction share an arrow (with a count) until you get closer. **N** jumps to the next group of cards, **Shift N** to the previous one.
- **Unsorted** (`U`) is a holding area for each board.
- **Templates**: right-click a board → *Convert to Template*.
- **Labels**: right-click → *Labels…*, then filter search by label.
- **Export**: the download icon → PNG, PDF, Markdown, Word, or a ZIP of all
  files.
- **Presentation mode**: Ctrl Shift P, then the arrow keys.
- **Quick notes**: the inbox icon in the top bar. One holding area shared by every board, handy from your phone.
- **Private boards**: right-click a board → *Password Protect…*. Its contents stay on the server until you unlock it.
- **Share read-only**: right-click a board → *Publish Read-only Link*. Anyone with the link can view it without signing in. *Unpublish* turns it off.
- **Synced copies**: right-click a card → *Create Synced Copy*. Editing one updates the others.

## Checking it

`npm run test:parity` drives the real app in headless Chrome and checks every
feature in `docs/feature-parity.md` (104 checks, about 4 minutes), including touch
gestures in a phone-sized touch context. It signs up a fresh account first. Start
a server with an empty `DATA_DIR` first, for example `DATA_DIR=/tmp/cn-test npm start`.

`npm run test:accounts` checks sign-up, sign-in, sessions, account settings and
that accounts can't see or change each other's data (28 checks, about 40 seconds).

`npm run test:security` tries the attacks one account or a stranger could make:
script hidden in notes, uploaded pages, `javascript:` links, cross-site requests,
framing, path traversal, injection, oversized requests, server-side requests to
private addresses, session tricks, and checks the headers and `npm audit`
(21 checks, about a minute).

`npm run test:responsive` measures the sign-in, account and public-board screens
at 16 phone, tablet and desktop sizes: nothing scrolls sideways or is cut off,
dialogs can be scrolled to their last button, touch targets are at least 40px
(7 checks, about a minute).

`npm run test:areas` checks the edge arrows that lead back to content and the
N / Shift N jumps: arrows hide on content, merge from far away and split up
close, fly to their cards on click or tap (also at phone size), and panning
stays at 60 frames a second (7 checks, about 15 seconds).

These four start their own servers (ports 5192–5213), so nothing needs to be
running. With `EVIDENCE_DIR=<folder>` they also keep screenshots and a JSON
report there.

Both need Node 22.13 or newer, like the server, and use the system Chrome; set
`CHROME_PATH` if yours is elsewhere, and `CANVASNOTES_URL` for another address.

## How it's built

- `server/` is a dependency-free Node server: a JSON API over `node:sqlite`,
  uploads, link previews (`/api/unfurl`), a ZIP of a board's files, and
  accounts and sessions (`accounts.mjs`, sign-in page in `authPage.mjs`). Every
  query is scoped to the signed-in account (`store.mjs`). It also serves the
  built client.
- `src/` is React and TypeScript, built with Vite. TipTap is the rich-text
  editor.
  - `store.ts` holds element state, undo/redo, and debounced autosave.
  - `viewport.ts` holds per-board pan and zoom, plus the measured card rects.
  - `components/Canvas.tsx` handles every mouse and touch gesture.
  - `elements/` renders each card type. `formula.ts` is the table formula
    engine. `exporters.ts` handles board exports.
