// Shared by the accounts, security and responsive suites: throwaway servers,
// a headless Chrome, checks with screenshots, and a JSON report.
//   EVIDENCE_DIR=~/somewhere  → screenshots and <suite>-results.json are kept there.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

export const ROOT = path.resolve(import.meta.dirname, '..');
export const wait = (ms) => new Promise((r) => setTimeout(r, ms));
export const rand = () => Math.random().toString(36).slice(2, 8).padEnd(6, 'x');
export const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
export const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

export async function createSuite(name, { args = [] } = {}) {
  const only = process.argv[2]?.split(',');
  const evidence = process.env.EVIDENCE_DIR ? path.resolve(process.env.EVIDENCE_DIR) : null;
  const shotDir = evidence && path.join(evidence, 'shots', name);
  if (shotDir) mkdirSync(shotDir, { recursive: true });
  const results = [];
  const servers = [];
  const contexts = [];
  const pageErrors = [];
  const started = Date.now();
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome-stable', headless: true, args });
  let current = null;

  const suite = {
    browser,
    pageErrors,

    async startServer(label, port, env = {}, dir = mkdtempSync(path.join(tmpdir(), `cn-${name}-${label}-`))) {
      const proc = spawn(process.execPath, [path.join(ROOT, 'server/index.mjs')], {
        env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dir, CANVASNOTES_TRUST_PROXY: '1', CANVASNOTES_PASSWORD: '', ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let log = '';
      proc.stdout.on('data', (d) => (log += d));
      proc.stderr.on('data', (d) => (log += d));
      const base = `http://127.0.0.1:${port}`;
      for (let i = 0; i < 80; i++) {
        if (await fetch(`${base}/manifest.webmanifest`).then((r) => r.ok, () => false)) break;
        await wait(100);
      }
      const server = { base, dir, proc, log: () => log };
      servers.push(server);
      return server;
    },

    async newPage(options = {}) {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, ...options });
      contexts.push(ctx);
      const page = await ctx.newPage();
      page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 200)));
      return page;
    },

    // Signs up through the API inside the page's context, so the page shares the session.
    async signup(page, base, email, password = 'password-123', extra = {}) {
      return page.request.post(`${base}/api/signup`, {
        data: { email, password, ...extra },
        headers: { 'x-forwarded-for': `10.${Math.floor(Math.random() * 200)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` },
      });
    },

    async check(id, title, fn) {
      if (only && !only.includes(id)) return;
      current = { id, name: title, ok: true, detail: '', shots: [], facts: [] };
      const t0 = Date.now();
      try {
        const detail = await fn();
        if (typeof detail === 'string') current.detail = detail;
      } catch (e) {
        current.ok = false;
        current.detail = String(e.message || e).split('\n')[0].slice(0, 260);
      }
      current.ms = Date.now() - t0;
      results.push(current);
      current = null;
    },

    // A measured fact shown next to the check on the evidence board.
    fact(text) {
      current?.facts.push(String(text));
    },

    // Full-page screenshot kept as evidence for the current check.
    async shot(page, label, options = {}) {
      if (!shotDir || !current) return;
      const vp = page.viewportSize();
      const file = path.join(shotDir, `${current.id}-${label.replace(/[^\w-]+/g, '-').slice(0, 50)}.png`);
      await page.screenshot({ path: file, fullPage: false, ...options });
      current.shots.push({ file, caption: `${label} · ${vp.width}×${vp.height}` });
    },

    async finish() {
      await browser.close();
      for (const s of servers) s.proc.kill();
      await wait(200);
      for (const s of servers) rmSync(s.dir, { recursive: true, force: true });
      for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.id} ${r.name}${r.ok ? (r.detail ? ` (${r.detail})` : '') : ` — ${r.detail}`}`);
      const errors = [...new Set(pageErrors)];
      if (errors.length) console.log(`Page errors:\n  ${errors.join('\n  ')}`);
      const failed = results.filter((r) => !r.ok).length;
      const summary = `${results.length - failed}/${results.length} passed in ${Math.round((Date.now() - started) / 1000)} s`;
      console.log(`\n${summary}`);
      if (evidence) writeFileSync(path.join(evidence, 'results', `${name}-results.json`), JSON.stringify({ suite: name, summary, at: new Date().toISOString(), results, pageErrors: errors }, null, 2));
      process.exit(failed ? 1 : 0);
    },
  };
  if (evidence) mkdirSync(path.join(evidence, 'results'), { recursive: true });
  return suite;
}
