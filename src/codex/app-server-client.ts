import { EventEmitter } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import { BridgeError } from "../core/errors.js";
import {
  extractAgentText,
  extractIds,
  extractNotificationIds,
  extractThreadDetails,
  extractThreadList,
  extractThreadRead,
  extractTurnCompletion,
  normalizeCodexEvent,
} from "./event-normalizer.js";
import type {
  CodexRunner,
  CodexServerRequestContext,
  CodexModelInfo,
  CodexRateLimits,
  CodexRateLimitSnapshot,
  CodexThreadDetails,
  CodexThreadListInput,
  CodexThreadStartInput,
  CodexThreadSummary,
  CodexThreadUnsubscribeStatus,
  CodexTurnResult,
  JsonRpcId,
  JsonRpcMessage,
  JsonRpcResponse,
} from "./protocol-types.js";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

interface AppServerOptions {
  command: string;
  args: string[];
  requestTimeoutMs: number;
  turnTimeoutMs: number;
}

const sensitiveEnvironmentName =
  /(?:^|_)(?:APP_?SECRET|API_?KEY|ACCESS_?TOKEN|AUTHORIZATION|PASSWORD|PRIVATE_?KEY|CLIENT_?SECRET)(?:$|_)/i;

export function codexChildEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(environment).filter(([name]) => !sensitiveEnvironmentName.test(name)),
  );
}

function toWireApprovalPolicy(
  policy: CodexThreadStartInput["approvalPolicy"],
): "on-request" | "untrusted" | "never" {
  if (policy === "onRequest") return "on-request";
  if (policy === "unlessTrusted") return "untrusted";
  return "never";
}

function toWireSandbox(sandbox: CodexThreadStartInput["sandbox"]): "workspace-write" | "read-only" {
  return sandbox === "workspaceWrite" ? "workspace-write" : "read-only";
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function optionalNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function extractRateLimitSnapshot(value: unknown): CodexRateLimitSnapshot {
  if (typeof value !== "object" || value === null) throw new Error("Invalid rate-limit snapshot");
  const row = value as Record<string, unknown>;
  const window = (candidate: unknown) => {
    if (typeof candidate !== "object" || candidate === null) return null;
    const item = candidate as Record<string, unknown>;
    if (typeof item.usedPercent !== "number" || !Number.isFinite(item.usedPercent)) {
      throw new Error("Invalid rate-limit window");
    }
    return {
      usedPercent: item.usedPercent,
      windowDurationMins: optionalNumber(item.windowDurationMins),
      resetsAt: optionalNumber(item.resetsAt),
    };
  };
  const individual = row.individualLimit;
  const individualLimit =
    typeof individual === "object" &&
    individual !== null &&
    typeof (individual as Record<string, unknown>).limit === "string" &&
    typeof (individual as Record<string, unknown>).used === "string" &&
    typeof (individual as Record<string, unknown>).remainingPercent === "number" &&
    typeof (individual as Record<string, unknown>).resetsAt === "number"
      ? {
          limit: (individual as Record<string, unknown>).limit as string,
          used: (individual as Record<string, unknown>).used as string,
          remainingPercent: (individual as Record<string, unknown>).remainingPercent as number,
          resetsAt: (individual as Record<string, unknown>).resetsAt as number,
        }
      : null;
  return {
    limitId: optionalString(row.limitId),
    limitName: optionalString(row.limitName),
    planType: optionalString(row.planType),
    primary: window(row.primary),
    secondary: window(row.secondary),
    rateLimitReachedType: optionalString(row.rateLimitReachedType),
    spendControlReached:
      typeof row.spendControlReached === "boolean" ? row.spendControlReached : null,
    individualLimit,
  };
}

function extractRateLimits(value: unknown): CodexRateLimits {
  if (typeof value !== "object" || value === null) throw new Error("Invalid rate-limit response");
  const row = value as Record<string, unknown>;
  const byIdValue = row.rateLimitsByLimitId;
  const byId =
    typeof byIdValue === "object" && byIdValue !== null
      ? Object.fromEntries(
          Object.entries(byIdValue as Record<string, unknown>).map(([key, snapshot]) => [
            key,
            extractRateLimitSnapshot(snapshot),
          ]),
        )
      : null;
  const resetCredits = row.rateLimitResetCredits;
  const availableResetCredits =
    typeof resetCredits === "object" &&
    resetCredits !== null &&
    typeof (resetCredits as Record<string, unknown>).availableCount === "number"
      ? ((resetCredits as Record<string, unknown>).availableCount as number)
      : null;
  return {
    rateLimits: extractRateLimitSnapshot(row.rateLimits),
    rateLimitsByLimitId: byId,
    availableResetCredits,
  };
}

export class CodexAppServerClient extends EventEmitter implements CodexRunner {
  private child: ChildProcessWithoutNullStreams | undefined;
  private childExitPromise: Promise<void> | undefined;
  private startPromise: Promise<void> | undefined;
  private stopPromise: Promise<void> | undefined;
  private ready = false;
  private readonly childExitPromises = new WeakMap<ChildProcessWithoutNullStreams, Promise<void>>();
  private nextId = 1;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private readonly notificationBuffer: JsonRpcMessage[] = [];
  private readonly locallyStartedEmptyThreads = new Set<string>();
  private serverRequestHandler?: (context: CodexServerRequestContext) => void;

  constructor(private readonly options: AppServerOptions) {
    super();
  }

  async start(): Promise<void> {
    if (this.stopPromise) await this.stopPromise;
    if (this.startPromise) return this.startPromise;

    const startPromise = this.startOnce();
    this.startPromise = startPromise;
    try {
      await startPromise;
    } catch (error) {
      if (this.startPromise === startPromise) this.startPromise = undefined;
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    const stopPromise = this.stopOnce();
    this.stopPromise = stopPromise;
    try {
      await stopPromise;
    } finally {
      if (this.stopPromise === stopPromise) this.stopPromise = undefined;
    }
  }

  setServerRequestHandler(handler: (context: CodexServerRequestContext) => void): void {
    this.serverRequestHandler = handler;
  }

  async runTurn(input: {
    cwd: string;
    prompt: string;
    inputs?: import("./protocol-types.js").CodexUserInput[];
    threadId?: string | null;
    approvalPolicy: "unlessTrusted" | "onRequest" | "never";
    sandbox: "readOnly" | "workspaceWrite";
    model?: string;
    reasoningEffort?: string;
    onStarted?: (ids: { threadId: string; turnId: string }) => void;
    onProgress?: (event: import("./protocol-types.js").NormalizedCodexEvent) => void;
  }): Promise<CodexTurnResult> {
    await this.start();
    const approvalPolicy = toWireApprovalPolicy(input.approvalPolicy);
    const sandbox = toWireSandbox(input.sandbox);
    let threadId = input.threadId ?? undefined;
    let newlyStartedThreadId: string | undefined;
    if (threadId) {
      if (this.locallyStartedEmptyThreads.has(threadId)) {
        this.locallyStartedEmptyThreads.delete(threadId);
      } else {
        await this.request("thread/resume", { threadId });
      }
    } else {
      threadId = (await this.startThread(input)).id;
      newlyStartedThreadId = threadId;
      this.locallyStartedEmptyThreads.delete(threadId);
    }
    if (!threadId)
      throw new BridgeError("CODEX_PROTOCOL_ERROR", "thread/start did not return a thread id");

    let turnId: string;
    try {
      const startedTurn = await this.request("turn/start", {
        threadId,
        input: input.inputs ?? [{ type: "text", text: input.prompt }],
        cwd: input.cwd,
        approvalPolicy,
        sandboxPolicy:
          input.sandbox === "workspaceWrite"
            ? { type: "workspaceWrite", writableRoots: [input.cwd], networkAccess: false }
            : { type: "readOnly", networkAccess: false },
        ...(input.model ? { model: input.model } : {}),
        ...(input.reasoningEffort ? { effort: input.reasoningEffort } : {}),
      });
      const extractedTurnId = extractIds(startedTurn).turnId;
      if (!extractedTurnId)
        throw new BridgeError("CODEX_PROTOCOL_ERROR", "turn/start did not return a turn id");
      turnId = extractedTurnId;
    } catch (error) {
      if (newlyStartedThreadId) {
        await this.cleanupNewThreadSubscription(newlyStartedThreadId);
      }
      throw error;
    }

    const waiterAbort = new AbortController();
    const turnCompletion = this.waitForTurn(threadId, turnId, waiterAbort.signal, input.onProgress);
    // Attach a rejection handler immediately so a synchronous callback failure cannot create an
    // unhandled rejection while the best-effort interrupt request is in flight.
    void turnCompletion.catch(() => undefined);
    try {
      input.onStarted?.({ threadId, turnId });
    } catch (error) {
      const callbackError = error instanceof Error ? error : new Error(String(error));
      waiterAbort.abort(callbackError);
      try {
        await this.interrupt(threadId, turnId);
      } catch (interruptError) {
        this.emit(
          "protocolError",
          new BridgeError(
            "CODEX_PROTOCOL_ERROR",
            "Failed to interrupt Codex turn after onStarted failed",
            true,
            { cause: interruptError },
          ),
        );
        try {
          await this.stop();
        } catch (stopError) {
          this.emit(
            "protocolError",
            new BridgeError(
              "CODEX_START_FAILED",
              "Failed to terminate Codex App Server after interrupt failed",
              true,
              { cause: stopError },
            ),
          );
        }
      }
      throw callbackError;
    }
    const finalText = await turnCompletion;
    return { threadId, turnId, finalText };
  }

  async startThread(input: CodexThreadStartInput): Promise<CodexThreadSummary> {
    await this.start();
    let result: unknown;
    try {
      result = await this.request("thread/start", {
        cwd: input.cwd,
        approvalPolicy: toWireApprovalPolicy(input.approvalPolicy),
        sandbox: toWireSandbox(input.sandbox),
        serviceName: "clawbridge",
        threadSource: "user",
      });
    } catch (error) {
      await this.stopAfterUncertainThreadStart();
      throw error;
    }
    try {
      const summary = extractThreadRead(result);
      this.locallyStartedEmptyThreads.add(summary.id);
      return summary;
    } catch (error) {
      await this.stopAfterUncertainThreadStart();
      throw new BridgeError("CODEX_PROTOCOL_ERROR", "Invalid thread/start response", false, {
        cause: error,
      });
    }
  }

  async interrupt(threadId: string, turnId: string): Promise<void> {
    await this.start();
    await this.request("turn/interrupt", { threadId, turnId });
  }

  async listThreads(input: CodexThreadListInput): Promise<CodexThreadSummary[]> {
    await this.start();
    const result = await this.request("thread/list", {
      cwd: input.cwd,
      limit: input.limit ?? 10,
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      ...(input.archived === undefined ? {} : { archived: input.archived }),
      sortKey: "updated_at",
      sortDirection: "desc",
      sourceKinds: ["appServer", "cli", "vscode"],
    });
    try {
      return extractThreadList(result);
    } catch (error) {
      throw new BridgeError("CODEX_PROTOCOL_ERROR", "Invalid thread/list response", false, {
        cause: error,
      });
    }
  }

  async listModels(): Promise<CodexModelInfo[]> {
    await this.start();
    const models: CodexModelInfo[] = [];
    let cursor: string | null | undefined;
    do {
      const result = await this.request("model/list", {
        limit: 100,
        includeHidden: false,
        ...(cursor ? { cursor } : {}),
      });
      if (typeof result !== "object" || result === null || !("data" in result)) {
        throw new BridgeError("CODEX_PROTOCOL_ERROR", "Invalid model/list response", false);
      }
      const data = (result as { data?: unknown }).data;
      if (!Array.isArray(data)) {
        throw new BridgeError("CODEX_PROTOCOL_ERROR", "Invalid model/list response", false);
      }
      for (const value of data) {
        if (typeof value !== "object" || value === null) continue;
        const model = value as Record<string, unknown>;
        const efforts = Array.isArray(model.supportedReasoningEfforts)
          ? model.supportedReasoningEfforts.flatMap((entry) => {
              if (typeof entry !== "object" || entry === null) return [];
              const option = entry as Record<string, unknown>;
              return typeof option.reasoningEffort === "string" &&
                typeof option.description === "string"
                ? [{ reasoningEffort: option.reasoningEffort, description: option.description }]
                : [];
            })
          : [];
        if (
          typeof model.id !== "string" ||
          typeof model.model !== "string" ||
          typeof model.displayName !== "string" ||
          typeof model.description !== "string" ||
          typeof model.isDefault !== "boolean" ||
          typeof model.defaultReasoningEffort !== "string"
        ) {
          continue;
        }
        models.push({
          id: model.id,
          model: model.model,
          displayName: model.displayName,
          description: model.description,
          isDefault: model.isDefault,
          defaultReasoningEffort: model.defaultReasoningEffort,
          supportedReasoningEfforts: efforts,
        });
      }
      cursor =
        "nextCursor" in result &&
        (typeof (result as { nextCursor?: unknown }).nextCursor === "string" ||
          (result as { nextCursor?: unknown }).nextCursor === null)
          ? ((result as { nextCursor?: string | null }).nextCursor ?? null)
          : null;
    } while (cursor);
    return models;
  }

  async readRateLimits(): Promise<CodexRateLimits> {
    await this.start();
    const result = await this.request("account/rateLimits/read");
    try {
      return extractRateLimits(result);
    } catch (error) {
      throw new BridgeError(
        "CODEX_PROTOCOL_ERROR",
        "Invalid account/rateLimits/read response",
        false,
        {
          cause: error,
        },
      );
    }
  }

  async readThread(threadId: string): Promise<CodexThreadSummary> {
    await this.start();
    const result = await this.request("thread/read", { threadId, includeTurns: false });
    try {
      return extractThreadRead(result);
    } catch (error) {
      throw new BridgeError("CODEX_PROTOCOL_ERROR", "Invalid thread/read response", false, {
        cause: error,
      });
    }
  }

  async readThreadDetails(threadId: string, includeTurns = true): Promise<CodexThreadDetails> {
    await this.start();
    const result = await this.request("thread/read", { threadId, includeTurns });
    try {
      return extractThreadDetails(result);
    } catch (error) {
      throw new BridgeError("CODEX_PROTOCOL_ERROR", "Invalid thread/read response", false, {
        cause: error,
      });
    }
  }

  async nameThread(threadId: string, name: string): Promise<void> {
    await this.start();
    await this.request("thread/name/set", { threadId, name });
  }

  async archiveThread(threadId: string): Promise<void> {
    await this.start();
    await this.request("thread/archive", { threadId });
    this.locallyStartedEmptyThreads.delete(threadId);
  }

  async unarchiveThread(threadId: string): Promise<CodexThreadSummary> {
    await this.start();
    const result = await this.request("thread/unarchive", { threadId });
    try {
      return extractThreadRead(result);
    } catch (error) {
      throw new BridgeError("CODEX_PROTOCOL_ERROR", "Invalid thread/unarchive response", false, {
        cause: error,
      });
    }
  }

  async unsubscribeThread(threadId: string): Promise<CodexThreadUnsubscribeStatus> {
    await this.start();
    const result = await this.request("thread/unsubscribe", { threadId });
    const status =
      typeof result === "object" && result !== null && "status" in result
        ? result.status
        : undefined;
    if (status === "unsubscribed" || status === "notSubscribed" || status === "notLoaded") {
      this.locallyStartedEmptyThreads.delete(threadId);
      return status;
    }
    throw new BridgeError("CODEX_PROTOCOL_ERROR", "Invalid thread/unsubscribe response", false);
  }

  async respondToServerRequest(id: JsonRpcId, result: unknown): Promise<void> {
    this.write({ id, result } as JsonRpcResponse);
  }

  async rejectServerRequest(
    id: JsonRpcId,
    error: { code: number; message: string; data?: unknown },
  ): Promise<void> {
    this.write({ id, error } as JsonRpcResponse);
  }

  private async startOnce(): Promise<void> {
    let child: ChildProcessWithoutNullStreams | undefined;
    try {
      child = spawn(this.options.command, this.options.args, {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        shell: false,
        env: codexChildEnvironment(),
      });
      this.child = child;
      this.ready = false;
      this.notificationBuffer.length = 0;
      const childExitPromise = this.observeChild(child);
      this.childExitPromises.set(child, childExitPromise);
      this.childExitPromise = childExitPromise;
      readline.createInterface({ input: child.stdout }).on("line", (line) => this.handleLine(line));
      child.stderr.on("data", (chunk: Buffer) => this.emit("stderr", chunk.toString("utf8")));

      await this.request("initialize", {
        clientInfo: { name: "clawbridge", title: "ClawBridge", version: "2.2.1" },
        capabilities: {},
      });
      if (this.child !== child) {
        throw new BridgeError(
          "CODEX_START_FAILED",
          "Codex App Server exited during initialization",
          true,
        );
      }
      this.notify("initialized", {});
      this.ready = true;
    } catch (error) {
      if (child) await this.terminateChild(child);
      if (error instanceof Error) throw error;
      throw new BridgeError("CODEX_START_FAILED", String(error), true);
    }
  }

  private async stopOnce(): Promise<void> {
    const child = this.child;
    const exitPromise = this.childExitPromise;
    const startPromise = this.startPromise;
    if (child) {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      if (exitPromise) await exitPromise;
    }
    if (startPromise) {
      await startPromise.catch(() => undefined);
      if (this.startPromise === startPromise) this.startPromise = undefined;
    }
    this.ready = false;
    this.locallyStartedEmptyThreads.clear();
  }

  private observeChild(child: ChildProcessWithoutNullStreams): Promise<void> {
    let terminationHandled = false;
    let exitSettled = false;
    let resolveExit: (() => void) | undefined;
    const exitPromise = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });
    const terminate = (error: Error): void => {
      if (terminationHandled) return;
      terminationHandled = true;
      if (this.child === child) {
        this.child = undefined;
        if (this.ready) this.startPromise = undefined;
        this.ready = false;
      }
      this.handleTermination(error);
    };
    const settleExit = (error: Error): void => {
      terminate(error);
      if (exitSettled) return;
      exitSettled = true;
      if (this.childExitPromise === exitPromise) this.childExitPromise = undefined;
      resolveExit?.();
    };
    const exitedError = (code: number | null, signal: NodeJS.Signals | null): BridgeError =>
      new BridgeError(
        "CODEX_START_FAILED",
        `Codex App Server exited (${code ?? signal ?? "unknown"})`,
        true,
      );

    child.once("error", (error) => {
      const startError = new BridgeError("CODEX_START_FAILED", error.message, true, {
        cause: error,
      });
      terminate(startError);
      // A failed spawn has no OS process and therefore may not emit `exit`.
      if (child.pid === undefined) settleExit(startError);
    });
    child.once("exit", (code, signal) => settleExit(exitedError(code, signal)));
    child.once("close", (code, signal) => settleExit(exitedError(code, signal)));
    return exitPromise;
  }

  private async terminateChild(child: ChildProcessWithoutNullStreams): Promise<void> {
    const exitPromise = this.childExitPromises.get(child);
    if (child.exitCode === null && child.signalCode === null && child.pid !== undefined) {
      child.kill();
    }
    if (exitPromise) await exitPromise;
  }

  private request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BridgeError("CODEX_TIMEOUT", `${method} timed out`, true));
      }, this.options.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ id, method, ...(params === undefined ? {} : { params }) });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private notify(method: string, params?: unknown): void {
    this.write({ method, ...(params === undefined ? {} : { params }) });
  }

  private async cleanupNewThreadSubscription(threadId: string): Promise<void> {
    try {
      await this.unsubscribeThread(threadId);
    } catch (unsubscribeError) {
      let stopError: unknown;
      try {
        await this.stop();
      } catch (error) {
        stopError = error;
      }
      // Cleanup must never replace the original turn/start error, including when an observer
      // throws while handling the diagnostic event.
      try {
        this.emit(
          "protocolError",
          new BridgeError(
            "CODEX_PROTOCOL_ERROR",
            "Failed to unsubscribe newly-started Codex thread after turn/start failed",
            true,
            { cause: unsubscribeError },
          ),
        );
      } catch {
        // Preserve the original turn/start error.
      }
      if (stopError !== undefined) {
        try {
          this.emit(
            "protocolError",
            new BridgeError(
              "CODEX_START_FAILED",
              "Failed to terminate Codex App Server after thread unsubscribe failed",
              true,
              { cause: stopError },
            ),
          );
        } catch {
          // Preserve the original turn/start error.
        }
      }
    }
  }

  private async stopAfterUncertainThreadStart(): Promise<void> {
    try {
      await this.stop();
    } catch (stopError) {
      // Cleanup is diagnostic only and must not replace the original thread/start failure.
      try {
        this.emit(
          "protocolError",
          new BridgeError(
            "CODEX_START_FAILED",
            "Failed to terminate Codex App Server after uncertain thread/start outcome",
            true,
            { cause: stopError },
          ),
        );
      } catch {
        // Preserve the original error even if an observer throws.
      }
    }
  }

  private write(message: JsonRpcMessage): void {
    if (!this.child?.stdin.writable)
      throw new BridgeError("CODEX_START_FAILED", "Codex App Server is not running", true);
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch (error) {
      this.emit(
        "protocolError",
        new BridgeError("CODEX_PROTOCOL_ERROR", "Invalid JSONL from Codex", false, {
          cause: error,
        }),
      );
      return;
    }
    if ("id" in message && !("method" in message)) {
      const response = message as JsonRpcResponse;
      const pending = this.pending.get(response.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(response.id);
      if (response.error)
        pending.reject(new BridgeError("CODEX_PROTOCOL_ERROR", response.error.message));
      else pending.resolve(response.result);
      return;
    }
    if ("id" in message && "method" in message) {
      const request = message as import("./protocol-types.js").JsonRpcRequest;
      if (this.serverRequestHandler) {
        this.serverRequestHandler({
          request,
          respond: (result) => this.respondToServerRequest(request.id, result),
          reject: (error) => this.rejectServerRequest(request.id, error),
        });
      } else {
        void this.rejectServerRequest(request.id, {
          code: -32601,
          message: `Unsupported App Server request ${request.method}`,
        });
      }
    }
    this.notificationBuffer.push(message);
    if (this.notificationBuffer.length > 200) this.notificationBuffer.shift();
    const normalized = normalizeCodexEvent(message);
    if (normalized) this.emit("event", normalized);
    this.emit("message", message);
  }

  private waitForTurn(
    threadId: string,
    turnId: string,
    signal?: AbortSignal,
    onProgress?: (event: import("./protocol-types.js").NormalizedCodexEvent) => void,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      let finalText = "";
      let finished = false;
      let timingOut = false;
      let timer: NodeJS.Timeout | undefined;
      const abortError = (): Error =>
        signal?.reason instanceof Error
          ? signal.reason
          : new BridgeError("CODEX_INTERRUPTED", "Codex turn waiter was cancelled");
      const finish = (error?: Error): void => {
        if (finished) return;
        finished = true;
        if (timer) clearTimeout(timer);
        this.off("message", onMessage);
        this.off("terminated", onTerminated);
        signal?.removeEventListener("abort", onAbort);
        if (error) reject(error);
        else resolve(finalText || "Codex completed without a final text message.");
      };
      const onTerminated = (error: Error): void => {
        if (!timingOut) finish(error);
      };
      const onAbort = (): void => {
        if (!timingOut) finish(abortError());
      };
      const onMessage = (message: JsonRpcMessage): void => {
        if (!("method" in message)) return;
        const params = message.params as Record<string, unknown> | undefined;
        const ids = extractNotificationIds(params);
        if (ids.threadId !== threadId || ids.turnId !== turnId) return;
        const progress = normalizeCodexEvent(message);
        if (progress) onProgress?.(progress);
        if (message.method === "item/completed") finalText = extractAgentText(params) ?? finalText;
        if (message.method === "turn/completed") {
          const completion = extractTurnCompletion(params);
          if (completion.status === "failed") {
            finish(
              new BridgeError("CODEX_PROTOCOL_ERROR", completion.error ?? "Codex turn failed"),
            );
          } else if (completion.status === "interrupted") {
            finish(new BridgeError("CODEX_INTERRUPTED", "Codex turn was interrupted"));
          } else {
            finish();
          }
        }
      };

      this.on("message", onMessage);
      this.once("terminated", onTerminated);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) {
        finish(abortError());
        return;
      }
      timer = setTimeout(() => {
        timingOut = true;
        const timeoutSeconds = Math.ceil(this.options.turnTimeoutMs / 1_000);
        const timeoutError = new BridgeError(
          "CODEX_TIMEOUT",
          `Codex turn timed out after ${timeoutSeconds}s; interrupt requested`,
          true,
        );
        void (async () => {
          try {
            await this.interrupt(threadId, turnId);
          } catch (error) {
            try {
              this.emit(
                "protocolError",
                new BridgeError(
                  "CODEX_PROTOCOL_ERROR",
                  "Failed to interrupt timed-out Codex turn",
                  true,
                  { cause: error },
                ),
              );
            } catch {
              // The timeout remains the user-facing failure even if a diagnostic observer throws.
            }
            try {
              await this.stop();
            } catch (stopError) {
              try {
                this.emit(
                  "protocolError",
                  new BridgeError(
                    "CODEX_START_FAILED",
                    "Failed to terminate Codex App Server after timed-out turn interrupt failed",
                    true,
                    { cause: stopError },
                  ),
                );
              } catch {
                // Preserve the timeout as the original error.
              }
            }
          } finally {
            finish(timeoutError);
          }
        })();
      }, this.options.turnTimeoutMs);
      for (const message of this.notificationBuffer) onMessage(message);
    });
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private handleTermination(error: Error): void {
    this.failAll(error);
    this.emit("terminated", error);
  }
}
