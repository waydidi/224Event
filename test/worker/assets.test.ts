import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Exercise the real Wrangler assets binding, including its HTML redirects.
 * Integration fixtures use a filesystem binding and cannot catch this behavior.
 */
test(
  "real Cloudflare assets serve homepage and QR shell without HTML redirect loops",
  { timeout: 90000 },
  async () => {
    const port = await new Promise<number>((resolve) => {
      const s = createServer();
      s.listen(0, "127.0.0.1", () => {
        const p = (s.address() as { port: number }).port;
        s.close(() => resolve(p));
      });
    });
    const state = fs.mkdtempSync(path.join(os.tmpdir(), "224-assets-test-"));
    const child = spawn(
      process.execPath,
      [
        "node_modules/wrangler/bin/wrangler.js",
        "dev",
        "--local",
        "--ip",
        "127.0.0.1",
        "--port",
        String(port),
        "--inspector-port",
        "0",
        "--persist-to",
        state,
        "--log-level",
        "error",
      ],
      {
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
      },
    );
    let log = "";
    child.stdout.on("data", (chunk) => {
      log += chunk;
    });
    child.stderr.on("data", (chunk) => {
      log += chunk;
    });
    const base = `http://127.0.0.1:${port}`;
    try {
      let ready = false;
      for (let i = 0; i < 120; i++) {
        if (child.exitCode !== null) throw new Error(`Wrangler exited: ${log}`);
        try {
          await fetch(base, {
            redirect: "manual",
            signal: AbortSignal.timeout(1000),
          });
          ready = true;
          break;
        } catch {}
        await new Promise((r) => setTimeout(r, 250));
      }
      assert.ok(ready, `Wrangler did not start: ${log}`);
      for (const route of ["/", "/t/RegressionQrToken123"]) {
        const response = await fetch(base + route, { redirect: "manual" });
        assert.equal(
          response.status,
          200,
          `${route}: ${response.status} → ${response.headers.get("location")}`,
        );
        assert.match(await response.text(), /224 Live House/);
      }
      for (const asset of [
        "/static/app.js",
        "/static/styles.css",
        "/static/logo-224-header.webp",
      ])
        assert.equal(
          (await fetch(base + asset, { redirect: "manual" })).status,
          200,
        );
    } finally {
      const exited = new Promise<void>((resolve) =>
        child.once("exit", () => resolve()),
      );
      try {
        process.kill(-child.pid!, "SIGTERM");
      } catch {}
      await Promise.race([
        exited,
        new Promise((resolve) => setTimeout(resolve, 3000)),
      ]);
      if (child.exitCode === null)
        try {
          process.kill(-child.pid!, "SIGKILL");
        } catch {}
      fs.rmSync(state, { recursive: true, force: true });
    }
  },
);
