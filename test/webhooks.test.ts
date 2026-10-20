import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { addAccount } from "../src/accounts.js";
import { openDb, type Db } from "../src/db.js";
import { WebhookError, addWebhook, listWebhooks, removeWebhook, webhookOn, webhookUrl } from "../src/webhooks.js";

// Webhooks for the owner's account and a friend's, managed only with `message-cp webhook`. Nothing is delivered yet.
let dbFile: string;
let db: Db;

beforeEach(() => {
  dbFile = join(mkdtempSync(join(tmpdir(), "message-cp-webhooks-")), "db.sqlite");
  db = openDb(dbFile);
  addAccount(db, "friend");
  return () => db.close();
});

const REFUSED = ["http://localhost@evil/", "https://@/", "https://h/?x=/o/", "https://h/#/o/", "http://localhost/", "http://example.com/"];

describe("webhookUrl", () => {
  it("accepts https and http to a literal loopback address, as new URL() writes them", () => {
    expect(webhookUrl("https://example.com/hook")).toBe("https://example.com/hook");
    expect(webhookUrl("http://127.0.0.1:9000/hook")).toBe("http://127.0.0.1:9000/hook");
    expect(webhookUrl("http://[::1]/hook")).toBe("http://[::1]/hook");
    expect(webhookUrl("HTTPS://Example.COM")).toBe("https://example.com/");
  });

  it.each(REFUSED)("refuses %s without repeating it", (url) => {
    expect(() => webhookUrl(url)).toThrow(WebhookError);
    try {
      webhookUrl(url);
    } catch (err) {
      expect((err as Error).message).not.toContain(url);
    }
  });

  it("refuses other schemes, credentials and relative URLs", () => {
    for (const url of ["ftp://example.com/", "https://u:p@example.com/", "https://:p@example.com/", "/hook", "example.com", "http://127.0.0.1.evil/"]) {
      expect(() => webhookUrl(url), url).toThrow(WebhookError);
    }
  });

  it("drops a bare ? or #, which carry nothing", () => {
    expect(webhookUrl("https://example.com/hook?")).toBe("https://example.com/hook");
    expect(webhookUrl("https://example.com/hook#")).toBe("https://example.com/hook");
  });
});

describe("webhookOn", () => {
  it("parses the three forms", () => {
    expect(webhookOn("#general")).toEqual({ event: "channel", name: "general" });
    expect(webhookOn("mention:alice")).toEqual({ event: "mention", name: "alice" });
    expect(webhookOn("agent:bob_2")).toEqual({ event: "agent", name: "bob_2" });
  });

  it("refuses anything else", () => {
    for (const on of ["general", "#", "mention:", "agent:", "#a b", "#a\n", "channel:x", "agent:" + "x".repeat(33), "@alice", "Agent:x"]) {
      expect(() => webhookOn(on), on).toThrow(WebhookError);
    }
  });
});

describe("addWebhook, listWebhooks and removeWebhook", () => {
  it("keeps each account's webhooks apart", () => {
    const mine = addWebhook(db, "owner", "https://example.com/a", "#general", true);
    const theirs = addWebhook(db, "friend", "https://example.com/b", "mention:alice", false);
    expect(mine).toMatchObject({ account: "owner", url: "https://example.com/a", event: "channel", name: "general", includeText: true });
    expect(theirs).toMatchObject({ account: "friend", event: "mention", name: "alice", includeText: false });
    expect(mine.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(theirs.secret).not.toBe(mine.secret);

    expect(listWebhooks(db, "owner").map((w) => w.id)).toEqual([mine.id]);
    expect(listWebhooks(db, "friend").map((w) => w.id)).toEqual([theirs.id]);
    expect(listWebhooks(db).map((w) => w.account)).toEqual(["owner", "friend"]);
    expect(JSON.stringify(listWebhooks(db))).not.toContain(mine.secret);

    expect(removeWebhook(db, theirs.id)).toBe("friend");
    expect(listWebhooks(db, "friend")).toEqual([]);
    expect(listWebhooks(db, "owner").map((w) => w.id)).toEqual([mine.id]);
    expect(() => removeWebhook(db, theirs.id)).toThrow(`No webhook with id ${theirs.id}.`);
  });

  it("stores the secret, the URL as new URL() writes it and the account", () => {
    const w = addWebhook(db, "friend", "https://Example.com", "agent:bob", true);
    expect(db.prepare("SELECT * FROM webhooks").get()).toMatchObject({
      url: "https://example.com/",
      event: "agent",
      name: "bob",
      include_text: 1,
      secret: w.secret,
    });
  });

  it("refuses an unknown account, a bad URL or a bad --on and stores nothing", () => {
    expect(() => addWebhook(db, "nobody", "https://example.com/", "#x", true)).toThrow("No account named 'nobody'.");
    expect(() => addWebhook(db, "owner", "http://example.com/", "#x", true)).toThrow(WebhookError);
    expect(() => addWebhook(db, "owner", "https://example.com/", "x", true)).toThrow(WebhookError);
    expect(() => listWebhooks(db, "nobody")).toThrow("No account named 'nobody'.");
    expect(listWebhooks(db)).toEqual([]);
  });

  it("gives an existing database the table on open", () => {
    db.close();
    const raw = new Database(dbFile);
    raw.exec("DROP TABLE webhooks");
    raw.close();
    db = openDb(dbFile);
    expect(addWebhook(db, "owner", "https://example.com/", "#x", true).id).toBe(1);
  });
});

describe("message-cp webhook", () => {
  const root = resolve(import.meta.dirname, "..");
  const cli = (...args: string[]) =>
    spawnSync(join(root, "node_modules/.bin/tsx"), [join(root, "src/cli.ts"), ...args], {
      env: { ...process.env, MESSAGE_CP_DB: dbFile },
      encoding: "utf8",
    });

  it("adds, lists and removes webhooks of two accounts separately", () => {
    const owner = cli("webhook", "add", "--on", "#general", "--url", "https://example.com/hook");
    expect(owner.status).toBe(0);
    expect(owner.stderr).toContain("webhook 1 for account 'owner'");
    const secret = owner.stdout.trim();
    expect(secret).toMatch(/^[0-9a-f]{64}$/);

    const friend = cli("webhook", "add", "--no-text", "--account", "friend", "--url", "http://127.0.0.1:9000/hook", "--on", "mention:alice");
    expect(friend.status).toBe(0);
    expect(friend.stderr).toContain("webhook 2 for account 'friend'");
    expect(cli("webhook", "add", "--account", "friend", "--url", "https://example.com/dm", "--on", "agent:bob").status).toBe(0);

    const all = cli("webhook", "list");
    expect(all.status).toBe(0);
    expect(all.stdout.trim().split("\n")).toEqual([
      "1\towner\thttps://example.com/hook\t#general\ttext",
      "2\tfriend\thttp://127.0.0.1:9000/hook\tmention:alice\tno text",
      "3\tfriend\thttps://example.com/dm\tagent:bob\ttext",
    ]);
    expect(all.stdout + all.stderr).not.toContain(secret);
    expect(cli("webhook", "list", "--account", "owner").stdout).toBe("1\towner\thttps://example.com/hook\t#general\ttext\n");
    expect(cli("webhook", "list", "--account", "friend").stdout.trim().split("\n")).toHaveLength(2);

    const removed = cli("webhook", "remove", "2");
    expect(removed.status).toBe(0);
    expect(removed.stderr).toContain("removed webhook 2 of account 'friend'");
    expect(removed.stdout).toBe("");
    expect(cli("webhook", "list", "--account", "friend").stdout).toBe("3\tfriend\thttps://example.com/dm\tagent:bob\ttext\n");
    expect(cli("webhook", "list", "--account", "owner").stdout).toBe("1\towner\thttps://example.com/hook\t#general\ttext\n");
  }, 60_000);

  it("refuses each bad URL with exit 1, without echoing it", () => {
    for (const url of REFUSED) {
      const res = cli("webhook", "add", "--url", url, "--on", "#general");
      expect(res.status, url).toBe(1);
      expect(res.stdout).toBe("");
      expect(res.stderr).not.toContain(url);
    }
    expect(cli("webhook", "list").stdout).toBe("");
  }, 60_000);

  it("exits 1 for a bad --on or an unknown account, and for an unknown webhook id", () => {
    expect(cli("webhook", "add", "--url", "https://example.com/", "--on", "general").status).toBe(1);
    const nobody = cli("webhook", "add", "--url", "https://example.com/", "--on", "#x", "--account", "nobody");
    expect(nobody.status).toBe(1);
    expect(nobody.stderr).toContain("No account named 'nobody'.");
    expect(cli("webhook", "list", "--account", "nobody").status).toBe(1);
    expect(cli("webhook", "remove", "99").status).toBe(1);
  }, 60_000);

  it("prints the usage line and exits 2 for a missing, unknown, repeated or empty flag", () => {
    for (const args of [
      ["webhook"],
      ["webhook", "add", "--url", "https://example.com/"],
      ["webhook", "add", "--on", "#x"],
      ["webhook", "add", "--url", "https://example.com/", "--on", "#x", "--secret", "s"],
      ["webhook", "add", "--url", "https://example.com/", "--url", "https://example.com/", "--on", "#x"],
      ["webhook", "add", "--url", "https://example.com/", "--on", "#x", "--no-text", "--no-text"],
      ["webhook", "add", "--url", "https://example.com/", "--on"],
      ["webhook", "add", "--url", "--on", "#x"],
      ["webhook", "add", "--url", "", "--on", "#x"],
      ["webhook", "list", "--no-text"],
      ["webhook", "list", "--account"],
      ["webhook", "list", "extra"],
      ["webhook", "remove"],
      ["webhook", "remove", "x"],
      ["webhook", "remove", "1", "2"],
      ["webhook", "change", "1"],
    ]) {
      const res = cli(...args);
      expect(res.status, args.join(" ")).toBe(2);
      expect(res.stderr).toContain("usage: message-cp webhook add");
    }
    expect(cli("webhook", "list").stdout).toBe("");
  }, 120_000);

  it("is listed among the commands", () => {
    expect(cli("nope").stderr).toContain("Commands: serve, wait, account, token, webhook");
  }, 30_000);
});
