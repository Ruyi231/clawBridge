import { describe, expect, it } from "vitest";
import { parseFeishuCardAction, parseFeishuMessage } from "../../src/channels/feishu-event.js";

describe("Feishu message contract", () => {
  it("parses an im.message.receive_v1 text event", () => {
    const message = parseFeishuMessage({
      schema: "2.0",
      header: {
        event_id: "evt-1",
        create_time: "1700000000000",
        event_type: "im.message.receive_v1",
      },
      event: {
        sender: { sender_id: { open_id: "ou-1" } },
        message: {
          message_id: "om-1",
          chat_id: "oc-1",
          chat_type: "p2p",
          message_type: "text",
          content: JSON.stringify({ text: "  run tests  " }),
        },
      },
    });
    expect(message).toMatchObject({ eventId: "evt-1", senderOpenId: "ou-1", text: "run tests" });
  });

  it("ignores non-text messages", () => {
    expect(
      parseFeishuMessage({
        header: { event_id: "evt-2" },
        event: {
          sender: { sender_id: { open_id: "ou-1" } },
          message: {
            message_id: "om-2",
            chat_id: "oc-1",
            chat_type: "p2p",
            message_type: "image",
            content: "{}",
          },
        },
      }),
    ).toBeNull();
  });

  it("parses the flattened payload emitted by the Node SDK dispatcher", () => {
    expect(
      parseFeishuMessage({
        event_id: "evt-sdk-1",
        create_time: "1700000000000",
        sender: { sender_id: { open_id: "ou-sdk-owner" }, sender_type: "user" },
        message: {
          message_id: "om-sdk-1",
          chat_id: "oc-sdk-1",
          chat_type: "p2p",
          message_type: "text",
          content: JSON.stringify({ text: "hello from sdk" }),
          create_time: "1700000000000",
        },
      }),
    ).toMatchObject({
      eventId: "evt-sdk-1",
      senderOpenId: "ou-sdk-owner",
      text: "hello from sdk",
    });
  });

  it("preserves Feishu topic routing fields for group messages", () => {
    expect(
      parseFeishuMessage({
        event_id: "evt-topic-1",
        sender: { sender_id: { open_id: "ou-owner" } },
        message: {
          message_id: "om-reply-1",
          root_id: "om-topic-root-1",
          parent_id: "om-topic-root-1",
          thread_id: "omt-thread-1",
          chat_id: "oc-project-1",
          chat_type: "group",
          message_type: "text",
          content: JSON.stringify({ text: "continue this task" }),
        },
      }),
    ).toMatchObject({
      chatType: "group",
      chatId: "oc-project-1",
      topicRootId: "om-topic-root-1",
      feishuThreadId: "omt-thread-1",
    });
  });
});

describe("Feishu card action contract", () => {
  it("parses a card.action.trigger v2 envelope", () => {
    expect(
      parseFeishuCardAction({
        schema: "2.0",
        header: {
          event_id: "evt-card-1",
          create_time: "1700000000000",
          event_type: "card.action.trigger",
        },
        event: {
          operator: { open_id: "ou-card-owner" },
          context: {
            open_message_id: "om-card-1",
            open_chat_id: "oc-card-1",
          },
          action: {
            tag: "button",
            value: { action: "refresh", protocol: "clawbridge.card.v1" },
          },
        },
      }),
    ).toEqual({
      kind: "card_action",
      eventId: "evt-card-1",
      messageId: "om-card-1",
      chatId: "oc-card-1",
      chatType: "unknown",
      senderOpenId: "ou-card-owner",
      value: { action: "refresh", protocol: "clawbridge.card.v1" },
      receivedAt: "2023-11-14T22:13:20.000Z",
    });
  });

  it("parses the flattened payload emitted by EventDispatcher", () => {
    expect(
      parseFeishuCardAction({
        event_id: "evt-card-sdk-1",
        create_time: "1700000000000",
        operator: { open_id: "ou-sdk-owner", user_id: "user-1" },
        context: {
          open_message_id: "om-card-sdk-1",
          open_chat_id: "oc-card-sdk-1",
        },
        action: {
          tag: "select_static",
          value: { action: "project_use", projectId: "bridge-dev" },
          option: "bridge-dev",
        },
      }),
    ).toMatchObject({
      eventId: "evt-card-sdk-1",
      messageId: "om-card-sdk-1",
      chatId: "oc-card-sdk-1",
      senderOpenId: "ou-sdk-owner",
      value: { action: "project_use", projectId: "bridge-dev" },
      option: "bridge-dev",
    });
  });

  it.each([
    ["event id", { operator: { open_id: "ou-1" } }],
    [
      "chat id",
      {
        event_id: "evt-1",
        operator: { open_id: "ou-1" },
        context: { open_message_id: "om-1" },
        action: { value: { action: "refresh" } },
      },
    ],
    [
      "operator open id",
      {
        event_id: "evt-1",
        operator: {},
        context: { open_message_id: "om-1", open_chat_id: "oc-1" },
        action: { value: { action: "refresh" } },
      },
    ],
    [
      "action value",
      {
        event_id: "evt-1",
        operator: { open_id: "ou-1" },
        context: { open_message_id: "om-1", open_chat_id: "oc-1" },
        action: {},
      },
    ],
  ])("rejects a card callback without %s", (_label, payload) => {
    expect(() => parseFeishuCardAction(payload)).toThrow();
  });

  it("rejects a scalar action value instead of treating it as a command", () => {
    expect(() =>
      parseFeishuCardAction({
        event_id: "evt-card-invalid",
        operator: { open_id: "ou-1" },
        context: { open_message_id: "om-1", open_chat_id: "oc-1" },
        action: { value: "/project use arbitrary-path" },
      }),
    ).toThrow();
  });
});
