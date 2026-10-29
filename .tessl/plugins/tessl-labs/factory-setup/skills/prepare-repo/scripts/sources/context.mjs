// Agent context inventory: the files agents read in this repository, found
// among the files git tracks so ignored and generated trees stay out.

import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';

import { failed, run } from '../lib/run.mjs';

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '.turbo',
  '.venv',
]);

/**
 * The kind of agent context a repository-relative path is, or null. Skills
 * and rules that `tessl install` vendored (any `tessl__` segment, or under
 * `.tessl/`) belong to their plugin, not to the repository, so they are null.
 */
export function contextKind(rel) {
  const segs = rel.split('/');
  if (segs[0] === '.tessl' || segs.some((s) => s.startsWith('tessl__')))
    return null;
  const base = segs.at(-1);
  const has = (s) => segs.includes(s);
  if (base === 'AGENTS.md' || base === 'CLAUDE.md' || base === 'GEMINI.md')
    return 'agent-instructions';
  if (base === '.cursorrules') return 'rules';
  if (has('.cursor') && has('rules') && /\.mdc?$/.test(base)) return 'rules';
  if (has('.github') && base === 'copilot-instructions.md') return 'rules';
  if (has('.github') && has('instructions') && base.endsWith('.md'))
    return 'rules';
  if (has('.claude') && has('rules') && base.endsWith('.md')) return 'rules';
  if (base === 'SKILL.md') return 'skill';
  if (has('.claude') && has('commands') && base.endsWith('.md'))
    return 'command';
  if (has('.claude') && has('agents') && base.endsWith('.md'))
    return 'subagent';
  if (/^CONTRIBUTING(\.md)?$/i.test(base)) return 'contributing';
  if (base === '.mcp.json') return 'mcp';
  if ((has('.cursor') || has('.vscode')) && base === 'mcp.json') return 'mcp';
  if (base === 'tessl.json') return 'tessl-manifest';
  if (has('.claude') && /^settings(\.local)?\.json$/.test(base))
    return 'agent-settings';
  return null;
}

function walk(root, dir, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(root, full, out);
    else if (e.isFile()) out.push(relative(root, full));
  }
}

async function candidatePaths(root) {
  const listed = await run('git', ['ls-files', '-z'], { cwd: root });
  if (listed.ok) return listed.stdout.split('\0').filter(Boolean);
  const out = [];
  walk(root, root, out);
  return out;
}

/**
 * Where `rel` really lands, or why it is not read. A tracked symlink or a `..`
 * path can point outside the repository, and the repository's content must not
 * pull the caller's other files into evidence.json.
 */
function resolveInside(realRoot, rel) {
  const real = realpathSync(join(realRoot, rel));
  const inside = relative(realRoot, real);
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside))
    return { reason: 'outside root' };
  // A symlink to a FIFO would block the read forever.
  if (!statSync(real).isFile()) return { reason: 'not a regular file' };
  return { real };
}

function describe(realRoot, rel, kind) {
  let text = '';
  try {
    const target = resolveInside(realRoot, rel);
    if (!target.real)
      return { path: rel, kind, readable: false, reason: target.reason };
    text = readFileSync(target.real, 'utf8');
  } catch {
    return { path: rel, kind, readable: false };
  }
  const entry = {
    path: rel,
    kind,
    lines: text.split('\n').length,
    bytes: Buffer.byteLength(text),
  };
  if (kind === 'skill') {
    const name = /^name:\s*(.+)$/m.exec(text);
    if (name) entry.name = name[1].trim();
  }
  if (kind === 'mcp') {
    try {
      const parsed = JSON.parse(text);
      const servers = parsed.mcpServers ?? parsed.servers ?? {};
      entry.servers = Object.keys(servers);
    } catch {
      entry.servers = null;
    }
  }
  if (kind === 'tessl-manifest') {
    try {
      entry.dependencies = Object.keys(
        JSON.parse(text).dependencies ?? {},
      ).length;
    } catch {
      entry.dependencies = null;
    }
  }
  return entry;
}

/** Inventory of agent context files, bounded to `maxFiles` entries. */
export async function collectContext(ctx) {
  try {
    const realRoot = realpathSync(ctx.root);
    const paths = await candidatePaths(ctx.root);
    const matches = paths
      .map((rel) => ({ rel, kind: contextKind(rel) }))
      .filter((m) => m.kind)
      .sort(
        (a, b) =>
          a.rel.split('/').length - b.rel.split('/').length ||
          a.rel.localeCompare(b.rel),
      );
    const counts = {};
    for (const m of matches) counts[m.kind] = (counts[m.kind] ?? 0) + 1;
    return {
      status: 'ok',
      counts,
      truncated: matches.length > ctx.limits.maxFiles,
      files: matches
        .slice(0, ctx.limits.maxFiles)
        .map((m) => describe(realRoot, m.rel, m.kind)),
    };
  } catch (error) {
    return failed(`could not list files: ${error.message}`);
  }
}
