import { z } from "zod";
import type { InboundCardAction, InboundMessage } from "../core/types.js";

const messageSchema = z.object({
  message_id: z.string().min(1),
  chat_id: z.string().min(1),
  chat_type: z.enum(["p2p", "group"]),
  message_type: z.string(),
  content: z.string(),
  create_time: z.string().optional(),
});

const senderSchema = z.object({ sender_id: z.object({ open_id: z.string().min(1) }) });

const envelopeSchema = z.object({
  schema: z.string().optional(),
  header: z.object({
    event_id: z.string().min(1),
    create_time: z.string().optional(),
    event_type: z.string().optional(),
  }),
  event: z.object({
    sender: senderSchema,
    message: messageSchema,
  }),
});

const sdkEventSchema = z.object({
  event_id: z.string().min(1).optional(),
  create_time: z.string().optional(),
  sender: senderSchema,
  message: messageSchema,
});

const contentSchema = z.object({ text: z.string() });

const cardOperatorSchema = z.object({ open_id: z.string().min(1) });
const cardContextSchema = z.object({
  open_message_id: z.string().min(1),
  open_chat_id: z.string().min(1),
});
const cardActionSchema = z.object({
  value: z.record(z.string(), z.unknown()),
  option: z.string().min(1).optional(),
});

const cardEnvelopeSchema = z.object({
  schema: z.string().optional(),
  header: z.object({
    event_id: z.string().min(1),
    create_time: z.string().optional(),
    event_type: z.string().optional(),
  }),
  event: z.object({
    operator: cardOperatorSchema,
    context: cardContextSchema,
    action: cardActionSchema,
  }),
});

// EventDispatcher flattens a v2 envelope before invoking a registered handler.
const cardSdkEventSchema = z.object({
  event_id: z.string().min(1),
  create_time: z.string().optional(),
  operator: cardOperatorSchema,
  context: cardContextSchema,
  action: cardActionSchema,
});

export function parseFeishuMessage(payload: unknown): InboundMessage | null {
  const root = typeof payload === "object" && payload !== null ? payload : {};
  const envelope = "event" in root ? envelopeSchema.parse(payload) : undefined;
  const sdkEvent = envelope ? undefined : sdkEventSchema.parse(payload);
  const eventId = envelope?.header.event_id ?? sdkEvent?.event_id;
  const sender = envelope?.event.sender ?? sdkEvent?.sender;
  const message = envelope?.event.message ?? sdkEvent?.message;
  if (!sender || !message) throw new Error("Feishu event is missing sender or message");
  if (message.message_type !== "text") return null;
  const content = contentSchema.parse(JSON.parse(message.content));
  const timestamp = envelope?.header.create_time ?? sdkEvent?.create_time ?? message.create_time;
  return {
    eventId: eventId ?? `message:${message.message_id}`,
    messageId: message.message_id,
    chatId: message.chat_id,
    chatType: message.chat_type,
    senderOpenId: sender.sender_id.open_id,
    text: content.text.trim(),
    receivedAt: timestamp ? new Date(Number(timestamp)).toISOString() : new Date().toISOString(),
  };
}

export function parseFeishuCardAction(payload: unknown): InboundCardAction {
  const envelopeResult = cardEnvelopeSchema.safeParse(payload);
  const envelope = envelopeResult.success ? envelopeResult.data : undefined;
  const sdkEvent = envelope ? undefined : cardSdkEventSchema.parse(payload);
  const event = envelope?.event ?? sdkEvent;
  if (!event) throw new Error("Feishu card action is missing event data");
  const timestamp = envelope?.header.create_time ?? sdkEvent?.create_time;

  return {
    kind: "card_action",
    eventId: envelope?.header.event_id ?? sdkEvent!.event_id,
    messageId: event.context.open_message_id,
    chatId: event.context.open_chat_id,
    chatType: "unknown",
    senderOpenId: event.operator.open_id,
    value: event.action.value,
    ...(event.action.option ? { option: event.action.option } : {}),
    receivedAt: timestamp ? new Date(Number(timestamp)).toISOString() : new Date().toISOString(),
  };
}
