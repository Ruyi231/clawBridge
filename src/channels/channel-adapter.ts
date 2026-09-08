import type { InboundEvent, OutboundMessage } from "../core/types.js";
import type { LocalOutputArtifact } from "../core/output-artifacts.js";

export interface ConversationAttachmentView {
  name: string;
  type: "image" | "file";
  /** Existing Feishu image key, used for an inline preview without re-uploading. */
  imageKey?: string;
  /** Composer-downloaded image that the adapter may upload for preview. */
  localPath?: string;
  /** Bitable attachment token used to rebuild a preview after local cleanup. */
  driveFileToken?: string;
}

export interface ConversationArtifactView {
  name: string;
  type: "image" | "file";
  imageKey?: string;
  delivery: "embedded" | "attachment" | "failed";
}

export interface ConversationTurnView {
  title: string;
  userText: string;
  assistantText: string;
  attachments?: ConversationAttachmentView[];
  artifacts?: ConversationArtifactView[];
  /** Project-local Codex outputs to re-upload when rebuilding historical turns. */
  localArtifacts?: LocalOutputArtifact[];
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
    attachments?: ConversationAttachmentView[];
  }): Promise<{ streamId: string; messageId: string }>;
  updateTaskStream?(streamId: string, content: string): Promise<void>;
  finishTaskStream?(
    streamId: string,
    input: {
      summary: string;
      finalText: string;
      artifacts?: LocalOutputArtifact[];
    },
  ): Promise<void>;
  downloadAttachment?(input: {
    messageId: string;
    fileKey: string;
    type: "image" | "file";
    targetPath: string;
    maxBytes: number;
  }): Promise<void>;
}
