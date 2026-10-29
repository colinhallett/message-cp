// Open Tessl findings for the project this directory is linked to.

import { clip, failed, run, runJson, skipped } from '../lib/run.mjs';

const PAGE_SIZE = 100;
const TEXT_CHARS = 600;

/** The linked project id from `tessl project repair --json`, or a reason. */
export async function linkedProject(root) {
  // Without flags, `project repair` only diagnoses the link; it changes nothing.
  const result = await run('tessl', ['project', 'repair', '--json'], {
    cwd: root,
  });
  if (result.missing) return { reason: 'tessl is not installed' };
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return {
      reason: `could not read the project link: ${result.error ?? 'invalid JSON'}`,
    };
  }
  const id = parsed.linkedProject?.id;
  if (!id)
    return {
      reason:
        parsed.message ?? 'this directory is not linked to a Tessl project',
    };
  return { id, name: parsed.linkedProject.name ?? null };
}

function summarize(finding) {
  const a = finding.attributes ?? {};
  const evidence = (a.observations ?? []).flatMap((o) => o.evidence ?? []);
  return {
    id: finding.id,
    title: a.title,
    analysis: clip(a.analysis, TEXT_CHARS),
    recommendation: clip(a.recommendation, TEXT_CHARS),
    evidence: evidence.slice(0, 10),
    createdAt: a.createdAt,
  };
}

/** Open findings, newest first, up to `maxFindings`, reading every page. */
export async function collectFindings(ctx) {
  const project = await linkedProject(ctx.root);
  if (!project.id) return skipped(project.reason);
  const items = [];
  let after = null;
  let more = true;
  while (more && items.length < ctx.limits.maxFindings) {
    const args = [
      'finding',
      'list',
      '--project',
      project.id,
      '--state',
      'open',
      '--json',
      '--limit',
      String(Math.min(PAGE_SIZE, ctx.limits.maxFindings)),
    ];
    if (after) args.push('--after', after);
    const page = await runJson('tessl', args, { cwd: ctx.root });
    if (!page.ok) return failed(`tessl finding list failed: ${page.error}`);
    items.push(...(page.data.data ?? []).map(summarize));
    const next = page.data.links?.next;
    after = next ? new URL(next).searchParams.get('page[after]') : null;
    more = Boolean(after);
  }
  return {
    status: 'ok',
    project,
    truncated: more || items.length > ctx.limits.maxFindings,
    items: items.slice(0, ctx.limits.maxFindings),
  };
}
