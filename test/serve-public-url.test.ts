import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer, connect } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { httpWaitCommand } from "../src/wait.js";

const root = resolve(import.meta.dirname, "..");
const tsx = join(root, "node_modules/.bin/tsx");

/** A port nothing listens on, found by listening on port 0 and closing. */
const freePort = () =>
  new Promise<number>((res) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => res(port));
    });
  });

const listening = (port: number) =>
  new Promise<boolean>((res) => {
    const c = connect(port, "127.0.0.1");
    c.on("connect", () => (c.destroy(), res(true)));
    c.on("error", () => res(false));
  });

/** Runs `message-cp serve --port <port> --public-url <url>` until it exits or prints that it is listening, then stops it. */
function serve(port: number, url: string) {
  const dir = mkdtempSync(join(tmpdir(), "message-cp-serve-"));
  const child = spawn(tsx, [join(root, "src/cli.ts"), "serve", "--port", String(port), "--public-url", url], {
    env: { ...process.env, MESSAGE_CP_DB: join(dir, "db.sqlite"), MESSAGE_CP_HTTP_TOKEN: "t" },
  });
  let stderr = "";
  return new Promise<{ code: number | null; stderr: string; listened: boolean }>((res) => {
    child.stderr.on("data", (d) => {
      stderr += d;
      if (stderr.includes("listening on")) {
        void listening(port).then((listened) => {
          child.kill("SIGTERM");
          child.on("close", (code) => res({ code, stderr, listened }));
        });
      }
    });
    child.on("close", (code) => {
      if (!stderr.includes("listening on")) void listening(port).then((listened) => res({ code, stderr, listened }));
    });
  });
}

describe("serve --public-url", () => {
  it.each([
    "http://localhost@evil/",
    "https://@/",
    "https://h/?x=/o/",
    "https://h/#/o/",
    "https://h.example/?",
    "https://h.example/#",
    "https://user:pass@h.example",
    "http://localhost:8787",
    "http://example.com",
    "http://10.0.0.1",
    "ftp://h.example",
    "h.example",
    "https://h.example/mcp",
    "https://h.example/mcp/",
  ])("exits with its usage error for %s, and nothing listens", async (url) => {
    const port = await freePort();
    const r = await serve(port, url);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("usage: message-cp serve");
    expect(r.stderr).not.toContain("listening on");
    expect(r.listened).toBe(false);
  }, 20_000);

  it.each(["https://message-cp.example.com", "https://message-cp.example.com/", "https://h.example:8443/base", "http://127.0.0.1:8787", "http://[::1]:8787/"])(
    "serves with %s",
    async (url) => {
      const port = await freePort();
      const r = await serve(port, url);
      expect(r.stderr).toContain(`listening on http://127.0.0.1:${port}/mcp`);
      expect(r.listened).toBe(true);
    },
    20_000,
  );
});

describe("httpWaitCommand", () => {
  it("builds /wait from the parsed URL, as before for each URL serve accepts", () => {
    const url = (publicUrl: string) => /' sh (\S+) alice$/.exec(httpWaitCommand(publicUrl, "alice"))![1];
    expect(url("https://message-cp.example.com")).toBe("https://message-cp.example.com/wait");
    expect(url("https://message-cp.example.com/")).toBe("https://message-cp.example.com/wait");
    expect(url("https://h.example:8443/base//")).toBe("https://h.example:8443/base/wait");
    expect(url("http://127.0.0.1:8787")).toBe("http://127.0.0.1:8787/wait");
    // Brackets are shell-quoted.
    expect(url("http://[::1]:8787/")).toBe("'http://[::1]:8787/wait'");
  });
});
