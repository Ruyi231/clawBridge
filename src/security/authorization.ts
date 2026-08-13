import { BridgeError } from "../core/errors.js";
import type { InboundEvent } from "../core/types.js";

export interface AuthorizationPolicy {
  allowedOpenId: string;
  directMessagesOnly: boolean;
}

export function authorizeMessage(message: InboundEvent, policy: AuthorizationPolicy): void {
  if (message.senderOpenId !== policy.allowedOpenId) {
    throw new BridgeError("UNAUTHORIZED", "Sender is not authorized");
  }
  if (policy.directMessagesOnly && message.chatType !== "p2p") {
    throw new BridgeError("GROUP_DISABLED", "Group messages are disabled");
  }
}
