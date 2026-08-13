import pino from "pino";
import type { LoggerOptions } from "pino";
import { loadConfig } from "./config/load-config.js";
import { BridgeDatabase } from "./persistence/database.js";
import { CodexAppServerClient } from "./codex/app-server-client.js";
import { FeishuAdapter } from "./channels/feishu-adapter.js";
import { ConsoleAdapter } from "./channels/console-adapter.js";
import type { ChannelAdapter } from "./channels/channel-adapter.js";
import { Bridge } from "./core/bridge.js";
import type { JsonRpcMessage } from "./codex/protocol-types.js";
import { CodexDesktopProjectDiscovery } from "./projects/codex-desktop-project-discovery.js";
import { pathToFileURL } from "node:url";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

interface FeishuCredentialEnvironmentNames {
  appIdEnv: string;
  appSecretEnv: string;
  allowedOpenIdEnv: string;
}

const defaultFeishuCredentialEnvironmentNames = [
  "CLAWBRIDGE_FEISHU_APP_ID",
  "CLAWBRIDGE_FEISHU_APP_SECRET",
  "CLAWBRIDGE_FEISHU_ALLOWED_OPEN_ID",
] as const;

const credentialFieldPattern =
  /(?:app[_ -]?id|app[_ -]?secret|access[_ -]?token|tenant[_ -]?access[_ -]?token|authorization|open[_ -]?id)/i;

function containsCredentialField(value: unknown, depth = 0): boolean {
  if (depth > 8 || value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((entry) => containsCredentialField(entry, depth + 1));
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (credentialFieldPattern.test(key) || containsCredentialField(entry, depth + 1)) return true;
  }
  return false;
}

export function createBridgeLoggerOptions(level: string): LoggerOptions {
  return {
    level,
    hooks: {
      logMethod(inputArgs, method) {
        if (inputArgs.some((argument) => containsCredentialField(argument))) {
          Reflect.apply(method, this, [
            { redacted: true },
            "Sensitive diagnostic event suppressed",
          ]);
          return;
        }
        method.apply(this, inputArgs);
      },
    },
    redact: {
      paths: [
        "appId",
        "app_id",
        "appSecret",
        "app_secret",
        "openId",
        "open_id",
        "accessToken",
        "access_token",
        "tenantAccessToken",
        "tenant_access_token",
        "authorization",
        "*.appId",
        "*.app_id",
        "*.appSecret",
        "*.app_secret",
        "*.openId",
        "*.open_id",
        "*.accessToken",
        "*.access_token",
        "*.tenantAccessToken",
        "*.tenant_access_token",
        "*.authorization",
      ],
      censor: "[REDACTED]",
    },
  };
}

export function removeFeishuCredentialsFromEnvironment(
  environment: NodeJS.ProcessEnv,
  names: FeishuCredentialEnvironmentNames,
): void {
  const configuredNames = [names.appIdEnv, names.appSecretEnv, names.allowedOpenIdEnv];
  for (const name of new Set([...defaultFeishuCredentialEnvironmentNames, ...configuredNames])) {
    delete environment[name];
  }
}

interface LifecycleFiles {
  readyFile?: string;
  shutdownFile?: string;
}

export function takeLifecycleFiles(environment: NodeJS.ProcessEnv): LifecycleFiles {
  const readyFile = environment.CLAWBRIDGE_READY_FILE?.trim();
  const shutdownFile = environment.CLAWBRIDGE_SHUTDOWN_FILE?.trim();
  delete environment.CLAWBRIDGE_READY_FILE;
  delete environment.CLAWBRIDGE_SHUTDOWN_FILE;
  return {
    ...(readyFile ? { readyFile: path.resolve(readyFile) } : {}),
    ...(shutdownFile ? { shutdownFile: path.resolve(shutdownFile) } : {}),
  };
}

async function removeLifecycleFile(file: string | undefined): Promise<void> {
  if (!file) return;
  await unlink(file).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  });
}

async function publishReady(file: string | undefined): Promise<void> {
  if (!file) return;
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(
    temporary,
    JSON.stringify({
      version: 1,
      state: "ready",
      pid: process.pid,
      readyAt: new Date().toISOString(),
    }),
    { encoding: "utf8", flag: "wx" },
  );
  await rename(temporary, file);
}

function watchForShutdown(file: string | undefined, onShutdown: () => Promise<void>): () => void {
  if (!file) return () => {};
  let handling = false;
  const timer = setInterval(() => {
    if (handling) return;
    void readFile(file, "utf8")
      .then((content) => {
        const request = JSON.parse(content.replace(/^\uFEFF/, "")) as {
          version?: unknown;
          pid?: unknown;
        };
        if (request.version !== 1 || request.pid !== process.pid) return;
        handling = true;
        clearInterval(timer);
        return onShutdown();
      })
      .catch((error: unknown) => {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") process.stderr.write("Invalid shutdown request ignored\n");
      });
  }, 250);
  timer.unref();
  return () => clearInterval(timer);
}

async function main(): Promise<void> {
  const lifecycleFiles = takeLifecycleFiles(process.env);
  await removeLifecycleFile(lifecycleFiles.readyFile);
  const consoleMode = process.argv.includes("--console");
  const loaded = await loadConfig(undefined, process.env, { requireFeishuSecrets: !consoleMode });
  removeFeishuCredentialsFromEnvironment(process.env, loaded.config.feishu);
  const logger = pino(createBridgeLoggerOptions(loaded.config.bridge.logLevel));
  const channel: ChannelAdapter = consoleMode
    ? new ConsoleAdapter(loaded.secrets.allowedOpenId)
    : new FeishuAdapter(
        { appId: loaded.secrets.appId, appSecret: loaded.secrets.appSecret },
        logger,
      );
  const database = new BridgeDatabase(loaded.config.bridge.databasePath);
  const codex = new CodexAppServerClient(loaded.config.codex);
  const desktopProjectConfig = loaded.config.projectManagement.codexDesktopProjects;
  const desktopProjects = desktopProjectConfig.enabled
    ? new CodexDesktopProjectDiscovery(
        desktopProjectConfig.stateFile ? { stateFile: desktopProjectConfig.stateFile } : {},
      )
    : undefined;
  codex.on("stderr", (message: string) =>
    logger.debug({ source: "codex", message }, "Codex stderr"),
  );
  codex.on("protocolError", (error: Error) => logger.warn({ err: error }, "Codex protocol error"));
  codex.on("message", (message: JsonRpcMessage) => {
    if (!("id" in message && "method" in message)) return;
    if (
      message.method === "item/commandExecution/requestApproval" ||
      message.method === "item/fileChange/requestApproval"
    ) {
      logger.warn(
        { method: message.method },
        "Declining approval because mobile approval is not enabled",
      );
      void codex
        .respondToServerRequest(message.id, { decision: "decline" })
        .catch((error: unknown) => logger.error({ err: error }, "Failed to decline approval"));
      return;
    }
    logger.warn(
      { method: message.method },
      "Rejecting unsupported App Server request because mobile interaction is not enabled",
    );
    void codex
      .rejectServerRequest(message.id, {
        code: -32601,
        message: `ClawBridge does not support App Server request ${message.method}`,
      })
      .catch((error: unknown) =>
        logger.error({ err: error }, "Failed to reject unsupported App Server request"),
      );
  });
  const bridge = new Bridge({
    channel,
    codex,
    database,
    config: loaded.config,
    projects: loaded.projects,
    ...(desktopProjects ? { desktopProjects } : {}),
    allowedOpenId: loaded.secrets.allowedOpenId,
    logger,
  });

  let shutdownPromise: Promise<void> | undefined;
  let stopShutdownWatcher = () => {};
  let shutdownRequested = false;
  let shutdownExitCode = 0;
  const shutdown = async (signal: string): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    shutdownRequested = true;
    shutdownPromise = (async () => {
      stopShutdownWatcher();
      logger.info({ signal }, "Stopping ClawBridge");
      try {
        await bridge.stop();
      } finally {
        await Promise.allSettled([
          removeLifecycleFile(lifecycleFiles.readyFile),
          removeLifecycleFile(lifecycleFiles.shutdownFile),
        ]);
        process.exitCode = shutdownExitCode;
      }
    })();
    return shutdownPromise;
  };
  channel.onFatalError?.(() => {
    shutdownExitCode = 1;
    void removeLifecycleFile(lifecycleFiles.readyFile)
      .catch(() => {})
      .then(() => shutdown("channel-error"))
      .catch(() => {});
  });
  process.once("SIGINT", () => void shutdown("SIGINT").catch(() => {}));
  process.once("SIGTERM", () => void shutdown("SIGTERM").catch(() => {}));
  stopShutdownWatcher = watchForShutdown(lifecycleFiles.shutdownFile, () => shutdown("manager"));
  try {
    await bridge.start();
    if (shutdownRequested) {
      await shutdownPromise;
      return;
    }
    await publishReady(lifecycleFiles.readyFile);
    if (shutdownRequested) {
      await removeLifecycleFile(lifecycleFiles.readyFile);
      await shutdownPromise;
      return;
    }
  } catch (error) {
    await bridge.stop().catch(() => {});
    await removeLifecycleFile(lifecycleFiles.readyFile).catch(() => {});
    if (shutdownRequested) {
      await shutdownPromise;
      return;
    }
    throw error;
  }
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
