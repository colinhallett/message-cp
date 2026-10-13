import { spawn } from "node:child_process";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";

const OPEN_DB = join(import.meta.dirname, "fixtures", "open-db.ts");

/** Starts `count` real processes that open `file` at the same instant; resolves to each one's exit code and stderr. */
function openTogether(file: string, count: number) {
  const startAt = String(Date.now() + 4000);
  return Promise.all(
    Array.from({ length: count }, () =>
      new Promise<{ code: number | null; stderr: string }>((resolve) => {
        const child = spawn(process.execPath, ["--import", "tsx", OPEN_DB], {
          env: { ...process.env, MEMORY_CP_DB: file, START_AT: startAt },
        });
        let stderr = "";
        child.stderr.on("data", (d) => (stderr += d));
        child.on("error", (err) => resolve({ code: null, stderr: `spawn failed: ${err.message}` }));
        child.on("exit", (code) => resolve({ code, stderr }));
      }),
    ),
  );
}

describe("openDb", () => {
  it("lets many processes open the same new file at once", async () => {
    for (let round = 0; round < 3; round++) {
      const file = join(mkdtempSync(join(tmpdir(), "memory-cp-")), "db.sqlite");
      const results = await openTogether(file, 40);
      expect(results.filter((r) => r.code !== 0).map((r) => r.stderr)).toEqual([]);

      const db = new Database(file, { readonly: true });
      expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
      db.close();
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
  }, 60_000);
});
