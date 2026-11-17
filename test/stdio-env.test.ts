import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

const testDir = import.meta.dirname;

// `registerFromEnv` in `src/agents.ts` refuses MESSAGE_CP_AGENT without MESSAGE_CP_AGENT_KEY and the other way round,
// so a stdio child that inherits a shell's lone MESSAGE_CP_AGENT_KEY (one set up for HTTP init) exits before the test starts.
// Each launch of `src/index.ts` either destructures both names out of `process.env`, as test/version.test.ts does,
// or sets both in the object it spreads `process.env` into, as proveServer's test in test/init.test.ts does.
// Each launch needs its own such line within NEAR lines of it, so one isolated launch cannot vouch for another in the same file.
const DROPS_BOTH = /\{\s*MESSAGE_CP_AGENT\s*:\s*\w+\s*,\s*MESSAGE_CP_AGENT_KEY\s*:\s*\w+\s*,\s*\.\.\.\w+\s*\}\s*=\s*process\.env\b/g;
const SETS_BOTH = /\{\s*\.\.\.process\.env\b[^}]*\bMESSAGE_CP_AGENT\s*:[^}]*\bMESSAGE_CP_AGENT_KEY\s*:/g;
const NEAR = 10;

const lineOf = (source: string, index: number) => source.slice(0, index).split("\n").length;
const linesOf = (source: string, re: RegExp) => [...source.matchAll(re)].map((m) => lineOf(source, m.index));

const stdioTests = readdirSync(testDir)
  .filter((f) => f.endsWith(".test.ts") && f !== "stdio-env.test.ts")
  .sort()
  .filter((f) => readFileSync(join(testDir, f), "utf8").includes("src/index.ts"));

it("finds the tests that start the stdio server", () => {
  expect(stdioTests.length).toBeGreaterThan(0);
});

it.each(stdioTests)("test/%s keeps the shell's MESSAGE_CP_AGENT and MESSAGE_CP_AGENT_KEY from its stdio child", (file) => {
  const source = readFileSync(join(testDir, file), "utf8");
  const unused = [...linesOf(source, DROPS_BOTH), ...linesOf(source, SETS_BOTH)];
  const unisolated = linesOf(source, /src\/index\.ts/g).filter((launch) => {
    const i = unused.findIndex((line) => Math.abs(line - launch) <= NEAR);
    if (i === -1) return true;
    unused.splice(i, 1);
    return false;
  });
  expect(
    unisolated,
    `test/${file} starts src/index.ts at line ${unisolated.join(", ")} without destructuring MESSAGE_CP_AGENT and MESSAGE_CP_AGENT_KEY ` +
      `out of process.env or setting both in the child's env within ${NEAR} lines: registerFromEnv in src/agents.ts refuses one without the other, ` +
      `so a child that inherits a shell's lone MESSAGE_CP_AGENT_KEY exits before the test starts`,
  ).toEqual([]);
});
