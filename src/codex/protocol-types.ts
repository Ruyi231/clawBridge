export type JsonRpcId = number | string;

export interface JsonRpcRequest {
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface CodexServerRequestContext {
  request: JsonRpcRequest;
  respond: (result: unknown) => Promise<void>;
  reject: (error: { code: number; message: string; data?: unknown }) => Promise<void>;
}

export interface JsonRpcNotification {
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

export interface CodexTurnResult {
  threadId: string;
  turnId: string;
  finalText: string;
}

export interface CodexThreadSummary {
  id: string;
  name: string | null;
  preview: string;
  cwd: string | null;
  updatedAt: number | null;
  status: string;
}

export interface CodexThreadTextMessage {
  role: "user" | "assistant";
  text: string;
  phase: string | null;
}

export interface CodexThreadTurnSummary {
  id: string;
  status: string;
  startedAt: number | null;
  completedAt: number | null;
  messages: CodexThreadTextMessage[];
}

export interface CodexThreadDetails extends CodexThreadSummary {
  turns: CodexThreadTurnSummary[];
}

export interface CodexThreadListInput {
  cwd: string;
  limit?: number;
  cursor?: string | null;
  archived?: boolean;
}

export interface CodexThreadStartInput {
  cwd: string;
  approvalPolicy: "unlessTrusted" | "onRequest" | "never";
  sandbox: "readOnly" | "workspaceWrite";
}

export interface CodexReasoningEffortOption {
  reasoningEffort: string;
  description: string;
}

export interface CodexModelInfo {
  id: string;
  model: string;
  displayName: string;
  description: string;
  isDefault: boolean;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: CodexReasoningEffortOption[];
}

export type CodexThreadUnsubscribeStatus = "notLoaded" | "notSubscribed" | "unsubscribed";

export type NormalizedCodexEvent =
  | {
      type: "assistantDelta";
      threadId?: string;
      turnId?: string;
      delta: string;
    }
  | {
      type: "plan";
      threadId?: string;
      turnId?: string;
      steps: Array<{ step: string; status: string }>;
    }
  | {
      type: "command";
      threadId?: string;
      turnId?: string;
      command: string;
      status: string;
      exitCode: number | null;
    }
  | {
      type: "fileChange";
      threadId?: string;
      turnId?: string;
      paths: string[];
      status: string;
    }
  | { type: "error"; threadId?: string; turnId?: string; message: string };

export interface CodexRunner {
  setServerRequestHandler(handler: (context: CodexServerRequestContext) => void): void;
  runTurn(input: {
    cwd: string;
    prompt: string;
    threadId?: string | null;
    approvalPolicy: "unlessTrusted" | "onRequest" | "never";
    sandbox: "readOnly" | "workspaceWrite";
    model?: string;
    reasoningEffort?: string;
    onStarted?: (ids: { threadId: string; turnId: string }) => void;
    onProgress?: (event: NormalizedCodexEvent) => void;
  }): Promise<CodexTurnResult>;
  listModels(): Promise<CodexModelInfo[]>;
  startThread(input: CodexThreadStartInput): Promise<CodexThreadSummary>;
  listThreads(input: CodexThreadListInput): Promise<CodexThreadSummary[]>;
  readThread(threadId: string): Promise<CodexThreadSummary>;
  readThreadDetails(threadId: string, includeTurns?: boolean): Promise<CodexThreadDetails>;
  nameThread(threadId: string, name: string): Promise<void>;
  archiveThread(threadId: string): Promise<void>;
  unarchiveThread(threadId: string): Promise<CodexThreadSummary>;
  unsubscribeThread(threadId: string): Promise<CodexThreadUnsubscribeStatus>;
  interrupt(threadId: string, turnId: string): Promise<void>;
  stop(): Promise<void>;
}
