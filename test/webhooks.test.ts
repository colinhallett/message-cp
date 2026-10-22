import { spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createServer as createHttpServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { addAccount } from "../src/accounts.js";
import { registerWithIdentity, removeAgent } from "../src/agents.js";
import { post } from "../src/channels.js";
import { OWNER_ACCOUNT, openDb, type AccountId, type Db } from "../src/db.js";
import { startHttp } from "../src/http.js";
import { sendMessage } from "../src/messages.js";
import {
  WebhookError,
  addWebhook,
  deliveryBody,
  listAccountDeliveries,
  listWebhooks,
  removeWebhook,
  sendPending,
  WEBHOOK_MAX_BODY_BYTES,
  WEBHOOK_WINDOW_MS,
  webhookHeader,
  webhookBody,
  webhookMaxPerHour,
  webhookOn,
  webhookUrl,
  type NewWebhook,
} from "../src/webhooks.js";

// Webhooks for the owner's account and a friend's, managed only with `message-cp webhook`. Deliveries are queued when
// a message or post is stored and sent by `sendPending`, which `serve` runs on a timer.
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

const HEADER_VALUE = "Bearer s3cr3t-value";
/** Header lines `add` refuses, each with the value it must not repeat. */
const REFUSED_HEADERS = [
  `Authorization ${HEADER_VALUE}`,
  `Bad Name: ${HEADER_VALUE}`,
  `Auth(x): ${HEADER_VALUE}`,
  `: ${HEADER_VALUE}`,
  "Authorization:   \t ",
  `Authorization: ${HEADER_VALUE}\rX-Injected: 1`,
  `Authorization: ${HEADER_VALUE}\u0000`,
  `Authorization: ${HEADER_VALUE}\tx`,
  `Authorization: ${HEADER_VALUE}\u007f`,
  `Authorization: ${HEADER_VALUE}\u0085`,
  `Authorization: ${HEADER_VALUE}日本`,
  ...["Content-Type", "content-encoding", "Content-MD5", "content-digest", "Content-Language", "Digest", "repr-digest", "x-message-cp-signature", "CONTENT-LENGTH", "Host", "transfer-encoding", "Connection", "Keep-Alive", "upgrade", "Expect"].map((n) => `${n}: ${HEADER_VALUE}`),
];

describe("webhookHeader", () => {
  it("takes a token name and a trimmed value", () => {
    expect(webhookHeader(`Authorization: ${HEADER_VALUE}`)).toEqual({ name: "Authorization", value: HEADER_VALUE });
    expect(webhookHeader("X-Api-Key:a:b ")).toEqual({ name: "X-Api-Key", value: "a:b" });
    expect(webhookHeader("x!#$%&'*+-.^_`|~9:\t v \t")).toEqual({ name: "x!#$%&'*+-.^_`|~9", value: "v" });
    expect(webhookHeader("X-Name: café").value).toBe("café");
  });

  it("refuses each bad line without repeating the value", () => {
    for (const line of REFUSED_HEADERS) {
      expect(() => webhookHeader(line), JSON.stringify(line)).toThrow(WebhookError);
      try {
        webhookHeader(line);
      } catch (err) {
        expect((err as Error).message).not.toContain("s3cr3t");
      }
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
      header_name: null,
      header_value: null,
    });
    expect(w.headerName).toBeNull();
  });

  it("stores a header as given and lists only its name", () => {
    const w = addWebhook(db, "owner", "https://example.com/", "agent:bob", true, `Authorization: ${HEADER_VALUE}`);
    expect(w.headerName).toBe("Authorization");
    expect(db.prepare("SELECT header_name, header_value FROM webhooks").get()).toEqual({ header_name: "Authorization", header_value: HEADER_VALUE });
    expect(listWebhooks(db)).toEqual([expect.objectContaining({ id: w.id, headerName: "Authorization" })]);
    expect(JSON.stringify(listWebhooks(db))).not.toContain(HEADER_VALUE);
    expect(() => addWebhook(db, "owner", "https://example.com/", "agent:bob", true, "Host: evil")).toThrow(WebhookError);
    expect(listWebhooks(db)).toHaveLength(1);
  });

  it("refuses an unknown account, a bad URL or a bad --on and stores nothing", () => {
    expect(() => addWebhook(db, "nobody", "https://example.com/", "#x", true)).toThrow("No account named 'nobody'.");
    expect(() => addWebhook(db, "owner", "http://example.com/", "#x", true)).toThrow(WebhookError);
    expect(() => addWebhook(db, "owner", "https://example.com/", "x", true)).toThrow(WebhookError);
    expect(() => listWebhooks(db, "nobody")).toThrow("No account named 'nobody'.");
    expect(listWebhooks(db)).toEqual([]);
  });

  it("stores a limit, lists it, and refuses one that is not a whole number from 1 to 10000", () => {
    const w = addWebhook(db, "owner", "https://example.com/", "agent:bob", true, undefined, 10000);
    expect(w.maxPerHour).toBe(10000);
    expect(addWebhook(db, "owner", "https://example.com/", "agent:bob", true).maxPerHour).toBeNull();
    expect(listWebhooks(db).map((x) => x.maxPerHour)).toEqual([10000, null]);
    for (const bad of [0, -1, 1.5, 10001, NaN, Infinity]) {
      expect(() => addWebhook(db, "owner", "https://example.com/", "agent:bob", true, undefined, bad), String(bad)).toThrow(WebhookError);
    }
    expect(listWebhooks(db)).toHaveLength(2);
    expect(webhookMaxPerHour("1")).toBe(1);
    expect(webhookMaxPerHour("10000")).toBe(10000);
    for (const bad of ["0", "-1", "1.5", "10001", "abc", "", "+5", " 5", "1e3", "0x10", "99999999999999999999"]) {
      expect(() => webhookMaxPerHour(bad), JSON.stringify(bad)).toThrow(/Invalid --max-per-hour/);
    }
  });

  it("stores a fixed body as given and lists only that there is one", () => {
    const body = '{"requestId":"{{delivery}}","note":"wake"}';
    const w = addWebhook(db, "owner", "https://example.com/", "agent:bob", true, undefined, undefined, body);
    expect(w.fixedBody).toBe(true);
    expect(addWebhook(db, "owner", "https://example.com/", "agent:bob", true).fixedBody).toBe(false);
    expect(db.prepare("SELECT fixed_body FROM webhooks ORDER BY id").all()).toEqual([{ fixed_body: body }, { fixed_body: null }]);
    expect(listWebhooks(db).map((x) => x.fixedBody)).toEqual([true, false]);
    expect(JSON.stringify(listWebhooks(db))).not.toContain("requestId");
  });

  it("refuses a body that is not a JSON object, too long, without the placeholder once in a string value, or with --no-text", () => {
    const ok = ['{"requestId":"{{delivery}}"}', '{"a":{"b":["x-{{delivery}}-y"]},"n":1}', ` {"id":"{{delivery}}"} `];
    for (const body of ok) expect(webhookBody(body), body).toBe(body);
    const padded = `{"id":"{{delivery}}","pad":"${"x".repeat(WEBHOOK_MAX_BODY_BYTES - 30)}"}`;
    expect(Buffer.byteLength(padded)).toBe(WEBHOOK_MAX_BODY_BYTES);
    expect(webhookBody(padded)).toBe(padded);
    const bad = [
      "",
      "not json",
      '"{{delivery}}"',
      '["{{delivery}}"]',
      "null",
      "42",
      "{}",
      '{"id":"delivery"}',
      '{"id":"{{delivery}}","again":"{{delivery}}"}',
      '{"id":"{{delivery}}{{delivery}}"}',
      '{"{{delivery}}":"x"}',
      '{"{{delivery}}":"{{delivery}}"}',
      '{"id":"\\u007b{delivery}}"}',
      '{"id":"{{delivery}}","id":"\\u007b{delivery}}"}',
      '{"id":"{{delivery}}","id":"fixed"}',
      '{"a":{"b":"{{delivery}}"},"a":{"b":"fixed"}}',
      '{"id":"{{delivery}}","\\u007b{delivery}}":1}',
      `{"id":"{{delivery}}","pad":"${"x".repeat(WEBHOOK_MAX_BODY_BYTES - 29)}"}`,
      `{"id":"{{delivery}}","pad":"${"é".repeat(WEBHOOK_MAX_BODY_BYTES / 2)}"}`,
    ];
    for (const body of bad) {
      expect(() => webhookBody(body), body.slice(0, 60)).toThrow(/^Invalid --body/);
      expect(() => addWebhook(db, "owner", "https://example.com/", "agent:bob", true, undefined, undefined, body)).toThrow(WebhookError);
    }
    expect(() => addWebhook(db, "owner", "https://example.com/", "agent:bob", false, undefined, undefined, ok[0])).toThrow(/--no-text/);
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

  it("gives an existing webhooks table the header columns on open, its webhooks without a header", () => {
    const old = addWebhook(db, "owner", "https://example.com/", "#x", true);
    db.close();
    const raw = new Database(dbFile);
    raw.exec("ALTER TABLE webhooks DROP COLUMN header_name");
    raw.exec("ALTER TABLE webhooks DROP COLUMN header_value");
    raw.close();
    db = openDb(dbFile);
    expect(listWebhooks(db)).toEqual([expect.objectContaining({ id: old.id, headerName: null })]);
    addWebhook(db, "owner", "https://example.com/", "#x", true, `Authorization: ${HEADER_VALUE}`);
    expect(listWebhooks(db).map((w) => w.headerName)).toEqual([null, "Authorization"]);
  });

  it("gives an existing webhooks table the limit columns on open, its webhooks without a limit", () => {
    const old = addWebhook(db, "owner", "https://example.com/", "#x", true);
    db.close();
    const raw = new Database(dbFile);
    for (const column of ["max_per_hour", "window_started_at", "window_count"]) raw.exec(`ALTER TABLE webhooks DROP COLUMN ${column}`);
    raw.close();
    db = openDb(dbFile);
    expect(listWebhooks(db)).toEqual([expect.objectContaining({ id: old.id, maxPerHour: null })]);
    expect(db.prepare("SELECT max_per_hour, window_started_at, window_count FROM webhooks").get()).toEqual({
      max_per_hour: null,
      window_started_at: null,
      window_count: 0,
    });
    addWebhook(db, "owner", "https://example.com/", "#x", true, undefined, 3);
    expect(listWebhooks(db).map((w) => w.maxPerHour)).toEqual([null, 3]);
  });

  it("gives an existing webhooks table the fixed-body columns on open, its webhooks sending the event body", () => {
    const old = addWebhook(db, "owner", "https://example.com/", "#x", true);
    db.close();
    const raw = new Database(dbFile);
    raw.exec("ALTER TABLE webhooks DROP COLUMN fixed_body");
    raw.exec("ALTER TABLE webhook_deliveries DROP COLUMN delivery_uuid");
    raw.close();
    db = openDb(dbFile);
    expect(listWebhooks(db)).toEqual([expect.objectContaining({ id: old.id, fixedBody: false })]);
    expect(db.prepare("SELECT fixed_body FROM webhooks").get()).toEqual({ fixed_body: null });
    addWebhook(db, "owner", "https://example.com/", "#x", true, undefined, undefined, '{"id":"{{delivery}}"}');
    expect(listWebhooks(db).map((w) => w.fixedBody)).toEqual([false, true]);
    expect(db.prepare("PRAGMA table_info(webhook_deliveries)").all()).toContainEqual(expect.objectContaining({ name: "delivery_uuid" }));
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

describe("sendPending", () => {
  let friend: AccountId;
  /** Requests each receiver got, as headers and body text. */
  type Got = { headers: IncomingHttpHeaders; body: string; url: string };
  const servers: Server[] = [];
  beforeEach(() => {
    friend = (db.prepare("SELECT id FROM accounts WHERE name = 'friend'").get() as { id: number }).id;
    return async () => {
      for (const s of servers.splice(0)) {
        s.closeAllConnections();
        await new Promise((r) => s.close(r));
      }
    };
  });

  /** A receiver on 127.0.0.1 answering each request with `answer(n)`, n counting from 0; null never answers. */
  const receiver = async (answer: (n: number) => number | null = () => 200) => {
    const got: Got[] = [];
    const server = createHttpServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const status = answer(got.length);
        got.push({ headers: req.headers, body: Buffer.concat(chunks).toString("utf8"), url: req.url ?? "" });
        if (status === null) return;
        res.writeHead(status, status === 302 ? { Location: "/elsewhere" } : {});
        res.end();
      });
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    return { got, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook` };
  };

  const member = (account: AccountId, name: string) => ({ ...registerWithIdentity(db, account, name, "x").identity, name });
  const row = () => db.prepare("SELECT attempts, delivered_at FROM webhook_deliveries").get() as { attempts: number; delivered_at: number | null };
  const signature = (secret: string, body: string) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  /** Lets a retry be claimed without waiting out the in-flight guard. */
  const later = { timeoutMs: 1000 };
  const unclaim = () => db.prepare("UPDATE webhook_deliveries SET claimed_until = NULL").run();

  it("POSTs the body, signed with the webhook's secret, and marks it delivered", async () => {
    const r = await receiver();
    member(OWNER_ACCOUNT, "alice");
    member(OWNER_ACCOUNT, "bob");
    const hook = addWebhook(db, "owner", r.url, "agent:bob", true);
    sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "hello bob");
    expect(await sendPending(db)).toEqual({ delivered: 1, failed: 0 });
    expect(r.got).toHaveLength(1);
    const [got] = r.got;
    expect(got!.url).toBe("/hook");
    expect(got!.headers["content-type"]).toBe("application/json");
    expect(got!.body).toBe(JSON.stringify(deliveryBody(db, 1)));
    expect(JSON.parse(got!.body)).toMatchObject({ event: "agent", recipient: "bob", sender: "alice", text: "hello bob" });
    expect(got!.headers["x-message-cp-signature"]).toBe(signature(hook.secret, got!.body));
    expect(JSON.stringify(got)).not.toContain(hook.secret);
    expect(row()).toMatchObject({ attempts: 1, delivered_at: expect.any(Number) });
    expect(await sendPending(db)).toEqual({ delivered: 0, failed: 0 });
    expect(r.got).toHaveLength(1);
  });

  it("sends a webhook's header with its value beside its own, and no extra header for one without", async () => {
    const withHeader = await receiver();
    const without = await receiver();
    member(OWNER_ACCOUNT, "alice");
    member(OWNER_ACCOUNT, "bob");
    const hook = addWebhook(db, "owner", withHeader.url, "agent:bob", true, `Authorization: ${HEADER_VALUE}`);
    addWebhook(db, "owner", without.url, "agent:bob", true);
    sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "hello bob");
    expect(await sendPending(db)).toEqual({ delivered: 2, failed: 0 });
    const [got] = withHeader.got;
    expect(got!.headers.authorization).toBe(HEADER_VALUE);
    expect(got!.headers["content-type"]).toBe("application/json");
    expect(got!.headers["x-message-cp-signature"]).toBe(signature(hook.secret, got!.body));
    expect(got!.body).toBe(JSON.stringify(deliveryBody(db, 1)));
    expect(got!.body).not.toContain(HEADER_VALUE);
    const plain = without.got[0]!;
    expect(plain.headers.authorization).toBeUndefined();
    const names = (g: Got) => Object.keys(g.headers).sort();
    expect(names(got!)).toEqual([...names(plain), "authorization"].sort());
    // What GET /api/webhook-deliveries returns names neither the header nor its value.
    const listed = JSON.stringify(listAccountDeliveries(db, OWNER_ACCOUNT, 3, 50, 0));
    expect(listed).not.toContain(HEADER_VALUE);
    expect(listed.toLowerCase()).not.toContain("authorization");
  });

  it("never sends one account's webhook header with another account's deliveries", async () => {
    const mine = await receiver();
    const theirs = await receiver();
    member(OWNER_ACCOUNT, "alice");
    member(OWNER_ACCOUNT, "bob");
    member(friend, "alice");
    member(friend, "bob");
    addWebhook(db, "owner", mine.url, "agent:bob", true, `Authorization: ${HEADER_VALUE}`);
    addWebhook(db, "friend", theirs.url, "agent:bob", true);
    sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "owner dm");
    sendMessage(db, friend, "alice", "bob", "friend dm");
    expect(await sendPending(db)).toEqual({ delivered: 2, failed: 0 });
    expect(mine.got.map((g) => g.headers.authorization)).toEqual([HEADER_VALUE]);
    expect(theirs.got).toHaveLength(1);
    expect(JSON.stringify(theirs.got)).not.toContain(HEADER_VALUE);
    expect(theirs.got[0]!.headers.authorization).toBeUndefined();
  });

  it("leaves the text out for a webhook added with --no-text", async () => {
    const r = await receiver();
    const alice = member(OWNER_ACCOUNT, "alice");
    addWebhook(db, "owner", r.url, "#general", false);
    post(db, OWNER_ACCOUNT, alice, "general", "secret plans");
    await sendPending(db);
    expect(Object.keys(JSON.parse(r.got[0]!.body)).sort()).toEqual(["channel", "event", "sender", "sentAt"]);
    expect(r.got[0]!.body).not.toContain("plans");
  });

  it("retries a 500 on a later pass and then delivers", async () => {
    const r = await receiver((n) => (n === 0 ? 500 : 204));
    member(OWNER_ACCOUNT, "alice");
    member(OWNER_ACCOUNT, "bob");
    addWebhook(db, "owner", r.url, "agent:bob", true);
    sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "hi");
    expect(await sendPending(db, later)).toEqual({ delivered: 0, failed: 1 });
    expect(row()).toEqual({ attempts: 1, delivered_at: null });
    // The attempt just made may still be in flight for another sender, so it is not retried at once.
    expect(await sendPending(db, later)).toEqual({ delivered: 0, failed: 0 });
    unclaim();
    expect(await sendPending(db, later)).toEqual({ delivered: 1, failed: 0 });
    expect(row()).toMatchObject({ attempts: 2, delivered_at: expect.any(Number) });
    expect(r.got[1]!.body).toBe(r.got[0]!.body);
  });

  it("aborts a request the receiver never answers and counts it as failed", async () => {
    const r = await receiver(() => null);
    member(OWNER_ACCOUNT, "alice");
    member(OWNER_ACCOUNT, "bob");
    addWebhook(db, "owner", r.url, "agent:bob", true);
    sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "hi");
    const started = Date.now();
    expect(await sendPending(db, { timeoutMs: 200 })).toEqual({ delivered: 0, failed: 1 });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(r.got).toHaveLength(1);
    expect(row()).toEqual({ attempts: 1, delivered_at: null });
  });

  it("does not follow a 302, and counts it as failed", async () => {
    const r = await receiver((n) => (n === 0 ? 302 : 200));
    member(OWNER_ACCOUNT, "alice");
    member(OWNER_ACCOUNT, "bob");
    addWebhook(db, "owner", r.url, "agent:bob", true);
    sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "hi");
    expect(await sendPending(db)).toEqual({ delivered: 0, failed: 1 });
    expect(r.got.map((g) => g.url)).toEqual(["/hook"]);
    expect(row()).toEqual({ attempts: 1, delivered_at: null });
  });

  it("stops after 3 attempts in all, leaving the row undelivered", async () => {
    const r = await receiver(() => 503);
    member(OWNER_ACCOUNT, "alice");
    member(OWNER_ACCOUNT, "bob");
    addWebhook(db, "owner", r.url, "agent:bob", true);
    sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "hi");
    for (let i = 0; i < 5; i++) {
      await sendPending(db, later);
      unclaim();
    }
    expect(r.got).toHaveLength(3);
    expect(row()).toEqual({ attempts: 3, delivered_at: null });
  });

  it("uses up a row's attempts without a request when its stored URL no longer passes webhookUrl", async () => {
    const r = await receiver();
    member(OWNER_ACCOUNT, "alice");
    member(OWNER_ACCOUNT, "bob");
    const hook = addWebhook(db, "owner", r.url, "agent:bob", true);
    db.prepare("UPDATE webhooks SET url = ? WHERE id = ?").run(r.url.replace("127.0.0.1", "localhost"), hook.id);
    sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "hi");
    for (let i = 0; i < 3; i++) {
      expect(await sendPending(db, later)).toEqual({ delivered: 0, failed: 1 });
      unclaim();
    }
    expect(await sendPending(db, later)).toEqual({ delivered: 0, failed: 0 });
    expect(r.got).toHaveLength(0);
    expect(row()).toEqual({ attempts: 3, delivered_at: null });
  });

  it("never lets a second sender on the same file resend a claimed attempt", async () => {
    const r = await receiver(() => null);
    member(OWNER_ACCOUNT, "alice");
    member(OWNER_ACCOUNT, "bob");
    addWebhook(db, "owner", r.url, "agent:bob", true);
    sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "hi");
    const other = openDb(dbFile);
    try {
      const first = sendPending(db, { timeoutMs: 1000 });
      await vi.waitFor(() => expect(r.got).toHaveLength(1));
      // The first request is still waiting on the receiver.
      expect(await sendPending(other, { timeoutMs: 1000 })).toEqual({ delivered: 0, failed: 0 });
      expect(await first).toEqual({ delivered: 0, failed: 1 });
      expect(r.got).toHaveLength(1);
      expect(row()).toEqual({ attempts: 1, delivered_at: null });
    } finally {
      other.close();
    }
  });

  it("leaves a claim alone for as long as the claiming sender's own timeout allows, whatever the next sender's", async () => {
    const r = await receiver(() => 500);
    member(OWNER_ACCOUNT, "alice");
    member(OWNER_ACCOUNT, "bob");
    addWebhook(db, "owner", r.url, "agent:bob", true);
    sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "hi");
    const claimed = Date.now();
    expect(await sendPending(db, { timeoutMs: 30_000 })).toEqual({ delivered: 0, failed: 1 });
    const now = vi.spyOn(Date, "now");
    try {
      // Past twice the default timeout, but the first sender's request could still be in flight.
      now.mockReturnValue(claimed + 15_000);
      expect(await sendPending(db)).toEqual({ delivered: 0, failed: 0 });
      now.mockReturnValue(claimed + 61_000);
      expect(await sendPending(db)).toEqual({ delivered: 0, failed: 1 });
    } finally {
      now.mockRestore();
    }
    expect(r.got).toHaveLength(2);
  });

  it("refuses a batch, timeout or attempt count that is not a positive integer", async () => {
    for (const bad of [{ batch: -1 }, { batch: 0 }, { batch: 1.5 }, { batch: Infinity }, { timeoutMs: -1 }, { maxAttempts: NaN }]) {
      await expect(sendPending(db, bad), JSON.stringify(bad)).rejects.toThrow(/must be a positive integer/);
      await expect(startHttp(db, { token: "t", port: 0, webhookOptions: bad }), JSON.stringify(bad)).rejects.toThrow(/must be a positive integer/);
    }
  });

  it("sends each account's deliveries only to that account's own webhook", async () => {
    const mine = await receiver();
    const theirs = await receiver();
    const ownerAlice = member(OWNER_ACCOUNT, "alice");
    member(OWNER_ACCOUNT, "bob");
    const friendAlice = member(friend, "alice");
    member(friend, "bob");
    const ownerHooks = ["agent:bob", "#general"].map((on) => addWebhook(db, "owner", mine.url, on, true));
    const friendHooks = ["agent:bob", "#general"].map((on) => addWebhook(db, "friend", theirs.url, on, true));
    sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "owner dm");
    post(db, OWNER_ACCOUNT, ownerAlice, "general", "owner post");
    sendMessage(db, friend, "alice", "bob", "friend dm");
    post(db, friend, friendAlice, "general", "friend post");
    expect(await sendPending(db)).toEqual({ delivered: 4, failed: 0 });
    const texts = (got: Got[]) => got.map((g) => JSON.parse(g.body).text).sort();
    expect(texts(mine.got)).toEqual(["owner dm", "owner post"]);
    expect(texts(theirs.got)).toEqual(["friend dm", "friend post"]);
    const secrets = (hooks: NewWebhook[]) => hooks.map((h) => h.secret);
    for (const g of mine.got) expect(secrets(ownerHooks).map((s) => signature(s, g.body))).toContain(g.headers["x-message-cp-signature"]);
    for (const g of theirs.got) expect(secrets(friendHooks).map((s) => signature(s, g.body))).toContain(g.headers["x-message-cp-signature"]);
  });

  it("sends at most a batch per pass, oldest first", async () => {
    const r = await receiver();
    member(OWNER_ACCOUNT, "alice");
    member(OWNER_ACCOUNT, "bob");
    addWebhook(db, "owner", r.url, "agent:bob", true);
    for (let i = 0; i < 5; i++) sendMessage(db, OWNER_ACCOUNT, "alice", "bob", `m${i}`);
    expect(await sendPending(db, { batch: 3 })).toEqual({ delivered: 3, failed: 0 });
    expect(r.got.map((g) => JSON.parse(g.body).text).sort()).toEqual(["m0", "m1", "m2"]);
    expect(await sendPending(db, { batch: 3 })).toEqual({ delivered: 2, failed: 0 });
  });

  describe("with --body", () => {
    const BODY = '{"requestId":"msg-{{delivery}}","wake":true}';
    const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
    const sent = (g: Got) => JSON.parse(g.body) as { requestId: string; wake: boolean };
    const add = (url: string, header?: string, max?: number) => addWebhook(db, "owner", url, "agent:bob", true, header, max, BODY);

    beforeEach(() => {
      member(OWNER_ACCOUNT, "alice");
      member(OWNER_ACCOUNT, "bob");
    });

    it("POSTs the fixed body with the placeholder replaced, signed over those exact bytes, and none of the message", async () => {
      const r = await receiver();
      const hook = add(r.url);
      sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "hello bob");
      expect(await sendPending(db)).toEqual({ delivered: 1, failed: 0 });
      const [got] = r.got;
      expect(got!.body).toMatch(new RegExp(`^\\{"requestId":"msg-${UUID}","wake":true\\}$`));
      // Every character in Tessl's requestId set (A-Z a-z 0-9 . _ : @ / -), and within its 128.
      expect(sent(got!).requestId).toMatch(/^[A-Za-z0-9._:@/-]{1,128}$/);
      expect(got!.body).toBe(BODY.replace("{{delivery}}", sent(got!).requestId.slice(4)));
      expect(got!.headers["content-type"]).toBe("application/json");
      expect(got!.headers["x-message-cp-signature"]).toBe(signature(hook.secret, got!.body));
      for (const leak of ["hello", "alice", "bob"]) expect(got!.body).not.toContain(leak);
      expect(row()).toMatchObject({ attempts: 1, delivered_at: expect.any(Number) });
    });

    it("sends the same id on every retry of one delivery", async () => {
      const r = await receiver((n) => (n < 2 ? 500 : 200));
      add(r.url);
      sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "hi");
      expect(await sendPending(db, later)).toEqual({ delivered: 0, failed: 1 });
      unclaim();
      expect(await sendPending(db, later)).toEqual({ delivered: 0, failed: 1 });
      unclaim();
      expect(await sendPending(db, later)).toEqual({ delivered: 1, failed: 0 });
      expect(r.got).toHaveLength(3);
      expect(new Set(r.got.map((g) => g.body)).size).toBe(1);
    });

    it("sends a different id for each delivery, even after the rows with the highest ids are deleted and their ids reused", async () => {
      const r = await receiver();
      const hook = add(r.url);
      sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "one");
      sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "two");
      expect(await sendPending(db)).toEqual({ delivered: 2, failed: 0 });
      const ids = () => db.prepare("SELECT id FROM webhook_deliveries ORDER BY id").all();
      expect(ids()).toEqual([{ id: 1 }, { id: 2 }]);
      // Deleting the conversation cascades to its deliveries, so the next rows queued take ids 1 and 2 again.
      db.prepare("DELETE FROM messages").run();
      expect(ids()).toEqual([]);
      sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "three");
      sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "four");
      expect(ids()).toEqual([{ id: 1 }, { id: 2 }]);
      expect(await sendPending(db)).toEqual({ delivered: 2, failed: 0 });
      const requestIds = r.got.map((g) => sent(g).requestId);
      expect(requestIds).toHaveLength(4);
      expect(new Set(requestIds).size).toBe(4);
      for (const g of r.got) expect(g.headers["x-message-cp-signature"]).toBe(signature(hook.secret, g.body));
    });

    it("never gives a delivery that takes a deleted one's row id its id, or marks it delivered", async () => {
      // While the first request is in flight, its message is deleted and a new one queued takes the same row id.
      const r = await receiver((n) => {
        if (n === 0) {
          db.prepare("DELETE FROM messages").run();
          sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "two");
        }
        return 200;
      });
      add(r.url);
      sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "one");
      expect(await sendPending(db)).toEqual({ delivered: 0, failed: 0 });
      const replacement = () =>
        db.prepare("SELECT id, attempts, delivered_at, delivery_uuid FROM webhook_deliveries").all() as {
          id: number;
          attempts: number;
          delivered_at: number | null;
          delivery_uuid: string | null;
        }[];
      expect(replacement()).toEqual([{ id: 1, attempts: 0, delivered_at: null, delivery_uuid: null }]);
      expect(await sendPending(db)).toEqual({ delivered: 1, failed: 0 });
      expect(r.got).toHaveLength(2);
      expect(sent(r.got[1]!).requestId).not.toBe(sent(r.got[0]!).requestId);
      expect(replacement()[0]).toMatchObject({ attempts: 1, delivered_at: expect.any(Number), delivery_uuid: sent(r.got[1]!).requestId.slice(4) });
    });

    it("still sends the webhook's header and keeps to its limit", async () => {
      const r = await receiver();
      const hook = add(r.url, `Authorization: ${HEADER_VALUE}`, 1);
      sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "one");
      sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "two");
      expect(await sendPending(db)).toEqual({ delivered: 1, failed: 0 });
      expect(await sendPending(db)).toEqual({ delivered: 0, failed: 0 });
      expect(r.got).toHaveLength(1);
      expect(r.got[0]!.headers.authorization).toBe(HEADER_VALUE);
      expect(r.got[0]!.body).not.toContain(HEADER_VALUE);
      expect(r.got[0]!.headers["x-message-cp-signature"]).toBe(signature(hook.secret, r.got[0]!.body));
      db.prepare("UPDATE webhooks SET window_started_at = window_started_at - ? WHERE id = ?").run(WEBHOOK_WINDOW_MS, hook.id);
      expect(await sendPending(db)).toEqual({ delivered: 1, failed: 0 });
      expect(sent(r.got[1]!).requestId).not.toBe(sent(r.got[0]!).requestId);
    });

    it("sends the event body for a webhook without one beside it", async () => {
      const fixed = await receiver();
      const plain = await receiver();
      add(fixed.url);
      addWebhook(db, "owner", plain.url, "agent:bob", true);
      sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "hello bob");
      expect(await sendPending(db)).toEqual({ delivered: 2, failed: 0 });
      expect(fixed.got[0]!.body).toMatch(/^\{"requestId":"msg-/);
      const event = db.prepare("SELECT id FROM webhook_deliveries WHERE webhook_id = 2").get() as { id: number };
      expect(plain.got[0]!.body).toBe(JSON.stringify(deliveryBody(db, event.id)));
      expect(JSON.parse(plain.got[0]!.body)).toMatchObject({ event: "agent", recipient: "bob", sender: "alice", text: "hello bob" });
    });

    it("never sends one account's fixed body with another account's deliveries", async () => {
      const mine = await receiver();
      const theirs = await receiver();
      member(friend, "alice");
      member(friend, "bob");
      add(mine.url);
      addWebhook(db, "friend", theirs.url, "agent:bob", true);
      sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "owner dm");
      sendMessage(db, friend, "alice", "bob", "friend dm");
      expect(await sendPending(db)).toEqual({ delivered: 2, failed: 0 });
      expect(mine.got).toHaveLength(1);
      expect(theirs.got.map((g) => JSON.parse(g.body).text)).toEqual(["friend dm"]);
      expect(theirs.got[0]!.body).not.toContain("requestId");
    });
  });

  describe("with --max-per-hour", () => {
    const pending = () => listAccountDeliveries(db, OWNER_ACCOUNT, 3, 100, 0).filter((d) => d.status === "pending");
    const texts = (got: Got[]) => got.map((g) => JSON.parse(g.body).text);
    /** Moves the webhook's window back by a full window, as if an hour had passed. */
    const windowPasses = (id: number) => db.prepare("UPDATE webhooks SET window_started_at = window_started_at - ? WHERE id = ?").run(WEBHOOK_WINDOW_MS, id);

    beforeEach(() => {
      member(OWNER_ACCOUNT, "alice");
      member(OWNER_ACCOUNT, "bob");
      member(OWNER_ACCOUNT, "carol");
    });

    it("stops at the limit, leaving the rest pending with no attempt used, and sends them oldest first once the window passes", async () => {
      const r = await receiver();
      const hook = addWebhook(db, "owner", r.url, "agent:bob", true, undefined, 2);
      for (let i = 0; i < 5; i++) sendMessage(db, OWNER_ACCOUNT, "alice", "bob", `m${i}`);
      expect(await sendPending(db)).toEqual({ delivered: 2, failed: 0 });
      expect(await sendPending(db)).toEqual({ delivered: 0, failed: 0 });
      expect(texts(r.got).sort()).toEqual(["m0", "m1"]);
      expect(pending().map((d) => d.attempts)).toEqual([0, 0, 0]);

      // A window that has not quite ended still holds them.
      db.prepare("UPDATE webhooks SET window_started_at = ? WHERE id = ?").run(Date.now() - WEBHOOK_WINDOW_MS + 60_000, hook.id);
      expect(await sendPending(db)).toEqual({ delivered: 0, failed: 0 });

      windowPasses(hook.id);
      expect(await sendPending(db)).toEqual({ delivered: 2, failed: 0 });
      expect(texts(r.got).slice(2).sort()).toEqual(["m2", "m3"]);
      expect(pending()).toHaveLength(1);
      windowPasses(hook.id);
      expect(await sendPending(db)).toEqual({ delivered: 1, failed: 0 });
      expect(texts(r.got)[4]).toBe("m4");
    });

    it("counts each retry as a request", async () => {
      const r = await receiver(() => 500);
      const hook = addWebhook(db, "owner", r.url, "agent:bob", true, undefined, 2);
      sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "hi");
      expect(await sendPending(db, later)).toEqual({ delivered: 0, failed: 1 });
      unclaim();
      expect(await sendPending(db, later)).toEqual({ delivered: 0, failed: 1 });
      unclaim();
      expect(await sendPending(db, later)).toEqual({ delivered: 0, failed: 0 });
      expect(r.got).toHaveLength(2);
      expect(row()).toEqual({ attempts: 2, delivered_at: null });
      expect(pending()).toHaveLength(1);
      windowPasses(hook.id);
      expect(await sendPending(db, later)).toEqual({ delivered: 0, failed: 1 });
      expect(row()).toEqual({ attempts: 3, delivered_at: null });
    });

    it("never holds up another webhook's deliveries, even when the oldest rows are all the limited one's", async () => {
      const limited = await receiver();
      const other = await receiver();
      addWebhook(db, "owner", limited.url, "agent:bob", true, undefined, 1);
      addWebhook(db, "owner", other.url, "agent:carol", true);
      for (let i = 0; i < 5; i++) sendMessage(db, OWNER_ACCOUNT, "alice", "bob", `bob${i}`);
      for (let i = 0; i < 3; i++) sendMessage(db, OWNER_ACCOUNT, "alice", "carol", `carol${i}`);
      expect(await sendPending(db, { batch: 3 })).toEqual({ delivered: 3, failed: 0 });
      expect(texts(limited.got)).toEqual(["bob0"]);
      expect(texts(other.got).sort()).toEqual(["carol0", "carol1"]);
      expect(await sendPending(db, { batch: 3 })).toEqual({ delivered: 1, failed: 0 });
      expect(texts(other.got).sort()).toEqual(["carol0", "carol1", "carol2"]);
      expect(limited.got).toHaveLength(1);
    });

    it("reads only what each webhook may send, through an index, so a held backlog is not read on each pass", async () => {
      const plan = db
        .prepare(
          `EXPLAIN QUERY PLAN SELECT id, attempts FROM webhook_deliveries
           WHERE webhook_id = ? AND delivered_at IS NULL AND attempts < ? AND (claimed_until IS NULL OR claimed_until <= ?)
           ORDER BY id LIMIT ?`,
        )
        .all(1, 3, 0, 1) as { detail: string }[];
      const detail = plan.map((p) => p.detail).join("\n");
      expect(detail).toMatch(/USING INDEX webhook_deliveries_pending_by_webhook \(webhook_id=\? AND delivered_at=\?\)/);
      expect(detail).not.toMatch(/TEMP B-TREE/);

      const r = await receiver();
      const hook = addWebhook(db, "owner", r.url, "agent:bob", true, undefined, 1);
      for (let i = 0; i < 50; i++) sendMessage(db, OWNER_ACCOUNT, "alice", "bob", `m${i}`);
      expect(await sendPending(db)).toEqual({ delivered: 1, failed: 0 });
      expect(await sendPending(db)).toEqual({ delivered: 0, failed: 0 });
      expect(pending()).toHaveLength(49);
      windowPasses(hook.id);
      expect(await sendPending(db)).toEqual({ delivered: 1, failed: 0 });
      expect(texts(r.got)).toEqual(["m0", "m1"]);
    });

    it("keeps each webhook's allowance its own, across accounts with the same --on", async () => {
      const mine = await receiver();
      const theirs = await receiver();
      member(friend, "alice");
      member(friend, "bob");
      addWebhook(db, "owner", mine.url, "agent:bob", true, undefined, 1);
      addWebhook(db, "friend", theirs.url, "agent:bob", true, undefined, 2);
      for (let i = 0; i < 3; i++) {
        sendMessage(db, OWNER_ACCOUNT, "alice", "bob", `owner${i}`);
        sendMessage(db, friend, "alice", "bob", `friend${i}`);
      }
      expect(await sendPending(db)).toEqual({ delivered: 3, failed: 0 });
      expect(texts(mine.got)).toEqual(["owner0"]);
      expect(texts(theirs.got).sort()).toEqual(["friend0", "friend1"]);
    });

    it("never lets two senders on one file go past the limit together", async () => {
      const r = await receiver(() => null);
      addWebhook(db, "owner", r.url, "agent:bob", true, undefined, 6);
      for (let i = 0; i < 10; i++) sendMessage(db, OWNER_ACCOUNT, "alice", "bob", `m${i}`);
      const other = openDb(dbFile);
      try {
        // The first sender picks 6 rows and claims 4, its concurrency, then waits on the receiver.
        const first = sendPending(db, { timeoutMs: 300 });
        await vi.waitFor(() => expect(r.got).toHaveLength(4));
        // The second uses up the rest of the allowance in the meantime.
        const second = sendPending(other, { timeoutMs: 300 });
        await vi.waitFor(() => expect(r.got).toHaveLength(6));
        // A third finds none left, and the first's other picks were taken: 6 requests in all.
        expect(await Promise.all([first, second, sendPending(other, { timeoutMs: 300 })])).toEqual([
          { delivered: 0, failed: 4 },
          { delivered: 0, failed: 2 },
          { delivered: 0, failed: 0 },
        ]);
        expect(r.got).toHaveLength(6);
        expect(db.prepare("SELECT window_count FROM webhooks").get()).toEqual({ window_count: 6 });
        expect(pending().filter((d) => d.attempts === 0)).toHaveLength(4);
      } finally {
        other.close();
      }
    });

    it("rechecks the allowance when claiming, after another sender has used it since the pass picked its rows", async () => {
      const r = await receiver(() => null);
      const hook = addWebhook(db, "owner", r.url, "agent:bob", true, undefined, 6);
      for (let i = 0; i < 6; i++) sendMessage(db, OWNER_ACCOUNT, "alice", "bob", `m${i}`);
      const other = openDb(dbFile);
      try {
        const first = sendPending(db, { timeoutMs: 300 });
        await vi.waitFor(() => expect(r.got).toHaveLength(4));
        // As another sender would record two requests of its own.
        other.prepare("UPDATE webhooks SET window_count = window_count + 2 WHERE id = ?").run(hook.id);
        expect(await first).toEqual({ delivered: 0, failed: 4 });
        expect(r.got).toHaveLength(4);
        expect(pending().filter((d) => d.attempts === 0)).toHaveLength(2);
      } finally {
        other.close();
      }
    });
  });

  it("is sent by serve on its timer, and close() waits for the pass in progress", async () => {
    const r = await receiver();
    member(OWNER_ACCOUNT, "alice");
    member(OWNER_ACCOUNT, "bob");
    addWebhook(db, "owner", r.url, "agent:bob", true);
    const http = await startHttp(db, { token: "t", port: 0, webhookIntervalMs: 20 });
    try {
      sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "hi");
      await vi.waitFor(() => expect(row().delivered_at).not.toBeNull());
    } finally {
      await http.close();
    }
    sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "after close");
    await new Promise((res) => setTimeout(res, 100));
    expect(r.got).toHaveLength(1);
  });
});

describe("message-cp webhook", () => {
  const root = resolve(import.meta.dirname, "..");
  const cli = (...args: string[]) => cliWith(undefined, ...args);
  const cliWith = (input: string | undefined, ...args: string[]) =>
    spawnSync(join(root, "node_modules/.bin/tsx"), [join(root, "src/cli.ts"), ...args], {
      env: { ...process.env, MESSAGE_CP_DB: dbFile },
      encoding: "utf8",
      input,
    });
  const ADD = ["webhook", "add", "--url", "https://example.com/hook", "--on", "agent:bob"];

  it("adds a webhook with the header read from stdin, and lists its name but never its value", () => {
    const added = cliWith(`Authorization: ${HEADER_VALUE}\n`, ...ADD, "--header-stdin");
    expect(added.status).toBe(0);
    expect(added.stdout).toMatch(/^[0-9a-f]{64}\n$/);
    expect(added.stdout + added.stderr).not.toContain(HEADER_VALUE);
    expect(cliWith(`X-Api-Key: ${HEADER_VALUE}\r\n`, ...ADD, "--header-stdin", "--account", "friend", "--no-text").status).toBe(0);
    expect(cli(...ADD).status).toBe(0);
    const list = cli("webhook", "list");
    expect(list.stdout.trim().split("\n")).toEqual([
      "1\towner\thttps://example.com/hook\tagent:bob\ttext\theader: Authorization",
      "2\tfriend\thttps://example.com/hook\tagent:bob\tno text\theader: X-Api-Key",
      "3\towner\thttps://example.com/hook\tagent:bob\ttext",
    ]);
    expect(list.stdout + list.stderr).not.toContain(HEADER_VALUE);
    expect(db.prepare("SELECT header_value FROM webhooks WHERE id = 2").get()).toEqual({ header_value: HEADER_VALUE });
  }, 60_000);

  it("adds a webhook with --max-per-hour and lists it after any header, refusing a bad value with exit 1", () => {
    expect(cli(...ADD, "--max-per-hour", "5").status).toBe(0);
    expect(cliWith(`Authorization: ${HEADER_VALUE}\n`, ...ADD, "--header-stdin", "--max-per-hour", "10000").status).toBe(0);
    expect(cli(...ADD, "--max-per-hour", "1", "--account", "friend").status).toBe(0);
    expect(cli(...ADD).status).toBe(0);
    for (const bad of ["0", "-1", "1.5", "abc", "10001", "1e3", "+5"]) {
      const res = cli(...ADD, "--max-per-hour", bad);
      expect(res.status, bad).toBe(1);
      expect(res.stdout).toBe("");
      expect(res.stderr).toContain("message-cp: Invalid --max-per-hour");
    }
    expect(cli("webhook", "list").stdout.trim().split("\n")).toEqual([
      "1\towner\thttps://example.com/hook\tagent:bob\ttext\tmax: 5/hour",
      "2\towner\thttps://example.com/hook\tagent:bob\ttext\theader: Authorization\tmax: 10000/hour",
      "3\tfriend\thttps://example.com/hook\tagent:bob\ttext\tmax: 1/hour",
      "4\towner\thttps://example.com/hook\tagent:bob\ttext",
    ]);
  }, 120_000);

  it("adds a webhook with --body and lists it after any header and limit, never printing the body", () => {
    const body = '{"requestId":"{{delivery}}"}';
    const added = cli(...ADD, "--body", body);
    expect(added.status).toBe(0);
    expect(added.stdout).toMatch(/^[0-9a-f]{64}\n$/);
    expect(added.stdout + added.stderr).not.toContain("requestId");
    expect(cliWith(`Authorization: ${HEADER_VALUE}\n`, ...ADD, "--header-stdin", "--max-per-hour", "5", "--body", body).status).toBe(0);
    expect(cli(...ADD).status).toBe(0);
    const list = cli("webhook", "list");
    expect(list.stdout.trim().split("\n")).toEqual([
      "1\towner\thttps://example.com/hook\tagent:bob\ttext\tbody: fixed",
      "2\towner\thttps://example.com/hook\tagent:bob\ttext\theader: Authorization\tmax: 5/hour\tbody: fixed",
      "3\towner\thttps://example.com/hook\tagent:bob\ttext",
    ]);
    expect(list.stdout + list.stderr).not.toContain("requestId");
    expect(db.prepare("SELECT fixed_body FROM webhooks WHERE id = 1").get()).toEqual({ fixed_body: body });
  }, 60_000);

  it("refuses a bad --body, or --body with --no-text, with exit 1, storing nothing and never echoing the body", () => {
    for (const body of ["not json s3cr3t", '["{{delivery}}","s3cr3t"]', '{"id":"s3cr3t"}', '{"id":"{{delivery}}","s3cr3t":"{{delivery}}"}', '{"{{delivery}}":"s3cr3t"}', `{"id":"{{delivery}}","s3cr3t":"${"x".repeat(5000)}"}`]) {
      const res = cli(...ADD, "--body", body);
      expect(res.status, body.slice(0, 60)).toBe(1);
      expect(res.stdout).toBe("");
      expect(res.stderr).toContain("message-cp: Invalid --body");
      expect(res.stderr).not.toContain("s3cr3t");
    }
    const both = cli(...ADD, "--no-text", "--body", '{"id":"{{delivery}}"}');
    expect(both.status).toBe(1);
    expect(both.stderr).toContain("--no-text");
    expect(cli("webhook", "list").stdout).toBe("");
  }, 120_000);

  it("refuses each bad header line, empty stdin or more than one line with exit 1, without echoing the value", () => {
    for (const input of [...REFUSED_HEADERS.map((l) => `${l}\n`), "", "\n", `Authorization: ${HEADER_VALUE}\nX-Other: s3cr3t\n`]) {
      const res = cliWith(input, ...ADD, "--header-stdin");
      expect(res.status, JSON.stringify(input)).toBe(1);
      expect(res.stdout).toBe("");
      expect(res.stderr).toContain("message-cp: ");
      expect(res.stderr).not.toContain("s3cr3t");
    }
    expect(cli("webhook", "list").stdout).toBe("");
  }, 120_000);

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
      ["webhook", "add", "--url", "https://example.com/", "--on", "#x", "--header-stdin", "--header-stdin"],
      ["webhook", "list", "--header-stdin"],
      ["webhook", "add", "--url", "https://example.com/", "--on", "#x", "--max-per-hour"],
      ["webhook", "add", "--url", "https://example.com/", "--on", "#x", "--max-per-hour", ""],
      ["webhook", "add", "--url", "https://example.com/", "--on", "#x", "--max-per-hour", "1", "--max-per-hour", "2"],
      ["webhook", "add", "--url", "https://example.com/", "--on", "#x", "--max-per-hour", "--no-text"],
      ["webhook", "list", "--max-per-hour", "1"],
      ["webhook", "add", "--url", "https://example.com/", "--on", "#x", "--body"],
      ["webhook", "add", "--url", "https://example.com/", "--on", "#x", "--body", ""],
      ["webhook", "add", "--url", "https://example.com/", "--on", "#x", "--body", '{"a":"{{delivery}}"}', "--body", '{"b":"{{delivery}}"}'],
      ["webhook", "list", "--body", '{"a":"{{delivery}}"}'],
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
