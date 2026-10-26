import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agentFromEnv, getAgent } from "../src/agents.js";
import { OWNER_ACCOUNT, dbPath, openDb } from "../src/db.js";
import { homeFile, setting } from "../src/settings.js";

describe("setting", () => {
  it("reads MESSAGE_CP_<name>, and nothing else", () => {
    expect(setting("DB", { MESSAGE_CP_DB: "/db" })).toBe("/db");
    expect(setting("DB", { DB: "/other" })).toBeUndefined();
    expect(setting("DB", {})).toBeUndefined();
  });

  it("returns an empty value as set", () => {
    expect(setting("HTTP_TOKEN", { MESSAGE_CP_HTTP_TOKEN: "" })).toBe("");
  });
});

describe("homeFile", () => {
  it("is ~/.message-cp/<file>", () => {
    const h = mkdtempSync(join(tmpdir(), "message-cp-home-"));
    expect(homeFile("db.sqlite", h)).toBe(join(h, ".message-cp", "db.sqlite"));
  });
});

describe("environment", () => {
  it("dbPath reads MESSAGE_CP_DB", () => {
    expect(dbPath({ MESSAGE_CP_DB: "/srv/db.sqlite" })).toBe("/srv/db.sqlite");
  });

  it("agentFromEnv reads MESSAGE_CP_AGENT and MESSAGE_CP_AGENT_KEY", () => {
    const db = openDb(join(mkdtempSync(join(tmpdir(), "message-cp-env-")), "db.sqlite"));
    expect(agentFromEnv(db, OWNER_ACCOUNT, { MESSAGE_CP_AGENT: "worker", MESSAGE_CP_AGENT_KEY: "k" })).toBe("worker");
    expect(getAgent(db, OWNER_ACCOUNT, "worker")).toBeTruthy();
    db.close();
  });
});

describe("package", () => {
  it("installs the command as message-cp only", async () => {
    const { readFileSync } = await import("node:fs");
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8"));
    expect(pkg.name).toBe("message-cp");
    expect(pkg.bin).toEqual({ "message-cp": "dist/cli.js" });
  });

  it("packs only package.json, README.md, LICENSE and the built dist/", async () => {
    const { execFileSync } = await import("node:child_process");
    // prepack builds dist/ first, so the list does not depend on an earlier build.
    const out = execFileSync("npm", ["pack", "--dry-run", "--json"], { cwd: join(import.meta.dirname, ".."), encoding: "utf8" });
    const paths: string[] = JSON.parse(out.slice(out.indexOf("[")))[0].files.map((f: { path: string }) => f.path);
    expect(paths).toContain("dist/cli.js");
    expect(paths).toContain("dist/index.js");
    expect(paths.filter((p) => !p.startsWith("dist/")).sort()).toEqual(["LICENSE", "README.md", "package.json"]);
    expect(paths.every((p) => !/\.test\.|\.ts$/.test(p))).toBe(true);
  }, 60_000);
});
