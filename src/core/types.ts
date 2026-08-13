export type TaskState =
  | "queued"
  | "running"
  | "waiting_approval"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export interface InboundMessage {
  eventId: string;
  messageId: string;
  chatId: string;
  chatType: "p2p" | "group";
  senderOpenId: string;
  text: string;
  receivedAt: string;
}

export interface InboundCardAction {
  kind: "card_action";
  eventId: string;
  messageId: string;
  chatId: string;
  /** The current Feishu card callback does not carry chat_type. */
  chatType: "unknown";
  senderOpenId: string;
  value: Record<string, unknown>;
  option?: string | undefined;
  receivedAt: string;
}

export type InboundEvent = InboundMessage | InboundCardAction;

export interface TaskRecord {
  id: string;
  eventId: string;
  chatId: string;
  projectId: string;
  prompt: string;
  state: TaskState;
  threadId: string | null;
  createdAt: string;
  updatedAt: string;
  error: string | null;
}

export interface TextOutboundMessage {
  chatId: string;
  /** Omitted by legacy callers; normalized to `text` before persistence. */
  kind?: "text";
  text: string;
}

export interface CardOutboundMessage {
  chatId: string;
  kind: "card";
  audience: "p2p" | "group";
  /** Plain-text fallback used by the console channel and logs. */
  text: string;
  card: Record<string, unknown>;
}

export type OutboundMessage = TextOutboundMessage | CardOutboundMessage;

export type DeliveryState = "pending" | "sending" | "retry" | "sent" | "dead";

interface DeliveryRecordBase {
  id: string;
  taskId: string | null;
  chatId: string;
  sequence: number;
  state: DeliveryState;
  attempts: number;
  nextAttemptAt: string;
  channelMessageId: string | null;
  lastError: string | null;
  updatedAt: string;
}

export type DeliveryRecord = DeliveryRecordBase &
  (
    | {
        kind: "text";
        payload: { text: string };
        message: TextOutboundMessage;
        /** @deprecated Use `message.text`. Retained for legacy delivery callers. */
        body: string;
      }
    | {
        kind: "card";
        audience: "p2p" | "group";
        payload: { text: string; card: Record<string, unknown> };
        message: CardOutboundMessage;
        /** @deprecated Use `message.card`. Contains the serialized card JSON. */
        body: string;
      }
  );
