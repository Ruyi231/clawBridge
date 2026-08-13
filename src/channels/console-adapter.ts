import readline from "node:readline";
import { randomUUID } from "node:crypto";
import type { ChannelAdapter } from "./channel-adapter.js";
import type { InboundEvent, OutboundMessage } from "../core/types.js";

export class ConsoleAdapter implements ChannelAdapter {
  private input?: readline.Interface;

  constructor(private readonly senderOpenId: string) {}

  async start(onEvent: (event: InboundEvent) => Promise<void>): Promise<void> {
    this.input = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });
    this.input.setPrompt("claw> ");
    this.input.on("line", (text) => {
      const now = new Date().toISOString();
      void onEvent({
        eventId: randomUUID(),
        messageId: randomUUID(),
        chatId: "console",
        chatType: "p2p",
        senderOpenId: this.senderOpenId,
        text,
        receivedAt: now,
      }).finally(() => this.input?.prompt());
    });
    this.input.prompt();
  }

  async stop(): Promise<void> {
    this.input?.close();
  }

  async send(message: OutboundMessage): Promise<string> {
    process.stdout.write(`\n${message.text}\n`);
    return randomUUID();
  }
}
