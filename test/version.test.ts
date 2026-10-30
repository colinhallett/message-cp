import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { openDb, type Db } from "../src/db.js";
import { startHttp, type HttpServer } from "../src/http.js";

const root = join(import.meta.dirname, "..");
const packageVersion: string = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const dbFile = () => join(mkdtempSync(join(tmpdir(), "message-cp-version-")), "db.sqlite");

let client: Client | undefined;
let db: Db | undefined;
let http: HttpServer | undefined;

afterEach(async () => {
  await client?.close().catch(() => {});
  await http?.close();
  db?.close();
  client = db = http = undefined;
});

it("reports package.json's version to a client over stdio", async () => {
  client = new Client({ name: "test", version: "0" });
  await client.connect(
    new StdioClientTransport({
      command: "npx",
      args: ["tsx", join(root, "src/index.ts")],
      env: { ...process.env, MESSAGE_CP_DB: dbFile() } as Record<string, string>,
    }),
  );
  expect(client.getServerVersion()).toEqual({ name: "message-cp", version: packageVersion });
}, 60_000);

it("reports package.json's version to a client over HTTP", async () => {
  db = openDb(dbFile());
  http = await startHttp(db, { token: "s3cret-token", port: 0 });
  client = new Client({ name: "test", version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${http.port}/mcp`), {
      requestInit: { headers: { Authorization: "Bearer s3cret-token" } },
    }),
  );
  expect(client.getServerVersion()).toEqual({ name: "message-cp", version: packageVersion });
});

it("writes no version number in src/, so a release bump edits only the files that record it", () => {
  const sources = readdirSync(join(root, "src")).filter((f) => f.endsWith(".ts"));
  for (const file of sources) expect(readFileSync(join(root, "src", file), "utf8"), file).not.toMatch(/"\d+\.\d+\.\d+"/);
});
