import type { InboundEvent, OutboundMessage } from "../core/types.js";

export interface ChannelAdapter {
  start(onEvent: (event: InboundEvent) => Promise<void>): Promise<void>;
  stop(): Promise<void>;
  send(message: OutboundMessage): Promise<string>;
  onFatalError?(handler: (error: Error) => void): void;
}
