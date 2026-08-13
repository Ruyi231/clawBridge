interface RecordLike {
  [key: string]: unknown;
}

function asRecord(value: unknown): RecordLike | undefined {
  return typeof value === "object" && value !== null ? (value as RecordLike) : undefined;
}

function withIds(params: unknown): { threadId?: string; turnId?: string } {
  return extractNotificationIds(params);
}

export function extractAgentText(params: unknown): string | undefined {
  const root = asRecord(params);
  const item = asRecord(root?.item);
  if (item?.type !== "agentMessage") return undefined;
  if (typeof item.text === "string") return item.text;
  const content = Array.isArray(item.content) ? item.content : [];
  const text = content
    .map((part) => asRecord(part))
    .filter((part): part is RecordLike => part !== undefined && typeof part.text === "string")
    .map((part) => String(part.text))
    .join("");
  return text || undefined;
}

export function extractIds(result: unknown): { threadId?: string; turnId?: string } {
  const root = asRecord(result);
  const thread = asRecord(root?.thread);
  const turn = asRecord(root?.turn);
  return {
    ...(typeof thread?.id === "string" ? { threadId: thread.id } : {}),
    ...(typeof turn?.id === "string" ? { turnId: turn.id } : {}),
  };
}

export function extractNotificationIds(params: unknown): { threadId?: string; turnId?: string } {
  const root = asRecord(params);
  const turn = asRecord(root?.turn);
  return {
    ...(typeof root?.threadId === "string" ? { threadId: root.threadId } : {}),
    ...(typeof root?.turnId === "string"
      ? { turnId: root.turnId }
      : typeof turn?.id === "string"
        ? { turnId: turn.id }
        : {}),
  };
}

export function extractTurnCompletion(params: unknown): { status?: string; error?: string } {
  const root = asRecord(params);
  const turn = asRecord(root?.turn);
  const error = asRecord(turn?.error);
  return {
    ...(typeof turn?.status === "string" ? { status: turn.status } : {}),
    ...(typeof error?.message === "string" ? { error: error.message } : {}),
  };
}

export function extractThreadSummary(
  value: unknown,
): import("./protocol-types.js").CodexThreadSummary {
  const thread = asRecord(value);
  if (typeof thread?.id !== "string") throw new Error("Codex thread is missing an id");
  const status = asRecord(thread.status);
  return {
    id: thread.id,
    name: typeof thread.name === "string" ? thread.name : null,
    preview: typeof thread.preview === "string" ? thread.preview : "",
    cwd: typeof thread.cwd === "string" ? thread.cwd : null,
    updatedAt: typeof thread.updatedAt === "number" ? thread.updatedAt : null,
    status: typeof status?.type === "string" ? status.type : "unknown",
  };
}

export function extractThreadList(
  result: unknown,
): import("./protocol-types.js").CodexThreadSummary[] {
  const root = asRecord(result);
  if (!Array.isArray(root?.data)) throw new Error("thread/list did not return data");
  return root.data.map(extractThreadSummary);
}

export function extractThreadRead(
  result: unknown,
): import("./protocol-types.js").CodexThreadSummary {
  const root = asRecord(result);
  return extractThreadSummary(root?.thread);
}

function extractThreadTextMessages(
  turnValue: unknown,
): import("./protocol-types.js").CodexThreadTextMessage[] {
  const turn = asRecord(turnValue);
  const items = Array.isArray(turn?.items) ? turn.items : [];
  const messages: import("./protocol-types.js").CodexThreadTextMessage[] = [];

  for (const itemValue of items) {
    const item = asRecord(itemValue);
    if (item?.type === "userMessage") {
      const content = Array.isArray(item.content) ? item.content : [];
      const text = content
        .map(asRecord)
        .filter(
          (part): part is RecordLike =>
            part !== undefined && part.type === "text" && typeof part.text === "string",
        )
        .map((part) => String(part.text))
        .join("");
      if (text) messages.push({ role: "user", text, phase: null });
      continue;
    }

    if (item?.type === "agentMessage" && typeof item.text === "string" && item.text) {
      messages.push({
        role: "assistant",
        text: item.text,
        phase: typeof item.phase === "string" ? item.phase : null,
      });
    }
  }

  return messages;
}

function extractThreadTurn(value: unknown): import("./protocol-types.js").CodexThreadTurnSummary {
  const turn = asRecord(value);
  if (typeof turn?.id !== "string") throw new Error("Codex turn is missing an id");
  return {
    id: turn.id,
    status: typeof turn.status === "string" ? turn.status : "unknown",
    startedAt: typeof turn.startedAt === "number" ? turn.startedAt : null,
    completedAt: typeof turn.completedAt === "number" ? turn.completedAt : null,
    messages: extractThreadTextMessages(turn),
  };
}

export function extractThreadDetails(
  result: unknown,
): import("./protocol-types.js").CodexThreadDetails {
  const root = asRecord(result);
  const thread = asRecord(root?.thread);
  const summary = extractThreadSummary(thread);
  const turns = Array.isArray(thread?.turns) ? thread.turns.map(extractThreadTurn) : [];
  return { ...summary, turns };
}

export function normalizeCodexEvent(
  message: import("./protocol-types.js").JsonRpcMessage,
): import("./protocol-types.js").NormalizedCodexEvent | undefined {
  if (!("method" in message)) return undefined;
  const params = asRecord(message.params);
  const ids = withIds(params);

  if (message.method === "item/agentMessage/delta" && typeof params?.delta === "string") {
    return { type: "assistantDelta", ...ids, delta: params.delta };
  }

  if (message.method === "turn/plan/updated" && Array.isArray(params?.plan)) {
    const steps = params.plan
      .map(asRecord)
      .filter((item): item is RecordLike => item !== undefined)
      .filter((item) => typeof item.step === "string" && typeof item.status === "string")
      .map((item) => ({ step: String(item.step), status: String(item.status) }));
    return { type: "plan", ...ids, steps };
  }

  if (message.method === "item/completed") {
    const item = asRecord(params?.item);
    if (item?.type === "commandExecution") {
      const command = Array.isArray(item.command)
        ? item.command.map(String).join(" ")
        : typeof item.command === "string"
          ? item.command
          : "";
      return {
        type: "command",
        ...ids,
        command,
        status: typeof item.status === "string" ? item.status : "unknown",
        exitCode: typeof item.exitCode === "number" ? item.exitCode : null,
      };
    }
    if (item?.type === "fileChange") {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      const paths = changes
        .map(asRecord)
        .filter((change): change is RecordLike => change !== undefined)
        .filter((change) => typeof change.path === "string")
        .map((change) => String(change.path));
      return {
        type: "fileChange",
        ...ids,
        paths,
        status: typeof item.status === "string" ? item.status : "unknown",
      };
    }
  }

  if (message.method === "error") {
    const error = asRecord(params?.error);
    if (typeof error?.message === "string")
      return { type: "error", ...ids, message: error.message };
  }
  return undefined;
}
