import readline from "node:readline";

const input = readline.createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const initializeDelayArgument = process.argv.find((argument) =>
  argument.startsWith("--initialize-delay="),
);
const initializeDelayMs = Number(initializeDelayArgument?.split("=")[1] ?? 0);
const requireInitialized = process.argv.includes("--require-initialized");
const failInterrupt = process.argv.includes("--fail-interrupt");
const failTurnStart = process.argv.includes("--fail-turn-start");
const invalidTurnStart = process.argv.includes("--invalid-turn-start");
const reportPid = process.argv.includes("--report-pid");
const unsubscribeStatusArgument = process.argv.find((argument) =>
  argument.startsWith("--unsubscribe-status="),
);
const unsubscribeStatus = unsubscribeStatusArgument?.split("=")[1] ?? "unsubscribed";
let initialized = false;
let activeThreadId;
let activeTurnId;
let threadName = "Fake thread";
let archived = false;

const threadSummary = (cwd = process.cwd()) => ({
  id: "thread-test",
  name: threadName,
  preview: "fake result",
  cwd,
  updatedAt: 1,
  status: { type: "notLoaded" },
});

input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    const respond = () =>
      send({ id: message.id, result: { serverInfo: { name: "fake", version: "1" } } });
    if (initializeDelayMs > 0) setTimeout(respond, initializeDelayMs);
    else respond();
    return;
  }
  if (message.method === "initialized") {
    initialized = true;
    if (reportPid) send({ method: "test/serverPid", params: { pid: process.pid } });
    return;
  }
  if (requireInitialized && !initialized) {
    if ("id" in message) {
      send({
        id: message.id,
        error: { code: -32000, message: "business request arrived before initialized" },
      });
    }
    return;
  }
  if (message.method === "thread/start") {
    const validPolicy =
      ["on-request", "untrusted", "never"].includes(message.params.approvalPolicy) &&
      ["workspace-write", "read-only"].includes(message.params.sandbox) &&
      message.params.threadSource === "user";
    if (!validPolicy) {
      send({ id: message.id, error: { code: -32602, message: "invalid thread start params" } });
    } else {
      send({ id: message.id, result: { thread: threadSummary(message.params.cwd) } });
    }
  }
  if (message.method === "thread/resume")
    send({ id: message.id, result: { thread: { id: message.params.threadId } } });
  if (message.method === "thread/list")
    send({
      id: message.id,
      result: {
        data:
          Boolean(message.params.archived) === archived
            ? [
                {
                  ...threadSummary(message.params.cwd),
                  preview: `${message.params.cursor ?? "first-page"}:${
                    message.params.archived === true ? "archived" : "active"
                  }`,
                },
              ]
            : [],
        nextCursor: null,
      },
    });
  if (message.method === "thread/read")
    send({
      id: message.id,
      result: {
        thread: {
          ...threadSummary(),
          id: message.params.threadId,
          turns: message.params.includeTurns
            ? [
                {
                  id: "turn-history",
                  status: "completed",
                  startedAt: 10,
                  completedAt: 11,
                  items: [
                    {
                      id: "user-history",
                      type: "userMessage",
                      content: [
                        { type: "text", text: "history question" },
                        { type: "image", url: "https://example.test/image.png" },
                      ],
                    },
                    {
                      id: "command-history",
                      type: "commandExecution",
                      command: "ignored by text history",
                    },
                    {
                      id: "agent-commentary",
                      type: "agentMessage",
                      text: "history progress",
                      phase: "commentary",
                    },
                    {
                      id: "agent-history",
                      type: "agentMessage",
                      text: "history answer",
                      phase: "final_answer",
                    },
                  ],
                },
              ]
            : [],
        },
      },
    });
  if (message.method === "thread/name/set") {
    if (typeof message.params.threadId !== "string" || typeof message.params.name !== "string") {
      send({ id: message.id, error: { code: -32602, message: "invalid thread name params" } });
    } else {
      threadName = message.params.name;
      send({ id: message.id, result: {} });
    }
  }
  if (message.method === "thread/archive") {
    if (typeof message.params.threadId !== "string") {
      send({ id: message.id, error: { code: -32602, message: "invalid archive params" } });
    } else {
      archived = true;
      send({ id: message.id, result: {} });
    }
  }
  if (message.method === "thread/unarchive") {
    if (typeof message.params.threadId !== "string") {
      send({ id: message.id, error: { code: -32602, message: "invalid unarchive params" } });
    } else {
      archived = false;
      send({ id: message.id, result: { thread: threadSummary() } });
    }
  }
  if (message.method === "thread/unsubscribe") {
    if (typeof message.params.threadId !== "string") {
      send({ id: message.id, error: { code: -32602, message: "invalid unsubscribe params" } });
    } else {
      send({ id: message.id, result: { status: unsubscribeStatus } });
      send({
        method: "test/unsubscribeObserved",
        params: { threadId: message.params.threadId },
      });
    }
  }
  if (message.method === "turn/interrupt") {
    if (failInterrupt) {
      send({ id: message.id, error: { code: -32001, message: "interrupt failed" } });
      return;
    }
    send({ id: message.id, result: {} });
    send({
      method: "test/interruptObserved",
      params: { threadId: message.params.threadId, turnId: message.params.turnId },
    });
  }
  if (message.method === "turn/start") {
    const validSandboxPolicy =
      (message.params.sandboxPolicy?.type === "workspaceWrite" ||
        message.params.sandboxPolicy?.type === "readOnly") &&
      message.params.sandboxPolicy?.networkAccess === false;
    if (!validSandboxPolicy) {
      send({ id: message.id, error: { code: -32602, message: "invalid turn policy" } });
      return;
    }
    if (failTurnStart) {
      send({ id: message.id, error: { code: -32002, message: "turn start failed" } });
      return;
    }
    if (invalidTurnStart) {
      send({ id: message.id, result: { turn: {} } });
      return;
    }
    activeThreadId = message.params.threadId;
    activeTurnId = "turn-test";
    send({ id: message.id, result: { turn: { id: activeTurnId } } });
    const prompt = message.params.input?.find((item) => item.type === "text")?.text;
    if (prompt === "hang") return;
    setTimeout(() => {
      send({
        method: "item/agentMessage/delta",
        params: { threadId: activeThreadId, turnId: activeTurnId, delta: "fake " },
      });
      send({
        method: "item/agentMessage/delta",
        params: { threadId: activeThreadId, turnId: activeTurnId, delta: "result" },
      });
      send({
        method: "item/completed",
        params: {
          threadId: activeThreadId,
          turnId: activeTurnId,
          item: { type: "agentMessage", text: "fake result" },
        },
      });
      send({
        method: "turn/completed",
        params: {
          threadId: activeThreadId,
          turn: { id: activeTurnId, status: "completed", items: [], error: null },
        },
      });
    }, 5);
  }
});
