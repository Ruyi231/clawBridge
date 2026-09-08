import type { InboundEvent, OutboundMessage } from "../core/types.js";

export interface ConversationTurnView {
  title: string;
  userText: string;
  assistantText: string;
  attachments?: Array<{ name: string; type: "image" | "file" }>;
}

export interface ChannelAdapter {
  start(onEvent: (event: InboundEvent) => Promise<void>): Promise<void>;
  stop(): Promise<void>;
  send(message: OutboundMessage): Promise<string>;
  /** Replace a bot-authored interactive card without sending a new chat message. */
  updateCardMessage?(messageId: string, card: Record<string, unknown>): Promise<void>;
  /** Withdraw a bot-authored message, used when moving controls below the latest turn. */
  deleteMessage?(messageId: string): Promise<void>;
  onFatalError?(handler: (error: Error) => void): void;
  createProjectSpace?(input: {
    projectId: string;
    projectName: string;
    ownerOpenId: string;
    idempotencyKey: string;
  }): Promise<{ chatId: string; displayName: string }>;
  inspectProjectSpace?(input: { chatId: string; ownerOpenId: string }): Promise<{
    status: "ready" | "owner_absent" | "dissolved" | "missing";
    displayName?: string;
    messageMode?: "chat" | "thread";
    canConfigure?: boolean;
  }>;
  addProjectSpaceMember?(input: { chatId: string; ownerOpenId: string }): Promise<void>;
  removeProjectSpaceMember?(input: { chatId: string; ownerOpenId: string }): Promise<void>;
  deleteProjectSpace?(input: { chatId: string }): Promise<void>;
  configureProjectSpace?(input: { chatId: string }): Promise<void>;
  createProjectTopic?(input: {
    chatId: string;
    title: string;
    idempotencyKey: string;
    historyTurns?: ConversationTurnView[];
  }): Promise<{ topicRootId: string }>;
  startTaskStream?(input: {
    chatId: string;
    replyToMessageId?: string | null;
    title: string;
    userText: string;
    assistantText: string;
    attachments?: Array<{ name: string; type: "image" | "file" }>;
  }): Promise<{ streamId: string; messageId: string }>;
  updateTaskStream?(streamId: string, content: string): Promise<void>;
  finishTaskStream?(streamId: string, summary: string): Promise<void>;
  downloadAttachment?(input: {
    messageId: string;
    fileKey: string;
    type: "image" | "file";
    targetPath: string;
    maxBytes: number;
  }): Promise<void>;
}
