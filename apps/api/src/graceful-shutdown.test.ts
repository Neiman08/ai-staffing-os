// F12.7: process.exit()/señales reales no se pueden probar importando
// index.ts en el mismo proceso (mataría al test runner, mismo motivo
// que core/env.test.ts) -- se spawnea el proceso real de la API en un
// puerto aislado, se espera a que /health/live responda de verdad, se
// manda un SIGTERM real, y se verifica que el proceso hijo termina con
// exit code 0 dentro de un plazo razonable (nunca colgado esperando el
// timeout de 10s de gracefulShutdown).

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(apiRoot, "../..");
const PORT = 4099;

function loadDotEnv(): Record<string, string> {
  const raw = readFileSync(path.join(repoRoot, ".env"), "utf-8");
  const vars: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (match) vars[match[1]!] = match[2]!.replace(/^"|"$/g, "");
  }
  return vars;
}

async function waitForHealth(timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${PORT}/api/v1/health/live`);
      if (res.ok) return;
    } catch {
      // still booting
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("API never became healthy within the timeout");
}

test("SIGTERM real: la API cierra ordenadamente (schedulers, servidor, Prisma) y termina con exit code 0", async () => {
  const dotEnvVars = loadDotEnv();
  const child = spawn("node", ["--import", "tsx", "src/index.ts"], {
    cwd: apiRoot,
    env: { ...process.env, ...dotEnvVars, PORT: String(PORT) },
  });

  const logLines: string[] = [];
  child.stdout?.on("data", (chunk: Buffer) => logLines.push(chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => logLines.push(chunk.toString()));

  const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });

  try {
    await waitForHealth();

    child.kill("SIGTERM");
    const { code } = await Promise.race([
      exitPromise,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("shutdown did not complete within 12s")), 12_000)),
    ]);

    assert.equal(code, 0, `expected clean exit code 0, got ${code}. Logs:\n${logLines.join("")}`);
    const fullLog = logLines.join("");
    assert.match(fullLog, /"graceful_shutdown_started".*"signal":"SIGTERM"/);
    assert.match(fullLog, /"graceful_shutdown_complete".*"signal":"SIGTERM"/);
  } finally {
    if (!child.killed) child.kill("SIGKILL");
  }
});
