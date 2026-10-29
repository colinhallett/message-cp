// Git sources: reverts, bug-fix commits, file churn and co-change hotspots,
// from one pass over the history in the window.

import { FIX, REVERT } from '../lib/patterns.mjs';
import { failed, run, skipped } from '../lib/run.mjs';

const COMMIT_MARK = '\u0001';
const FIELD_SEP = '\u0002';
// A commit touching more files than this is a bulk change (a rename, a
// format pass, a lockfile bump) and says nothing about which files move
// together, so it is left out of co-change counts.
const MAX_FILES_FOR_COCHANGE = 30;
const COCHANGE_SOURCES = 15;
const COCHANGE_PARTNERS = 5;
const SUBJECT_LIST_LIMIT = 50;
// The shortest history worth reading when the full log times out.
const SHORT_LOG = 500;

// Generated and vendored paths churn because a tool rewrites them.
const NOISE_PATH =
  /(^|\/)(node_modules|dist|build|vendor)\/|(\.lock|-lock\.json|\.snap|\.min\.js|\.generated\.\w+)$|(^|\/)(bun\.lockb?|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|go\.sum|poetry\.lock|uv\.lock)$/;

/** Parse `git log` output written with the markers above into commits. */
export function parseLog(text) {
  return text
    .split(COMMIT_MARK)
    .filter((chunk) => chunk.trim())
    .map((chunk) => {
      const [header, ...rest] = chunk.split('\n');
      const [sha, date, author, subject] = header.split(FIELD_SEP);
      const files = rest.map((l) => l.trim()).filter(Boolean);
      return { sha, date, author, subject: subject ?? '', files };
    });
}

/** Files ranked by commit count, then the files each top file moves with. */
export function hotspots(commits, { maxFiles }) {
  const churn = new Map();
  for (const c of commits)
    for (const f of c.files)
      if (!NOISE_PATH.test(f)) churn.set(f, (churn.get(f) ?? 0) + 1);
  const ranked = [...churn.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, maxFiles)
    .map(([file, commits]) => ({ file, commits }));

  const sources = new Set(ranked.slice(0, COCHANGE_SOURCES).map((r) => r.file));
  const partners = new Map([...sources].map((f) => [f, new Map()]));
  for (const c of commits) {
    if (c.files.length > MAX_FILES_FOR_COCHANGE) continue;
    const files = c.files.filter((f) => !NOISE_PATH.test(f));
    for (const f of files) {
      if (!sources.has(f)) continue;
      const counts = partners.get(f);
      for (const other of files)
        if (other !== f) counts.set(other, (counts.get(other) ?? 0) + 1);
    }
  }
  const coChange = [...sources].map((file) => ({
    file,
    with: [...partners.get(file).entries()]
      .filter(([, n]) => n > 1)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, COCHANGE_PARTNERS)
      .map(([other, commits]) => ({ file: other, commits })),
  }));
  return { churn: ranked, coChange: coChange.filter((c) => c.with.length) };
}

// `truncated` covers both the commit limit and the cut to SUBJECT_LIST_LIMIT.
export function subjectList(commits, pattern, historyTruncated) {
  const matches = commits.filter((c) => pattern.test(c.subject));
  return {
    status: 'ok',
    truncated: historyTruncated || matches.length > SUBJECT_LIST_LIMIT,
    count: matches.length,
    items: matches.slice(0, SUBJECT_LIST_LIMIT).map((c) => ({
      sha: c.sha.slice(0, 12),
      date: c.date,
      subject: c.subject,
      files: c.files.slice(0, 10),
    })),
  };
}

/** All git sources. */
export async function collectGit(ctx) {
  const probe = await run('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd: ctx.root,
  });
  if (probe.missing) {
    const s = skipped('git is not installed');
    return { reverts: s, fixCommits: s, hotspots: s };
  }
  if (!probe.ok) {
    const s = skipped('not a git repository');
    return { reverts: s, fixCommits: s, hotspots: s };
  }
  const logSince = (maxCount) =>
    run(
      'git',
      [
        'log',
        '--no-merges',
        `--since=${ctx.since}`,
        `--max-count=${maxCount}`,
        '--name-only',
        `--format=${COMMIT_MARK}%H${FIELD_SEP}%cs${FIELD_SEP}%ae${FIELD_SEP}%s`,
      ],
      { cwd: ctx.root, timeoutMs: 120_000 },
    );
  let maxCount = ctx.limits.maxCommits;
  let log = await logSince(maxCount);
  // A partial or very large clone can time out listing the files of every
  // commit. Rather than lose all three sources, read the newest quarter and
  // mark the result truncated.
  if (!log.ok && /timed out/.test(log.error ?? '') && maxCount > SHORT_LOG) {
    maxCount = Math.max(SHORT_LOG, Math.floor(maxCount / 4));
    log = await logSince(maxCount);
  }
  if (!log.ok) {
    const s = failed(`git log failed: ${log.error}`);
    return { reverts: s, fixCommits: s, hotspots: s };
  }
  const commits = parseLog(log.stdout);
  const truncated = commits.length >= maxCount;
  return {
    reverts: subjectList(commits, REVERT, truncated),
    fixCommits: subjectList(
      commits.filter((c) => !REVERT.test(c.subject)),
      FIX,
      truncated,
    ),
    hotspots: {
      status: 'ok',
      commitsRead: commits.length,
      truncated,
      ...hotspots(commits, { maxFiles: ctx.limits.maxFiles }),
    },
  };
}
