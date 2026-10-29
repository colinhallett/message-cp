// Shared helpers for the evidence collector: running a command without
// throwing, bounding text, and mapping work over a list with a fixed number
// of calls in flight.

import { spawn } from 'node:child_process';
import {
  mkdtempSync,
  openSync,
  closeSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_STDERR = 64 * 1024;

/**
 * Run a command and resolve to `{ ok, stdout, stderr, missing, error }`.
 * Never rejects: a missing binary, a non-zero exit, or a timeout is
 * `ok: false`.
 *
 * Stdout goes to a temporary file rather than a pipe: a CLI that exits
 * straight after one large write to a pipe (the Tessl CLI does) loses the
 * part the pipe had not drained yet, which leaves truncated JSON.
 */
export function run(cmd, args, { cwd, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'prepare-repo-run-'));
  const outPath = join(dir, 'stdout');
  const outFd = openSync(outPath, 'w');
  return new Promise((resolvePromise) => {
    let stderr = '';
    let settled = false;
    const child = spawn(cmd, args, {
      cwd,
      env: process.env,
      stdio: ['ignore', outFd, 'pipe'],
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stderr.on('data', (chunk) => {
      if (stderr.length < MAX_STDERR) stderr += chunk;
    });
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      closeSync(outFd);
      let stdout = '';
      try {
        stdout = readFileSync(outPath, 'utf8');
      } catch {
        stdout = '';
      }
      rmSync(dir, { recursive: true, force: true });
      resolvePromise({ stdout, stderr, ...result });
    };
    child.on('error', (error) =>
      finish({
        ok: false,
        missing: error.code === 'ENOENT',
        error: error.code === 'ENOENT' ? `${cmd} not found` : error.message,
      }),
    );
    child.on('close', (code, signal) => {
      if (code === 0) return finish({ ok: true, missing: false, error: null });
      finish({
        ok: false,
        missing: false,
        error: signal ? 'timed out' : errorText(code, stderr),
      });
    });
  });
}

function errorText(code, stderr) {
  const detail = String(stderr ?? '').trim() || `exited with status ${code}`;
  return clip(detail.replace(/\s+/g, ' '), 300);
}

/** Run a command whose stdout is JSON. Resolves to `{ ok, data, error }`. */
export async function runJson(cmd, args, options) {
  const result = await run(cmd, args, options);
  if (!result.ok) return { ok: false, data: null, error: result.error };
  try {
    return { ok: true, data: JSON.parse(result.stdout), error: null };
  } catch {
    return { ok: false, data: null, error: `${cmd} printed invalid JSON` };
  }
}

/** Trim and cut text to at most `max` characters, marking the cut. */
export function clip(text, max) {
  const s = String(text ?? '').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** Map `fn` over `items` with at most `limit` calls in flight, in order. */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

/** ISO date (YYYY-MM-DD) `days` before `now`. */
export function sinceDate(days, now = new Date()) {
  return new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10);
}

/** The result of a source that did not run because a prerequisite is absent. */
export function skipped(reason) {
  return { status: 'skipped', reason };
}

/** The result of a source that tried and could not finish. */
export function failed(reason) {
  return { status: 'failed', reason };
}
