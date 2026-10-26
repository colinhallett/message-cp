import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const script = join(resolve(import.meta.dirname, ".."), "ops/backup.sh");

/**
 * Runs ops/backup.sh with `url` in its URL file. A stand-in sqlite3 that always fails stops it at the snapshot, so an
 * accepted URL ends with "snapshot ... failed" and nothing is uploaded.
 */
function backup(url: string) {
  const dir = mkdtempSync(join(tmpdir(), "message-cp-backup-"));
  const bin = join(dir, "bin");
  spawnSync("mkdir", [bin]);
  writeFileSync(join(bin, "sqlite3"), "#!/bin/sh\nexit 1\n");
  chmodSync(join(bin, "sqlite3"), 0o755);
  writeFileSync(join(dir, "db.sqlite"), "");
  writeFileSync(join(dir, "url"), `${url}\n`);
  return spawnSync("bash", [script], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, MESSAGE_CP_DB: join(dir, "db.sqlite"), MESSAGE_CP_BACKUP_URL_FILE: join(dir, "url") },
    encoding: "utf8",
  });
}

describe("ops/backup.sh upload URL", () => {
  it.each([
    "http://localhost/o/",
    "http://localhost:8080/p/o/",
    "http://localhost@evil/o/",
    "https://@/o/",
    "https://h/?x=/o/",
    "https://h/#/o/",
    "https://user@h.example/o/",
    "http://example.com/o/",
    "http://10.0.0.1/o/",
    "https://h.example/p/o",
  ])("refuses %s without printing it", (url) => {
    const r = backup(url);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("must hold one https URL ending in /o/");
    expect(r.stderr).not.toContain(url);
  });

  it.each(["https://objectstorage.example.com/p/secret/n/ns/b/bucket/o/", "https://h.example:8443/o/", "http://127.0.0.1/o/", "http://127.0.0.1:8080/p/o/", "http://127.1.2.3:9/o/"])(
    "accepts %s",
    (url) => {
      const r = backup(url);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("snapshot of");
      expect(r.stderr).not.toContain("must hold");
    },
  );
});
