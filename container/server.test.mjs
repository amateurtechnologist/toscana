import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";

test("Toscana serves health and Gateway HTTP requests without a Discord session or token", { timeout: 10_000 }, async t => {
  const env = { ...process.env, PORT: "0" };
  delete env.DISCORD_TOKEN;
  const child = spawn(process.execPath, [new URL("./server.mjs", import.meta.url).pathname], {
    env, stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    if (child.exitCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    }
  });
  const ready = new Promise((resolve, reject) => {
    let output = "";
    child.once("error", reject);
    child.once("exit", code => reject(new Error(`Server exited with ${code}`)));
    child.stdout.on("data", chunk => {
      output += chunk;
      if (!output.includes("\n")) return;
      try { resolve(JSON.parse(output.split("\n")[0])); } catch (error) { reject(error); }
    });
  });
  const status = await ready;
  assert.equal(status.automatic_forwarding, false);
  const origin = `http://127.0.0.1:${status.port}`;
  const health = await fetch(`${origin}/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), {
    ok: true, service: "toscana-container", automatic_forwarding: false,
    gateway: { state: "disabled", reason: "bump_runs_in_agitat_ing" },
  });
  const forwarded = await fetch(`${origin}/sample?query=1`, { headers: { "x-toscana-gateway": "cloudflare-one" } });
  assert.deepEqual(await forwarded.json(), {
    ok: true, service: "toscana-container", method: "GET", path: "/sample?query=1", gateway: "cloudflare-one",
  });
});
