import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agentFromEnv, getAgent } from "../src/agents.js";
import { OWNER_ACCOUNT, dbPath, openDb } from "../src/db.js";
import { homeFile, setting } from "../src/settings.js";

// The rename to message-cp keeps every memory-cp name working: MEMORY_CP_* variables and ~/.memory-cp/ files.
describe("setting", () => {
  it("reads MESSAGE_CP_<name>, else the old MEMORY_CP_<name>", () => {
    expect(setting("DB", { MESSAGE_CP_DB: "/new" })).toBe("/new");
    expect(setting("DB", { MEMORY_CP_DB: "/old" })).toBe("/old");
    expect(setting("DB", {})).toBeUndefined();
  });

  it("prefers the new name when both are set, even when it is empty", () => {
    expect(setting("HTTP_TOKEN", { MESSAGE_CP_HTTP_TOKEN: "new", MEMORY_CP_HTTP_TOKEN: "old" })).toBe("new");
    expect(setting("HTTP_TOKEN", { MESSAGE_CP_HTTP_TOKEN: "", MEMORY_CP_HTTP_TOKEN: "old" })).toBe("");
  });
});

describe("homeFile", () => {
  const home = () => mkdtempSync(join(tmpdir(), "message-cp-home-"));
  const put = (dir: string, file: string) => {
    mkdirSync(join(dir, file, ".."), { recursive: true });
    writeFileSync(join(dir, file), "");
  };

  it("is ~/.message-cp/<file> on a fresh install", () => {
    const h = home();
    expect(homeFile("db.sqlite", h)).toBe(join(h, ".message-cp", "db.sqlite"));
  });

  it("is the old ~/.memory-cp/<file> where only that exists, left where it is", () => {
    const h = home();
    put(h, ".memory-cp/db.sqlite");
    expect(homeFile("db.sqlite", h)).toBe(join(h, ".memory-cp", "db.sqlite"));
    expect(existsSync(join(h, ".message-cp"))).toBe(false);
  });

  it("is the new file once it exists, even if the old one does too", () => {
    const h = home();
    put(h, ".memory-cp/db.sqlite");
    put(h, ".message-cp/db.sqlite");
    expect(homeFile("db.sqlite", h)).toBe(join(h, ".message-cp", "db.sqlite"));
  });
});

describe("old names", () => {
  it("dbPath reads MEMORY_CP_DB, and MESSAGE_CP_DB over it", () => {
    expect(dbPath({ MEMORY_CP_DB: "/old/db.sqlite" })).toBe("/old/db.sqlite");
    expect(dbPath({ MESSAGE_CP_DB: "/new/db.sqlite", MEMORY_CP_DB: "/old/db.sqlite" })).toBe("/new/db.sqlite");
  });

  it("agentFromEnv reads MEMORY_CP_AGENT and MEMORY_CP_AGENT_KEY, and the new names over them", () => {
    const db = openDb(join(mkdtempSync(join(tmpdir(), "message-cp-env-")), "db.sqlite"));
    expect(agentFromEnv(db, OWNER_ACCOUNT, { MEMORY_CP_AGENT: "old-worker", MEMORY_CP_AGENT_KEY: "k" })).toBe("old-worker");
    expect(
      agentFromEnv(db, OWNER_ACCOUNT, {
        MESSAGE_CP_AGENT: "new-worker",
        MESSAGE_CP_AGENT_KEY: "k2",
        MEMORY_CP_AGENT: "old-worker",
        MEMORY_CP_AGENT_KEY: "wrong",
      }),
    ).toBe("new-worker");
    expect(getAgent(db, OWNER_ACCOUNT, "new-worker")).toBeTruthy();
    db.close();
  });
});

describe("package", () => {
  it("installs the command as message-cp and keeps memory-cp as an alias of it", async () => {
    const { readFileSync } = await import("node:fs");
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8"));
    expect(pkg.name).toBe("message-cp");
    expect(pkg.bin).toEqual({ "message-cp": "dist/cli.js", "memory-cp": "dist/cli.js" });
  });
});
