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
}
