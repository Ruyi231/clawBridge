import { redactSecrets } from "../security/redaction.js";

export function renderFinalReply(input: {
  state: "completed" | "failed" | "cancelled";
  text: string;
  projectId: string;
  threadId?: string | null;
}): string {
  const icon = input.state === "completed" ? "✅" : input.state === "cancelled" ? "🛑" : "❌";
  const lines = [
    `${icon} ${input.state}`,
    "",
    redactSecrets(input.text),
    "",
    `项目：${input.projectId}`,
  ];
  if (input.threadId) lines.push(`线程：${input.threadId}`);
  return lines.join("\n");
}

export function splitMessage(text: string, maximumLength = 3_500): string[] {
  const safe = redactSecrets(text);
  if (safe.length <= maximumLength) return [safe];
  const chunks: string[] = [];
  let remaining = safe;
  while (remaining.length > maximumLength) {
    const candidate = remaining.slice(0, maximumLength);
    const splitAt = Math.max(candidate.lastIndexOf("\n"), candidate.lastIndexOf(" "));
    const length = splitAt > maximumLength / 2 ? splitAt : maximumLength;
    chunks.push(remaining.slice(0, length));
    remaining = remaining.slice(length).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}
