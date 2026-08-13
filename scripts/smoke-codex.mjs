import { CodexAppServerClient } from "../dist/src/codex/app-server-client.js";

const [command, ...args] = process.argv.slice(2);
if (!command) {
  process.stderr.write("Usage: node scripts/smoke-codex.mjs <command> [args...]\n");
  process.exit(2);
}

const client = new CodexAppServerClient({
  command,
  args,
  requestTimeoutMs: Number(process.env.CLAWBRIDGE_SMOKE_REQUEST_TIMEOUT_MS ?? 30_000),
  turnTimeoutMs: Number(process.env.CLAWBRIDGE_SMOKE_TURN_TIMEOUT_MS ?? 600_000),
});
client.on("stderr", (message) => process.stderr.write(message));

try {
  await client.start();
  process.stdout.write("CODEX_APP_SERVER_HANDSHAKE_OK\n");
  const prompt = process.env.CLAWBRIDGE_SMOKE_PROMPT?.trim();
  if (prompt) {
    const result = await client.runTurn({
      cwd: process.cwd(),
      prompt,
      approvalPolicy: process.env.CLAWBRIDGE_SMOKE_APPROVAL_POLICY ?? "never",
      sandbox: process.env.CLAWBRIDGE_SMOKE_SANDBOX ?? "readOnly",
    });
    process.stdout.write(`CODEX_TURN_OK thread=${result.threadId} turn=${result.turnId}\n`);
    process.stdout.write(`${result.finalText}\n`);
  }
} finally {
  await client.stop();
}
