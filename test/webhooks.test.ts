import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { addAccount } from "../src/accounts.js";
import { registerWithIdentity, removeAgent } from "../src/agents.js";
import { post } from "../src/channels.js";
import { OWNER_ACCOUNT, openDb, type AccountId, type Db } from "../src/db.js";
import { sendMessage } from "../src/messages.js";
import { WebhookError, addWebhook, deliveryBody, listWebhooks, removeWebhook, webhookOn, webhookUrl } from "../src/webhooks.js";

// Webhooks for the owner's account and a friend's, managed only with `message-cp webhook`. Deliveries are queued but
// nothing sends them yet.
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
    // new URL() writes these loopback forms as 127.0.0.1 before the check, so they are stored as that.
    expect(webhookUrl("http://127.1/hook")).toBe("http://127.0.0.1/hook");
    expect(webhookUrl("http://2130706433/hook")).toBe("http://127.0.0.1/hook");
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
    expect(webhookOn("#all")).toEqual({ event: "channel", name: "all" });
  });

  it("refuses anything else", () => {
    for (const on of ["general", "#", "mention:", "agent:", "#a b", "#a\n", "channel:x", "agent:" + "x".repeat(33), "@alice", "Agent:x", "mention:all", "agent:all", "agent:ALL"]) {
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

describe("queued deliveries", () => {
  let friend: AccountId;
  beforeEach(() => {
    friend = (db.prepare("SELECT id FROM accounts WHERE name = 'friend'").get() as { id: number }).id;
  });

  /** `name` registered in `account`, as `post` takes it. */
  const member = (account: AccountId, name: string) => ({ ...registerWithIdentity(db, account, name, "x").identity, name });

  /** Every queued delivery, oldest first, as its webhook id and body. */
  const queued = () =>
    (db.prepare("SELECT id, webhook_id FROM webhook_deliveries ORDER BY id").all() as { id: number; webhook_id: number }[]).map((d) => ({
      webhook: d.webhook_id,
      body: deliveryBody(db, d.id),
    }));

  it("queues a direct message for the recipient's agent: webhook, with the recipient, sender, time and text", () => {
    member(OWNER_ACCOUNT, "alice");
    member(OWNER_ACCOUNT, "bob");
    const hook = addWebhook(db, "owner", "https://example.com/", "agent:bob", true);
    addWebhook(db, "owner", "https://example.com/", "agent:alice", true);
    expect(sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "hello bob")).toEqual({ delivered: 1, recipients: ["bob"] });
    const sentAt = new Date((db.prepare("SELECT created_at FROM messages").get() as { created_at: number }).created_at).toISOString();
    expect(queued()).toEqual([{ webhook: hook.id, body: { event: "agent", recipient: "bob", sender: "alice", sentAt, text: "hello bob" } }]);
    expect(JSON.stringify(queued())).not.toContain(hook.secret);
  });

  it("queues a post for the channel's #channel webhook and for the mention: webhook of each agent it mentions", () => {
    const alice = member(OWNER_ACCOUNT, "alice");
    member(OWNER_ACCOUNT, "bob");
    member(OWNER_ACCOUNT, "carol");
    const channel = addWebhook(db, "owner", "https://example.com/", "#general", true);
    const bob = addWebhook(db, "owner", "https://example.com/", "mention:bob", true);
    addWebhook(db, "owner", "https://example.com/", "#other", true);
    addWebhook(db, "owner", "https://example.com/", "mention:carol", true);
    const { sentAt } = post(db, OWNER_ACCOUNT, alice, "general", "@bob look");
    const body = { channel: "general", sender: "alice", sentAt, text: "@bob look" };
    expect(queued()).toEqual([
      { webhook: channel.id, body: { event: "channel", ...body } },
      { webhook: bob.id, body: { event: "mention", ...body } },
    ]);
  });

  it("matches names without case, and gives two webhooks with the same --on a delivery each", () => {
    const alice = member(OWNER_ACCOUNT, "Alice");
    member(OWNER_ACCOUNT, "Bob");
    const hooks = [
      addWebhook(db, "owner", "https://example.com/", "agent:BOB", true),
      addWebhook(db, "owner", "https://example.com/", "agent:bob", true),
      addWebhook(db, "owner", "https://example.com/", "#GENERAL", true),
      addWebhook(db, "owner", "https://example.com/", "mention:bOb", true),
    ];
    sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "dm");
    post(db, OWNER_ACCOUNT, alice, "General", "@BOB hi");
    expect(queued().map((d) => [d.webhook, d.body?.event])).toEqual([
      [hooks[0]!.id, "agent"],
      [hooks[1]!.id, "agent"],
      [hooks[2]!.id, "channel"],
      [hooks[3]!.id, "mention"],
    ]);
    expect(queued()[0]!.body).toMatchObject({ recipient: "Bob" });
    expect(queued()[2]!.body).toMatchObject({ channel: "General" });
  });

  it("counts a broadcast as one message per recipient, queuing only for the recipient with a webhook", () => {
    member(OWNER_ACCOUNT, "alice");
    member(OWNER_ACCOUNT, "bob");
    member(OWNER_ACCOUNT, "carol");
    const hook = addWebhook(db, "owner", "https://example.com/", "agent:bob", true);
    addWebhook(db, "owner", "https://example.com/", "agent:alice", true);
    expect(sendMessage(db, OWNER_ACCOUNT, "alice", "all", "to everyone").delivered).toBe(2);
    expect(queued()).toEqual([{ webhook: hook.id, body: expect.objectContaining({ event: "agent", recipient: "bob", text: "to everyone" }) }]);
  });

  it("leaves the text out for a webhook added with --no-text", () => {
    const alice = member(OWNER_ACCOUNT, "alice");
    member(OWNER_ACCOUNT, "bob");
    addWebhook(db, "owner", "https://example.com/", "agent:bob", false);
    addWebhook(db, "owner", "https://example.com/", "#general", false);
    sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "secret plans");
    post(db, OWNER_ACCOUNT, alice, "general", "more plans");
    const bodies = queued().map((d) => d.body!);
    expect(bodies.map((b) => Object.keys(b).sort())).toEqual([
      ["event", "recipient", "sender", "sentAt"],
      ["channel", "event", "sender", "sentAt"],
    ]);
    expect(JSON.stringify(bodies)).not.toContain("plans");
  });

  it("queues nothing for the poster mentioning themselves, a removed agent or a name that is no agent", () => {
    const alice = member(OWNER_ACCOUNT, "alice");
    const bob = registerWithIdentity(db, OWNER_ACCOUNT, "bob", "x").identity;
    removeAgent(db, OWNER_ACCOUNT, "bob", undefined, bob);
    for (const on of ["mention:alice", "mention:bob", "mention:nobody"]) addWebhook(db, "owner", "https://example.com/", on, true);
    post(db, OWNER_ACCOUNT, alice, "general", "@alice @bob @nobody");
    expect(queued()).toEqual([]);
  });

  it("removes a webhook's queued deliveries with it", () => {
    member(OWNER_ACCOUNT, "alice");
    member(OWNER_ACCOUNT, "bob");
    const gone = addWebhook(db, "owner", "https://example.com/", "agent:bob", true);
    const kept = addWebhook(db, "owner", "https://example.com/", "agent:bob", true);
    sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "hi");
    expect(removeWebhook(db, gone.id)).toBe("owner");
    expect(queued().map((d) => d.webhook)).toEqual([kept.id]);
  });

  it("never queues a delivery for another account's webhook, even with the same agent and channel names", () => {
    const ownerAlice = member(OWNER_ACCOUNT, "alice");
    member(OWNER_ACCOUNT, "bob");
    const friendAlice = member(friend, "alice");
    member(friend, "bob");
    const owner = ["agent:bob", "#general", "mention:bob"].map((on) => addWebhook(db, "owner", "https://example.com/", on, true).id);
    const theirs = ["agent:bob", "#general", "mention:bob"].map((on) => addWebhook(db, "friend", "https://example.com/", on, true).id);

    sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "owner dm");
    sendMessage(db, OWNER_ACCOUNT, "alice", "all", "owner all");
    post(db, OWNER_ACCOUNT, ownerAlice, "general", "@bob owner post");
    expect(queued().map((d) => d.webhook)).toEqual([owner[0], owner[0], owner[1], owner[2]]);

    db.exec("DELETE FROM webhook_deliveries");
    sendMessage(db, friend, "alice", "bob", "friend dm");
    post(db, friend, friendAlice, "general", "@bob friend post");
    expect(queued().map((d) => d.webhook)).toEqual([theirs[0], theirs[1], theirs[2]]);
    expect(JSON.stringify(queued())).not.toContain("owner");

    // A name that is an agent only in the owner's account queues nothing for a post in the friend's.
    db.exec("DELETE FROM webhook_deliveries");
    member(OWNER_ACCOUNT, "carol");
    addWebhook(db, "owner", "https://example.com/", "mention:carol", true);
    addWebhook(db, "friend", "https://example.com/", "mention:carol", true);
    post(db, friend, friendAlice, "random", "@carol are you there");
    expect(queued()).toEqual([]);
  });

  it("names a recipient removed after the message was queued as it was when sent", () => {
    member(OWNER_ACCOUNT, "alice");
    const bob = registerWithIdentity(db, OWNER_ACCOUNT, "bob", "x").identity;
    addWebhook(db, "owner", "https://example.com/", "agent:bob", true);
    sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "hi");
    removeAgent(db, OWNER_ACCOUNT, "bob", undefined, bob);
    expect(queued()[0]!.body).toMatchObject({ event: "agent", recipient: "bob", sender: "alice" });
  });

  it("refuses a row for both or neither of a message and a post", () => {
    const alice = member(OWNER_ACCOUNT, "alice");
    member(OWNER_ACCOUNT, "bob");
    const hook = addWebhook(db, "owner", "https://example.com/", "#general", true);
    sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "hi");
    const { id: postId } = post(db, OWNER_ACCOUNT, alice, "general", "hi");
    const { id: messageId } = db.prepare("SELECT id FROM messages").get() as { id: number };
    const insert = db.prepare("INSERT INTO webhook_deliveries (webhook_id, message_id, post_id, created_at) VALUES (?, ?, ?, 0)");
    expect(() => insert.run(hook.id, messageId, postId)).toThrow(/CHECK/);
    expect(() => insert.run(hook.id, null, null)).toThrow(/CHECK/);
    expect(deliveryBody(db, 999)).toBeUndefined();
  });

  it("finds an account's webhooks for an event and name through an index, without case", () => {
    const plan = db
      .prepare("EXPLAIN QUERY PLAN SELECT id FROM webhooks WHERE account_id = ? AND event = 'agent' AND name = ? COLLATE NOCASE")
      .all(OWNER_ACCOUNT, "Bob") as { detail: string }[];
    expect(plan.map((p) => p.detail).join("\n")).toMatch(/USING COVERING INDEX webhooks_by_name \(account_id=\? AND event=\? AND name=\?\)/);
  });

  it("gives an existing database the table on open", () => {
    db.close();
    const raw = new Database(dbFile);
    raw.exec("DROP TABLE webhook_deliveries");
    raw.close();
    db = openDb(dbFile);
    member(OWNER_ACCOUNT, "alice");
    member(OWNER_ACCOUNT, "bob");
    addWebhook(db, "owner", "https://example.com/", "agent:bob", true);
    sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "hi");
    expect(queued()).toHaveLength(1);
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
