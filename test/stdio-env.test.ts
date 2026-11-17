import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

const testDir = import.meta.dirname;

// `registerFromEnv` in `src/agents.ts` refuses MESSAGE_CP_AGENT without MESSAGE_CP_AGENT_KEY and the other way round,
// so a stdio child that inherits a shell's lone MESSAGE_CP_AGENT_KEY (one set up for HTTP init) exits before the test starts.
// A test file that starts `src/index.ts` either destructures both names out of `process.env`, as test/version.test.ts does,
// or sets both in the object it spreads `process.env` into, as proveServer's test in test/init.test.ts does.
const DROPS_BOTH = /\{\s*MESSAGE_CP_AGENT\s*:\s*\w+\s*,\s*MESSAGE_CP_AGENT_KEY\s*:\s*\w+\s*,\s*\.\.\.\w+\s*\}\s*=\s*process\.env\b/;
const SETS_BOTH = /\{\s*\.\.\.process\.env\b[^}]*\bMESSAGE_CP_AGENT\s*:[^}]*\bMESSAGE_CP_AGENT_KEY\s*:/;

const stdioTests = readdirSync(testDir)
  .filter((f) => f.endsWith(".test.ts") && f !== "stdio-env.test.ts")
  .sort()
  .filter((f) => readFileSync(join(testDir, f), "utf8").includes("src/index.ts"));

it("finds the tests that start the stdio server", () => {
  expect(stdioTests.length).toBeGreaterThan(0);
});

it.each(stdioTests)("test/%s keeps the shell's MESSAGE_CP_AGENT and MESSAGE_CP_AGENT_KEY from its stdio child", (file) => {
  const source = readFileSync(join(testDir, file), "utf8");
  expect(
    DROPS_BOTH.test(source) || SETS_BOTH.test(source),
    `test/${file} starts src/index.ts but neither destructures MESSAGE_CP_AGENT and MESSAGE_CP_AGENT_KEY out of process.env ` +
      `nor sets both in the child's env: registerFromEnv in src/agents.ts refuses one without the other, ` +
      `so a child that inherits a shell's lone MESSAGE_CP_AGENT_KEY exits before the test starts`,
  ).toBe(true);
});
