export type JsonRpcId = number | string;

export interface JsonRpcRequest {
  id: JsonRpcId;
  method: string;
  params?: unknown;
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

export type CodexThreadUnsubscribeStatus = "notLoaded" | "notSubscribed" | "unsubscribed";

export type NormalizedCodexEvent =
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
  runTurn(input: {
    cwd: string;
    prompt: string;
    threadId?: string | null;
    approvalPolicy: "unlessTrusted" | "onRequest" | "never";
    sandbox: "readOnly" | "workspaceWrite";
    onStarted?: (ids: { threadId: string; turnId: string }) => void;
  }): Promise<CodexTurnResult>;
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
