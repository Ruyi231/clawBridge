import { describe, expect, it } from "vitest";
import { authorizeMessage } from "../../src/security/authorization.js";
import type { InboundMessage } from "../../src/core/types.js";

const message: InboundMessage = {
  eventId: "event-1",
  messageId: "message-1",
  chatId: "chat-1",
  chatType: "p2p",
  senderOpenId: "allowed",
  text: "hello",
  receivedAt: new Date(0).toISOString(),
};

describe("authorizeMessage", () => {
  it("allows the configured direct-message sender", () => {
    expect(() =>
      authorizeMessage(message, { allowedOpenId: "allowed", directMessagesOnly: true }),
    ).not.toThrow();
  });

  it("rejects another sender", () => {
    expect(() =>
      authorizeMessage(
        { ...message, senderOpenId: "other" },
        { allowedOpenId: "allowed", directMessagesOnly: true },
      ),
    ).toThrowError(/not authorized/i);
  });

  it("rejects group messages", () => {
    expect(() =>
      authorizeMessage(
        { ...message, chatType: "group" },
        { allowedOpenId: "allowed", directMessagesOnly: true },
      ),
    ).toThrowError(/group/i);
  });
});
