// GitHub sources: review feedback on merged pull requests, bug-fix and revert
// pull requests, and CI failures on pull requests. All read through `gh`.

import { FIX, REVERT } from '../lib/patterns.mjs';
import { clip, failed, mapLimit, run, runJson, skipped } from '../lib/run.mjs';

const FETCH_CONCURRENCY = 6;
const BODY_CHARS = 1200;
const LISTED_PR_FACTOR = 4;
const FAILED_RUN_DETAILS = 15;
const PAGE_SIZE = 100;

const BUG_LABEL = /^(bug|regression|incident|hotfix)$/i;

/** A GitHub user is a bot when its type says so or its login carries `[bot]`. */
export function isBot(user) {
  if (!user) return false;
  if (user.type === 'Bot' || user.is_bot === true) return true;
  return /\[bot\]$/i.test(user.login ?? '');
}

/** `revert`, `fix`, or null for a pull request's title and labels. */
export function classifyPr(pr) {
  const title = pr.title ?? '';
  if (REVERT.test(title)) return 'revert';
  const labels = (pr.labels ?? []).map((l) => l.name ?? '');
  if (FIX.test(title) || labels.some((l) => BUG_LABEL.test(l))) return 'fix';
  return null;
}

/**
 * Check that `gh` is installed and can reach the API, and resolve the
 * repository and its host. Resolves to `{ ok, repo, host, reason }`.
 */
export async function githubPreflight(root, repoFlag) {
  // `rate_limit` answers any valid token; `user` refuses GitHub App tokens.
  const probe = await run(
    'gh',
    ['api', 'rate_limit', '--jq', '.rate.remaining'],
    {
      cwd: root,
    },
  );
  if (probe.missing) return { ok: false, reason: 'gh is not installed' };
  if (!probe.ok)
    return { ok: false, reason: `gh is not authenticated: ${probe.error}` };
  const args = ['repo', 'view', '--json', 'nameWithOwner,url'];
  if (repoFlag) args.splice(2, 0, repoFlag);
  // An unreachable repository makes search return nothing, which would read as
  // a quiet window, so resolving it is part of the preflight.
  const view = await runJson('gh', args, { cwd: root });
  if (!view.ok)
    return {
      ok: false,
      reason: `could not resolve the GitHub repository: ${view.error}`,
    };
  // Later calls name the host, so a GitHub Enterprise remote is not read
  // from github.com.
  return {
    ok: true,
    repo: view.data.nameWithOwner,
    host: new URL(view.data.url).host,
  };
}

/** `HOST/OWNER/NAME`, the `--repo` form that keeps the host. */
function repoArg(ctx) {
  return `${ctx.host}/${ctx.repo}`;
}

/** `gh api` arguments for `path` on the repository's host. */
function apiArgs(ctx, path) {
  return ['api', '--hostname', ctx.host, path];
}

/** List merged pull requests in the window, newest first, up to `limit`. */
async function listMergedPrs(ctx, limit) {
  return runJson(
    'gh',
    [
      'pr',
      'list',
      '--repo',
      repoArg(ctx),
      '--state',
      'merged',
      '--search',
      `merged:>=${ctx.since} sort:updated-desc`,
      '--limit',
      String(limit),
      '--json',
      'number,title,url,author,mergedAt,labels',
    ],
    { cwd: ctx.root },
  );
}

function feedbackItem(pr, kind, raw) {
  return {
    pr: pr.number,
    kind,
    author: raw.user?.login ?? null,
    bot: isBot(raw.user),
    ...(raw.state ? { state: raw.state } : {}),
    ...(raw.path ? { path: raw.path } : {}),
    ...((raw.line ?? raw.original_line)
      ? { line: raw.line ?? raw.original_line }
      : {}),
    body: clip(raw.body, BODY_CHARS),
    url: raw.html_url ?? null,
  };
}

/**
 * Fetch one pull request's inline comments, review bodies and conversation,
 * page by page. People and bots have separate caps, `perPr` and `botsPerPr`,
 * so a bot that comments on every push cannot crowd out what a reviewer said
 * on the same pull request. Reading stops once both caps are over, so a cut is
 * known to have dropped something, or once `maxPages` pages are read. The page
 * bound holds however many records have blank bodies, which are read but not
 * kept. Inline comments come first: they carry the file and line.
 */
async function fetchPrFeedback(ctx, pr, perPr, botsPerPr, maxPages) {
  const base = `repos/${ctx.repo}`;
  const endpoints = [
    ['inline', `${base}/pulls/${pr.number}/comments`],
    ['review', `${base}/pulls/${pr.number}/reviews`],
    ['conversation', `${base}/issues/${pr.number}/comments`],
  ];
  const people = [];
  const bots = [];
  const errors = [];
  let pages = 0;
  let pageCut = false;
  const full = () => people.length > perPr && bots.length > botsPerPr;
  endpoints: for (const [kind, path] of endpoints) {
    for (let page = 1; !full(); page++) {
      if (pages >= maxPages) {
        pageCut = true;
        break endpoints;
      }
      pages++;
      const result = await runJson(
        'gh',
        apiArgs(ctx, `${path}?per_page=${PAGE_SIZE}&page=${page}`),
        { cwd: ctx.root },
      );
      if (!result.ok || !Array.isArray(result.data)) {
        errors.push(`${kind}: ${result.error ?? 'unexpected response'}`);
        break;
      }
      for (const raw of result.data) {
        if (!String(raw.body ?? '').trim()) continue;
        const item = feedbackItem(pr, kind, raw);
        (item.bot ? bots : people).push(item);
      }
      if (result.data.length < PAGE_SIZE) break;
    }
    if (full()) break;
  }
  // Bots come back uncapped: which of them are status bots is only known
  // once every pull request is read, and their comments must not spend the
  // budget kept for review bots. `readFeedback` applies the bot caps.
  return {
    people: people.slice(0, perPr),
    bots,
    dropped: Math.max(0, people.length - perPr),
    pageCut,
    errors,
  };
}

/**
 * The bots that only ever post to the conversation, never on a file or as a
 * review: deploy previews, coverage reports, bundle sizes, quality gates. They
 * report on the pull request rather than review it, so their comments are not
 * feedback and are dropped, with a count per bot so the drop is visible.
 */
export function statusBots(items) {
  const kinds = new Map();
  for (const item of items.filter((i) => i.bot)) {
    const entry = kinds.get(item.author) ?? { comments: 0, reviewed: false };
    entry.comments++;
    if (item.kind !== 'conversation') entry.reviewed = true;
    kinds.set(item.author, entry);
  }
  return [...kinds.entries()]
    .filter(([, e]) => !e.reviewed)
    .map(([author, e]) => ({ author, comments: e.comments }))
    .sort((a, b) => b.comments - a.comments);
}

/**
 * Whether a window's feedback from people is too thin to build rules from:
 * fewer than `minPeople` entries, or fewer than `minPrs` pull requests with
 * any. The collector then reads a wider window once.
 */
export function isThin(summary, { minPeople, minPrs }) {
  return summary.people < minPeople || summary.prsWithPeople < minPrs;
}

/** Read the feedback of up to `maxPrs` of `prs`, under the total budgets. */
async function readFeedback(ctx, prs) {
  const { limits } = ctx;
  const sample = prs.slice(0, limits.maxPrs);
  // Stop starting new pull requests once the people budget is in hand, so
  // later ones are not fetched only to be cut. Bots never stop the reading.
  let held = 0;
  const fetched = await mapLimit(sample, FETCH_CONCURRENCY, async (pr) => {
    if (held >= limits.maxComments) return null;
    const f = await fetchPrFeedback(
      ctx,
      pr,
      limits.maxCommentsPerPr,
      limits.maxBotCommentsPerPr,
      limits.maxPagesPerPr,
    );
    held += f.people.length;
    return f;
  });
  // Status bots are found across every pull request read, before any bot
  // cap, so their comments never fill the review-bot budget.
  const allBots = fetched.flatMap((f) => f?.bots ?? []);
  const status = statusBots(allBots);
  const statusAuthors = new Set(status.map((s) => s.author));
  const items = [];
  const used = [];
  let cut = false;
  let botsKept = 0;
  sample.forEach((pr, i) => {
    const f = fetched[i];
    const room = limits.maxComments - items.filter((x) => !x.bot).length;
    if (!f || room <= 0) {
      cut = true;
      return;
    }
    if (f.people.length > room) cut = true;
    items.push(...f.people.slice(0, room));
    const reviewBots = f.bots.filter((b) => !statusAuthors.has(b.author));
    if (reviewBots.length > limits.maxBotCommentsPerPr) cut = true;
    const perPr = reviewBots.slice(0, limits.maxBotCommentsPerPr);
    const botRoom = Math.max(0, limits.maxBotComments - botsKept);
    if (perPr.length > botRoom) cut = true;
    items.push(...perPr.slice(0, botRoom));
    botsKept += Math.min(perPr.length, botRoom);
    used.push({ pr, f });
  });
  const people = items.filter((i) => !i.bot);
  const summary = {
    people: people.length,
    prsWithPeople: new Set(people.map((i) => i.pr)).size,
    reviewBots: items.length - people.length,
    statusBotComments: allBots.filter((b) => statusAuthors.has(b.author))
      .length,
  };
  return {
    sample,
    used,
    items,
    statusBots: status,
    summary,
    truncated:
      prs.length > sample.length ||
      cut ||
      used.some(({ f }) => f.dropped > 0 || f.pageCut),
  };
}

const WIDEN_FACTOR = 2;

/**
 * Review feedback on merged pull requests, plus the fix and revert pull
 * requests among a wider listing of the same window. When the window's
 * feedback from people is thin, the feedback is read again once over a window
 * twice as long with twice as many pull requests, and `widened` records it;
 * the fix and revert list keeps the original window.
 */
export async function collectPullRequests(ctx) {
  const limit = ctx.limits.maxPrs * LISTED_PR_FACTOR;
  const listed = await listMergedPrs(ctx, limit);
  if (!listed.ok) {
    const reason = `gh pr list failed: ${listed.error}`;
    return { reviewFeedback: failed(reason), bugFixPrs: failed(reason) };
  }
  const prs = listed.data;
  const bugFixPrs = {
    status: 'ok',
    listed: prs.length,
    truncated: prs.length >= limit,
    items: prs
      .map((pr) => ({ pr, kind: classifyPr(pr) }))
      .filter((x) => x.kind)
      .map(({ pr, kind }) => ({
        number: pr.number,
        kind,
        title: pr.title,
        author: pr.author?.login ?? null,
        mergedAt: pr.mergedAt,
        url: pr.url,
      })),
  };

  let read = await readFeedback(ctx, prs);
  let widened = null;
  const thin = { minPeople: ctx.limits.minPeople, minPrs: ctx.limits.minPrs };
  if (isThin(read.summary, thin) && !read.truncated && ctx.widenTo) {
    const wide = {
      ...ctx,
      since: ctx.widenTo.since,
      limits: {
        ...ctx.limits,
        maxPrs: ctx.limits.maxPrs * WIDEN_FACTOR,
        maxComments: ctx.limits.maxComments * WIDEN_FACTOR,
        maxBotComments: ctx.limits.maxBotComments * WIDEN_FACTOR,
      },
    };
    const wider = await listMergedPrs(
      wide,
      wide.limits.maxPrs * LISTED_PR_FACTOR,
    );
    if (wider.ok && wider.data.length > prs.length) {
      read = await readFeedback(wide, wider.data);
      widened = { days: ctx.widenTo.days, maxPrs: wide.limits.maxPrs };
    }
  }
  const { used, items } = read;
  const failedPrs = used
    .map(({ pr, f }) => ({ number: pr.number, errors: f.errors }))
    .filter((f) => f.errors.length > 0);
  // Every pull request failing is a broken source, not a quiet window.
  const reviewFeedback =
    used.length > 0 && failedPrs.length === used.length && items.length === 0
      ? failed(
          `every pull request's feedback fetch failed, first: ${failedPrs[0].errors[0]}`,
        )
      : {
          status: 'ok',
          prsRead: used.length,
          truncated: read.truncated,
          ...(widened ? { widened } : {}),
          thin: isThin(read.summary, thin),
          summary: read.summary,
          statusBots: read.statusBots,
          failedPrs,
          prs: used.map(({ pr }) => ({
            number: pr.number,
            title: pr.title,
            author: pr.author?.login ?? null,
            mergedAt: pr.mergedAt,
            url: pr.url,
          })),
          items,
        };
  return { reviewFeedback, bugFixPrs };
}

/** Group failed runs by workflow, most failures first. */
export function summarizeFailures(runs) {
  const byWorkflow = new Map();
  for (const r of runs) {
    const name = r.workflowName || r.name || '(unnamed)';
    const entry = byWorkflow.get(name) ?? {
      workflow: name,
      failures: 0,
      branches: new Set(),
    };
    entry.failures++;
    if (r.headBranch) entry.branches.add(r.headBranch);
    byWorkflow.set(name, entry);
  }
  return [...byWorkflow.values()]
    .map((e) => ({
      workflow: e.workflow,
      failures: e.failures,
      branches: e.branches.size,
    }))
    .sort((a, b) => b.failures - a.failures);
}

/**
 * Up to `n` runs to read the failed steps of, taken round-robin across the
 * workflows that failed, newest first within each. The newest `n` runs alone
 * would all come from whichever housekeeping workflow fails most (a cache
 * cleanup, a title check), and say nothing about the test workflow.
 */
export function spreadAcrossWorkflows(runs, n) {
  const byWorkflow = new Map();
  for (const r of runs) {
    const name = r.workflowName || r.name || '(unnamed)';
    if (!byWorkflow.has(name)) byWorkflow.set(name, []);
    byWorkflow.get(name).push(r);
  }
  const queues = [...byWorkflow.values()];
  const picked = [];
  for (let round = 0; picked.length < n; round++) {
    let any = false;
    for (const q of queues) {
      if (round < q.length && picked.length < n) {
        picked.push(q[round]);
        any = true;
      }
    }
    if (!any) break;
  }
  return picked;
}

/** The failed jobs and steps of one workflow run. */
async function failedJobs(ctx, runId) {
  const view = await runJson(
    'gh',
    ['run', 'view', String(runId), '--repo', repoArg(ctx), '--json', 'jobs'],
    { cwd: ctx.root },
  );
  if (!view.ok) return { error: view.error };
  return {
    jobs: (view.data.jobs ?? [])
      .filter((j) => j.conclusion === 'failure')
      .slice(0, 10)
      .map((j) => ({
        name: j.name,
        failedSteps: (j.steps ?? [])
          .filter((s) => s.conclusion === 'failure')
          .map((s) => s.name),
      })),
  };
}

/** Failed workflow runs triggered by pull requests in the window. */
export async function collectCiFailures(ctx) {
  const listed = await runJson(
    'gh',
    [
      'run',
      'list',
      '--repo',
      repoArg(ctx),
      '--event',
      'pull_request',
      '--status',
      'failure',
      '--created',
      `>=${ctx.since}`,
      '--limit',
      String(ctx.limits.maxRuns),
      '--json',
      'databaseId,workflowName,name,headBranch,displayTitle,createdAt,url',
    ],
    { cwd: ctx.root },
  );
  if (!listed.ok) return failed(`gh run list failed: ${listed.error}`);
  const runs = listed.data;
  const recent = spreadAcrossWorkflows(runs, FAILED_RUN_DETAILS);
  const details = await mapLimit(recent, FETCH_CONCURRENCY, (r) =>
    failedJobs(ctx, r.databaseId),
  );
  return {
    status: 'ok',
    runsRead: runs.length,
    truncated: runs.length >= ctx.limits.maxRuns,
    byWorkflow: summarizeFailures(runs),
    recent: recent.map((r, i) => ({
      workflow: r.workflowName || r.name,
      branch: r.headBranch,
      title: r.displayTitle,
      createdAt: r.createdAt,
      url: r.url,
      ...details[i],
    })),
  };
}

/** All GitHub sources, each skipped with the same reason when `gh` is unusable. */
export async function collectGithub(ctx) {
  const preflight = await githubPreflight(ctx.root, ctx.repoFlag);
  if (!preflight.ok) {
    const s = skipped(preflight.reason);
    return { repo: null, reviewFeedback: s, bugFixPrs: s, ciFailures: s };
  }
  const gh = { ...ctx, repo: preflight.repo, host: preflight.host };
  const [prs, ciFailures] = await Promise.all([
    collectPullRequests(gh),
    collectCiFailures(gh),
  ]);
  return { repo: preflight.repo, ...prs, ciFailures };
}
