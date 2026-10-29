#!/usr/bin/env node
// Builds the step 8 readiness score from the step 1 assessment and a re-judge
// of only the criteria whose evidence the branch changed.
//
// Two independent scoring runs disagree by more than a branch moves the
// score, so step 8 does not score the repository again. It keeps every step 1
// criterion and changes only the ones the re-judge names. The baseline names
// each criterion's applicable and passing apps. A re-judged criterion lists
// the apps whose result a changed file flips, each citing a file from the
// branch diff; the script refuses a flip the baseline does not allow and
// moves the baseline lists by the rest. A criterion or app the branch did not
// touch cannot move.
//
// Usage: node rescore.mjs [baseline.json] [rejudged.json] [changed-files.txt]
//   baseline      defaults to agent-readiness.json (the step 1 assessment)
//   rejudged      defaults to rejudged.json
//   changed-files defaults to changed-files.txt, one repository path per line
// Writes agent-readiness-after.json and agent-readiness-after-report.md in the
// current directory, and prints the before and after comparison to stdout.

import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  computeRollup,
  parseAssessment,
  renderReport,
  resolveOutputPath,
  statusOf,
} from './build-report.mjs';

const AFTER_JSON = 'agent-readiness-after.json';
const AFTER_REPORT = 'agent-readiness-after-report.md';

function fail(message) {
  throw new Error(message);
}

const keyOf = (category, criterion) => `${category} / ${criterion}`;

/** Parse the changed-files list: one path per line, blank lines ignored. */
export function parseChangedFiles(raw) {
  return new Set(
    raw
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  );
}

const isFileList = (value) =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every((path) => typeof path === 'string');

/** Throw unless every path in `evidence` is in the branch diff. */
function checkEvidence(what, evidence, changedFiles) {
  if (!isFileList(evidence)) {
    fail(`${what} needs an "evidence" list of files`);
  }
  const outside = evidence.filter((path) => !changedFiles.has(path));
  if (outside.length > 0) {
    fail(
      `${what} cites files the branch did not change: ${outside.join(', ')}`,
    );
  }
}

const isAppList = (value, apps, size) =>
  Array.isArray(value) &&
  value.length === size &&
  new Set(value).size === size &&
  value.every((app) => apps.has(app));

/**
 * Throw unless the baseline criterion names its applicable and passing apps,
 * consistent with its counts, so each flip can be checked against them.
 */
function checkBaselineApps(key, criterion, apps) {
  const { applicableAppNames: applicable, passingAppNames: passing } =
    criterion;
  if (
    !isAppList(applicable, apps, criterion.applicableApps) ||
    !isAppList(passing, apps, criterion.passingApps) ||
    !passing.every((app) => applicable.includes(app))
  ) {
    fail(
      `baseline criterion "${key}" needs "applicableAppNames" and "passingAppNames" listing its apps, matching its counts`,
    );
  }
}

/**
 * Parse the re-judge and check each entry against the baseline and the diff.
 * Returns the entries keyed by "<category> / <criterion>". Throws on bad input.
 */
export function parseRejudged(raw, baseline, changedFiles) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    fail(`re-judge is not valid JSON: ${err.message}`);
  }
  if (!data || !Array.isArray(data.criteria)) {
    fail('re-judge must have a "criteria" array');
  }
  const known = new Map(
    baseline.categories.flatMap((category) =>
      category.criteria.map((criterion) => [
        keyOf(category.name, criterion.name),
        criterion,
      ]),
    ),
  );
  const apps = new Set(baseline.apps);
  const rejudged = new Map();
  for (const entry of data.criteria) {
    const key = keyOf(entry?.category, entry?.name);
    if (!known.has(key)) {
      fail(`re-judged criterion "${key}" is not in the baseline`);
    }
    if (rejudged.has(key)) {
      fail(`criterion "${key}" is re-judged more than once`);
    }
    const criterion = known.get(key);
    checkBaselineApps(key, criterion, apps);
    checkEvidence(`re-judged criterion "${key}"`, entry.evidence, changedFiles);
    if (!Array.isArray(entry.changes)) {
      fail(`re-judged criterion "${key}" needs a "changes" list`);
    }
    const seen = new Set();
    for (const change of entry.changes) {
      if (!apps.has(change?.app)) {
        fail(
          `re-judged criterion "${key}" changes "${change?.app}", which is not in the baseline apps`,
        );
      }
      if (!criterion.applicableAppNames.includes(change.app)) {
        fail(
          `re-judged criterion "${key}" changes "${change.app}", which it does not apply to in the baseline`,
        );
      }
      if (seen.has(change.app)) {
        fail(`re-judged criterion "${key}" changes "${change.app}" twice`);
      }
      seen.add(change.app);
      if (typeof change.passes !== 'boolean') {
        fail(
          `re-judged criterion "${key}" needs "passes" true or false for "${change.app}"`,
        );
      }
      if (criterion.passingAppNames.includes(change.app) === change.passes) {
        fail(
          `re-judged criterion "${key}" says "${change.app}" now ${change.passes ? 'passes' : 'fails'}, which it already did in the baseline`,
        );
      }
      checkEvidence(
        `re-judged criterion "${key}" for "${change.app}"`,
        change.evidence,
        changedFiles,
      );
    }
    rejudged.set(key, entry);
  }
  return rejudged;
}

/**
 * The baseline with each re-judged criterion updated. Apps, categories,
 * criterion order and each criterion's applicable apps come from the
 * baseline; passing apps are the baseline's passing apps with each flip the
 * re-judge lists applied. The baseline's recommendations are dropped: they ranked the
 * gaps before the branch, so they can name work the branch finished. The
 * report's gaps table lists the actions still open.
 */
export function mergeAssessment(baseline, rejudged) {
  const { recommendations: _, ...kept } = baseline;
  return {
    ...kept,
    categories: baseline.categories.map((category) => ({
      ...category,
      criteria: category.criteria.map((criterion) => {
        const entry = rejudged.get(keyOf(category.name, criterion.name));
        if (!entry) return criterion;
        const passing = new Set(criterion.passingAppNames);
        for (const change of entry.changes) {
          if (change.passes) passing.add(change.app);
          else passing.delete(change.app);
        }
        const passingAppNames = criterion.applicableAppNames.filter((app) =>
          passing.has(app),
        );
        const merged = {
          name: criterion.name,
          applicableApps: criterion.applicableApps,
          passingApps: passingAppNames.length,
          applicableAppNames: criterion.applicableAppNames,
          passingAppNames,
          rationale: entry.rationale,
        };
        if (entry.action !== undefined) merged.action = entry.action;
        return merged;
      }),
    })),
  };
}

/** Changed files that no re-judged criterion cites, in diff order. */
export function uncitedFiles(changedFiles, rejudged) {
  const cited = new Set(
    [...rejudged.values()].flatMap((entry) => [
      ...entry.evidence,
      ...entry.changes.flatMap((change) => change.evidence),
    ]),
  );
  return [...changedFiles].filter((path) => !cited.has(path));
}

const pct = (fraction) =>
  fraction === null ? 'n/a' : `${Math.round(fraction * 100)}%`;
const levelLabel = (level) => (level === null ? 'n/a' : `${level}/5`);
const coverage = (crit) =>
  crit.applicableApps === 0
    ? 'n/a'
    : `${crit.passingApps}/${crit.applicableApps}`;
const scoreLine = (rollup) =>
  `Level ${levelLabel(rollup.level)}, overall ${pct(rollup.overallScore)} (${rollup.summary.passed} passed, ${rollup.summary.failed} failed, ${rollup.summary.skipped} skipped of ${rollup.summary.total} criteria)`;

/**
 * The comparison printed for the user: both scores, each re-judge, then any
 * changed file no re-judge cites, so a criterion the re-judge skipped shows.
 */
export function renderComparison(baseline, merged, rejudged, changedFiles) {
  const before = computeRollup(baseline);
  const after = computeRollup(merged);
  const lines = [
    `Before: ${scoreLine(before)}`,
    `After:  ${scoreLine(after)}`,
    `Re-judged ${rejudged.size} of ${before.summary.total} criteria; the rest carry over from the baseline.`,
  ];
  baseline.categories.forEach((category, i) => {
    category.criteria.forEach((was, j) => {
      if (!rejudged.has(keyOf(category.name, was.name))) return;
      const now = merged.categories[i].criteria[j];
      lines.push(
        `- ${keyOf(category.name, was.name)}: ${coverage(was)} ${statusOf(was)} to ${coverage(now)} ${statusOf(now)}`,
      );
    });
  });
  const uncited = uncitedFiles(changedFiles, rejudged);
  if (uncited.length > 0) {
    lines.push(`Not cited by any re-judged criterion: ${uncited.join(', ')}`);
  }
  return lines.join('\n');
}

function readInput(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(`cannot read ${path}: ${err.message}`);
  }
}

function main() {
  const baselinePath = process.argv[2] ?? 'agent-readiness.json';
  const rejudgedPath = process.argv[3] ?? 'rejudged.json';
  const changedPath = process.argv[4] ?? 'changed-files.txt';
  const jsonPath = resolveOutputPath(AFTER_JSON);
  const reportPath = resolveOutputPath(AFTER_REPORT);

  const baseline = parseAssessment(readInput(baselinePath));
  const changedFiles = parseChangedFiles(readInput(changedPath));
  const rejudged = parseRejudged(
    readInput(rejudgedPath),
    baseline,
    changedFiles,
  );
  const merged = mergeAssessment(baseline, rejudged);
  // Re-validate, so a criterion left failing without an action fails like a
  // bad baseline.
  parseAssessment(JSON.stringify(merged));

  writeFileSync(jsonPath, `${JSON.stringify(merged, null, 2)}\n`);
  writeFileSync(
    reportPath,
    renderReport(merged, computeRollup(merged), new Date().toISOString()),
  );
  console.log(renderComparison(baseline, merged, rejudged, changedFiles));
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
    console.error(`rescore: ${err.message}`);
    process.exit(1);
  }
}
