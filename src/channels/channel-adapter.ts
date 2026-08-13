import type { InboundEvent, OutboundMessage } from "../core/types.js";

export interface ChannelAdapter {
  start(onEvent: (event: InboundEvent) => Promise<void>): Promise<void>;
  stop(): Promise<void>;
  send(message: OutboundMessage): Promise<string>;
  onFatalError?(handler: (error: Error) => void): void;
  createProjectSpace?(input: {
    projectId: string;
    projectName: string;
    ownerOpenId: string;
    idempotencyKey: string;
  }): Promise<{ chatId: string; displayName: string }>;
  createProjectTopic?(input: {
    chatId: string;
    title: string;
    idempotencyKey: string;
  }): Promise<{ topicRootId: string }>;
  startTaskStream?(input: {
    chatId: string;
    replyToMessageId?: string | null;
    title: string;
    initialText: string;
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
