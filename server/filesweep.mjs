// Deletes uploaded files nobody uses any more. A file an account uploaded but no
// longer uses on any card (Trash included) is first marked; if it is still
// unused after the grace period (so Undo or Redo right after a delete keeps
// working), the account's claim is removed, and the file itself is deleted from
// disk once no account claims it. Storage usage counts claimed files, so the
// space comes back when the claim goes.
import fs from 'node:fs';
import path from 'node:path';

export function createFileSweeper({ store, filesDir, graceMs, log = () => {} }) {
  const pending = new Map(); // userId → timer for a sweep soon after a change

  function sweepUser(userId, now = Date.now()) {
    const used = store.referencedFiles(userId);
    let released = 0;
    let deleted = 0;
    for (const up of store.uploadsOf(userId)) {
      if (used.has(up.name)) {
        if (up.orphaned_at !== null) store.setOrphaned(userId, up.name, null);
        continue;
      }
      // A brand-new upload isn't on a card yet (the card is saved a moment later).
      if (up.orphaned_at === null) {
        if (now - up.created_at >= graceMs) store.setOrphaned(userId, up.name, now);
        continue;
      }
      if (now - up.orphaned_at < graceMs) continue;
      released++;
      if (store.releaseUpload(userId, up.name)) {
        const file = path.join(filesDir, up.name);
        if (path.dirname(file) === filesDir) fs.rmSync(file, { force: true });
        deleted++;
      }
    }
    if (released) log(`Freed ${released} unused upload(s) for one account; ${deleted} file(s) deleted from disk`);
    return { released, deleted };
  }

  function sweepAll(now = Date.now()) {
    const total = { released: 0, deleted: 0 };
    for (const userId of store.uploaders()) {
      const r = sweepUser(userId, now);
      total.released += r.released;
      total.deleted += r.deleted;
    }
    return total;
  }

  return {
    sweepUser,
    sweepAll,
    // After cards change: look again shortly (one sweep per account per burst of saves).
    soon(userId, delayMs = 2000) {
      if (pending.has(userId)) return;
      pending.set(
        userId,
        setTimeout(() => {
          pending.delete(userId);
          try {
            sweepUser(userId);
          } catch (err) {
            console.error('file sweep failed', err);
          }
        }, delayMs).unref(),
      );
    },
  };
}
