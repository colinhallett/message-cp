#!/usr/bin/env node
// Builds the agent-readiness report from the structured assessment JSON.
//
// The agent discovers the repo's apps and, for each criterion, judges how many
// of the applicable apps satisfy it (passingApps / applicableApps). Every
// aggregate — per-category pass rates, the app-weighted overall score, the
// maturity level, and the summary counts — is computed here so the numbers are
// always arithmetically consistent with the per-app judgements, never eyeballed.
//
// Usage: node build-report.mjs [input.json] [output.md]
//   input  defaults to agent-readiness.json
//   output defaults to agent-readiness-report.md; it must be a file name in the
//   current directory
// Prints the one-line summary (level + overall score) to stdout.

import { lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { fileURLToPath } from 'node:url';

// The published rubric (references/rubric.md): each category and the exact
// criteria it scores. An assessment must judge every criterion once, by these
// names, so a score cannot rise by dropping a failure or adding a pass.
export const RUBRIC = {
  'Style & Validation': [
    'Linter Configured',
    'Code Formatter',
    'Type Checker / Strict Typing',
    'Pre-commit Hooks',
    'Dead Code Detection',
  ],
  'Build System': [
    'Single Command Setup',
    'Dependencies Pinned',
    'Build Command Documented',
    'Task / Monorepo Tooling',
    'CI Configured',
  ],
  Testing: [
    'Unit Tests Exist',
    'Tests Runnable',
    'Integration / E2E Tests',
    'Test File Conventions',
    'Coverage Thresholds',
  ],
  Documentation: [
    'README',
    'Agent Context File',
    'Architecture Docs',
    'API / Schema Docs',
    'Documentation Freshness',
  ],
  'Development Environment': [
    'Environment Template',
    'Local Services Setup',
    'Database Schema & Migrations',
    'Dev Container',
  ],
  Observability: [
    'Structured Logging',
    'Health Checks',
    'Metrics / Telemetry',
    'Error Tracking',
    'Distributed Tracing',
  ],
  Security: [
    'Secret Scanning',
    'Dependency Update Automation',
    'Gitignore Comprehensive',
    'Secrets Management',
    'CODEOWNERS',
  ],
  'Agent Readiness': [
    'Agent Context Quality',
    'Skills / Reusable Context',
    'MCP Configuration',
    'Editor / Agent Rules',
    'Task Discovery',
  ],
};

const CATEGORY_NAMES = Object.keys(RUBRIC);

// Validation failures throw; main() converts them to a clean exit(1). Throwing
// (rather than exiting inline) keeps parseAssessment testable.
function fail(message) {
  throw new Error(message);
}

const isNonNegInt = (n) => Number.isInteger(n) && n >= 0;

/**
 * A criterion's status derives from its per-app counts:
 * - `skipped`  — no app the criterion applies to (excluded from scores)
 * - `passed`   — every applicable app satisfies it
 * - `failed`   — some or no applicable apps satisfy it
 */
export function statusOf(criterion) {
  if (criterion.applicableApps === 0) return 'skipped';
  return criterion.passingApps === criterion.applicableApps
    ? 'passed'
    : 'failed';
}

/**
 * Throw unless `category` judges each of its rubric criteria exactly once, by
 * the rubric's name, and nothing else.
 */
function checkCriterionSet(category) {
  const expected = RUBRIC[category.name];
  const names = category.criteria.map((criterion) => criterion.name);
  const duplicated = names.filter((name, i) => names.indexOf(name) !== i);
  const unknown = names.filter((name) => !expected.includes(name));
  const missing = expected.filter((name) => !names.includes(name));
  const problems = [
    ['missing', missing],
    ['unknown', unknown],
    ['duplicated', [...new Set(duplicated)]],
  ]
    .filter(([, list]) => list.length > 0)
    .map(
      ([label, list]) =>
        `${label} ${list.map((n) => JSON.stringify(n)).join(', ')}`,
    );
  if (problems.length > 0) {
    fail(
      `category "${category.name}" must judge each rubric criterion exactly once: ${problems.join('; ')}`,
    );
  }
}

/** Parse and structurally validate the assessment JSON. Throws on bad input. */
export function parseAssessment(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    fail(`input is not valid JSON: ${err.message}`);
  }
  if (
    !data ||
    !Array.isArray(data.apps) ||
    data.apps.length === 0 ||
    !data.apps.every((a) => typeof a === 'string' && a.length > 0)
  ) {
    fail('input must have a non-empty "apps" array of app names');
  }
  if (!Array.isArray(data.categories)) {
    fail('input must have a "categories" array');
  }
  const appCount = data.apps.length;
  if (new Set(data.apps).size !== appCount) {
    fail('"apps" must contain unique app names');
  }
  const categoryNames = data.categories.map((category) => category?.name);
  if (
    categoryNames.length !== CATEGORY_NAMES.length ||
    new Set(categoryNames).size !== CATEGORY_NAMES.length ||
    CATEGORY_NAMES.some((name) => !categoryNames.includes(name))
  ) {
    fail('input must contain each readiness category exactly once');
  }
  for (const category of data.categories) {
    if (!CATEGORY_NAMES.includes(category?.name)) {
      fail(`unknown category name: ${JSON.stringify(category?.name)}`);
    }
    if (!Array.isArray(category.criteria) || category.criteria.length === 0) {
      fail(`category "${category.name}" has no criteria`);
    }
    for (const criterion of category.criteria) {
      if (typeof criterion?.name !== 'string' || criterion.name.length === 0) {
        fail(`a criterion in "${category.name}" is missing a name`);
      }
    }
    checkCriterionSet(category);
    for (const criterion of category.criteria) {
      if (
        !isNonNegInt(criterion.applicableApps) ||
        !isNonNegInt(criterion.passingApps) ||
        criterion.applicableApps > appCount ||
        criterion.passingApps > criterion.applicableApps
      ) {
        fail(
          `criterion "${criterion.name}" needs 0 <= passingApps <= applicableApps <= ${appCount}`,
        );
      }
      if (
        typeof criterion.rationale !== 'string' ||
        criterion.rationale.length === 0
      ) {
        fail(`criterion "${criterion.name}" is missing a rationale`);
      }
      if (
        statusOf(criterion) === 'failed' &&
        (typeof criterion.action !== 'string' || criterion.action.length === 0)
      ) {
        fail(`failed criterion "${criterion.name}" is missing an action`);
      }
    }
  }
  if (data.recommendations !== undefined) {
    if (!Array.isArray(data.recommendations)) {
      fail('"recommendations" must be an array when present');
    }
    for (const rec of data.recommendations) {
      if (
        typeof rec?.title !== 'string' ||
        rec.title.length === 0 ||
        typeof rec?.detail !== 'string' ||
        rec.detail.length === 0
      ) {
        fail('each recommendation needs a non-empty title and detail');
      }
    }
  }
  return data;
}

// null when no app is applicable — that is "not applicable", not "0% passing".
const ratio = (passing, applicable) =>
  applicable === 0 ? null : passing / applicable;

function levelFor(overallScore) {
  if (overallScore < 0.4) return 1;
  if (overallScore < 0.6) return 2;
  if (overallScore < 0.8) return 3;
  if (overallScore < 0.92) return 4;
  return 5;
}

/**
 * Compute every aggregate from the per-app criterion counts. Scores are
 * app-weighted: a criterion satisfied by 7 of 12 apps contributes 7/12, so
 * partial adoption across a monorepo pulls the total down.
 */
export function computeRollup(assessment) {
  let totalPassing = 0;
  let totalApplicable = 0;
  const summary = { total: 0, passed: 0, failed: 0, skipped: 0 };

  const categories = assessment.categories.map((category) => {
    let passing = 0;
    let applicable = 0;
    for (const criterion of category.criteria) {
      passing += criterion.passingApps;
      applicable += criterion.applicableApps;
      summary.total += 1;
      summary[statusOf(criterion)] += 1;
    }
    totalPassing += passing;
    totalApplicable += applicable;
    return {
      name: category.name,
      criteria: category.criteria,
      passRate: ratio(passing, applicable),
    };
  });

  const overallScore = ratio(totalPassing, totalApplicable);
  return {
    level: overallScore === null ? null : levelFor(overallScore),
    overallScore,
    appsAssessed: assessment.apps.length,
    categories,
    summary,
  };
}

const pct = (fraction) =>
  fraction === null ? 'n/a' : `${Math.round(fraction * 100)}%`;
const levelLabel = (level) => (level === null ? 'n/a' : `${level}/5`);
const STATUS_LABEL = { passed: 'Passed', failed: 'Failed', skipped: 'Skipped' };
// Flatten a value into a single markdown table cell.
const cell = (text) => text.replaceAll('\n', ' ').replaceAll('|', '\\|');
// "7 / 12", or "n/a" when the criterion applies to no app.
const coverage = (crit) =>
  crit.applicableApps === 0
    ? 'n/a'
    : `${crit.passingApps} / ${crit.applicableApps}`;

export function renderReport(assessment, rollup, generatedAt) {
  const repo = assessment.repo ?? 'repository';
  const lines = [
    `# Agent Readiness Report: ${repo}`,
    '',
    `**Level:** ${levelLabel(rollup.level)}`,
    `**Overall Score:** ${pct(rollup.overallScore)}`,
    `**Apps assessed:** ${rollup.appsAssessed} (${assessment.apps.map(cell).join(', ')})`,
    `**Generated:** ${generatedAt}`,
    '',
    'Coverage is the number of applicable apps that satisfy each criterion. The',
    'overall score is app-weighted, so a capability adopted in only some apps',
    'scores partially.',
    '',
    '## Summary',
    '',
    '| Metric | Value |',
    '|--------|-------|',
    `| Total Criteria | ${rollup.summary.total} |`,
    `| Passed (all apps) | ${rollup.summary.passed} |`,
    `| Failed (some/no apps) | ${rollup.summary.failed} |`,
    `| Skipped (n/a) | ${rollup.summary.skipped} |`,
    '',
    '## Pass Rate by Category',
    '',
    '| Category | Pass Rate |',
    '|----------|-----------|',
    ...rollup.categories.map((c) => `| ${c.name} | ${pct(c.passRate)} |`),
  ];

  for (const category of rollup.categories) {
    lines.push(
      '',
      `## ${category.name}`,
      '',
      '| Criterion | Coverage | Status | Rationale |',
      '|-----------|----------|--------|-----------|',
      ...category.criteria.map(
        (crit) =>
          `| ${cell(crit.name)} | ${coverage(crit)} | ${STATUS_LABEL[statusOf(crit)]} | ${cell(crit.rationale)} |`,
      ),
    );
  }

  const recommendations = assessment.recommendations ?? [];
  if (recommendations.length > 0) {
    lines.push('', '## Recommended actions', '');
    recommendations.forEach((rec, i) => {
      lines.push(`${i + 1}. **${rec.title}** — ${rec.detail}`);
    });
  }

  const gaps = rollup.categories.flatMap((category) =>
    category.criteria
      .filter((crit) => statusOf(crit) === 'failed')
      .map((crit) => ({ category: category.name, crit })),
  );
  if (gaps.length > 0) {
    lines.push(
      '',
      '## Gaps → actions',
      '',
      '| Category | Criterion | Coverage | Action |',
      '|----------|-----------|----------|--------|',
      ...gaps.map(
        ({ category, crit }) =>
          `| ${cell(category)} | ${cell(crit.name)} | ${coverage(crit)} | ${cell(crit.action)} |`,
      ),
    );
  }

  lines.push('');
  return lines.join('\n');
}

export function resolveOutputPath(outputPath, cwd = process.cwd()) {
  if (isAbsolute(outputPath)) {
    fail('output path must be relative to the current working directory');
  }

  const resolvedCwd = resolve(cwd);
  const resolvedOutputPath = resolve(resolvedCwd, outputPath);
  const relativeOutputPath = relative(resolvedCwd, resolvedOutputPath);
  if (
    relativeOutputPath === '..' ||
    relativeOutputPath.startsWith(`..${sep}`) ||
    isAbsolute(relativeOutputPath)
  ) {
    fail('output path must remain within the current working directory');
  }

  let outputIsSymlink = false;
  try {
    outputIsSymlink = lstatSync(resolvedOutputPath).isSymbolicLink();
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  let canonicalOutputPath;
  try {
    canonicalOutputPath = realpathSync(resolvedOutputPath);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    if (outputIsSymlink) {
      fail('output path must not be a dangling symbolic link');
    }
    canonicalOutputPath = resolve(
      realpathSync(dirname(resolvedOutputPath)),
      basename(resolvedOutputPath),
    );
  }

  const canonicalCwd = realpathSync(resolvedCwd);
  const relativeCanonicalOutputPath = relative(
    canonicalCwd,
    canonicalOutputPath,
  );
  if (
    relativeCanonicalOutputPath === '..' ||
    relativeCanonicalOutputPath.startsWith(`..${sep}`) ||
    isAbsolute(relativeCanonicalOutputPath)
  ) {
    fail('output path must remain within the current working directory');
  }

  if (
    canonicalOutputPath === canonicalCwd ||
    dirname(canonicalOutputPath) !== canonicalCwd
  ) {
    fail('output path must be a file name in the current working directory');
  }

  // Rebuild from the trusted root and a single name segment so the result is
  // not the command-line argument itself.
  return join(canonicalCwd, basename(canonicalOutputPath));
}

function main() {
  const inputPath = process.argv[2] ?? 'agent-readiness.json';
  const outputPath = process.argv[3] ?? 'agent-readiness-report.md';
  const resolvedOutputPath = resolveOutputPath(outputPath);

  let raw;
  try {
    raw = readFileSync(inputPath, 'utf8');
  } catch (err) {
    throw new Error(`cannot read ${inputPath}: ${err.message}`);
  }

  const assessment = parseAssessment(raw);
  const rollup = computeRollup(assessment);
  const report = renderReport(assessment, rollup, new Date().toISOString());
  writeFileSync(resolvedOutputPath, report);

  console.log(
    `Level ${levelLabel(rollup.level)} — Overall ${pct(rollup.overallScore)} across ${rollup.appsAssessed} apps (${rollup.summary.passed} passed, ${rollup.summary.failed} failed, ${rollup.summary.skipped} skipped of ${rollup.summary.total} criteria). Report written to ${outputPath}.`,
  );
}

// Run only as a CLI, so the pure functions above can be imported by tests.
// Compare real paths: an installed skill is often reached through a symlink,
// and Node resolves import.meta.url to the real path but not argv[1].
function isEntryPoint() {
  try {
    return (
      realpathSync(fileURLToPath(import.meta.url)) ===
      realpathSync(process.argv[1])
    );
  } catch {
    return false;
  }
}

if (process.argv[1] && isEntryPoint()) {
  try {
    main();
  } catch (err) {
    console.error(`build-report: ${err.message}`);
    process.exit(1);
  }
}
