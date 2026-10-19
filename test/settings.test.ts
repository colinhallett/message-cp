import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agentFromEnv, getAgent } from "../src/agents.js";
import { OWNER_ACCOUNT, dbPath, openDb } from "../src/db.js";
import { homeFile, setting } from "../src/settings.js";

describe("setting", () => {
  it("reads MESSAGE_CP_<name>, and nothing else", () => {
    expect(setting("DB", { MESSAGE_CP_DB: "/new" })).toBe("/new");
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
    expect(dbPath({ MESSAGE_CP_DB: "/new/db.sqlite" })).toBe("/new/db.sqlite");
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
});
