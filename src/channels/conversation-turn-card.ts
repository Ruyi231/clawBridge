import { redactSecrets } from "../security/redaction.js";
import type { ConversationTurnView } from "./channel-adapter.js";

function safeMarkdown(markdown: string): string {
  let insideFence = false;
  return redactSecrets(markdown)
    .split("\n")
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        insideFence = !insideFence;
        return line;
      }
      if (insideFence) return line;
      return line
        .replace(
          /!\[([^\]]*)\]\([^\r\n)]*\)/g,
          (_match, alt: string) => `🖼️ ${alt.trim() || "图片"}（图片未同步）`,
        )
        .replace(/<img\b[^>]*>/gi, "🖼️ 图片（图片未同步）");
    })
    .join("\n")
    .trim();
}

function safeName(value: string): string {
  return redactSecrets(value)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/([\\*_~`\[\]])/g, "\\$1")
    .trim()
    .slice(0, 160);
}

function attachmentPanel(
  attachments: Array<{ name: string; type: "image" | "file" }> | undefined,
): { title: string; content: string } | undefined {
  if (!attachments?.length) return undefined;
  const imageCount = attachments.filter((item) => item.type === "image").length;
  const fileCount = attachments.length - imageCount;
  const counts = [
    imageCount ? `图片 ${imageCount} 张` : "",
    fileCount ? `文件 ${fileCount} 个` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const names = attachments.map(
    (item) => `${item.type === "image" ? "🖼️" : "📄"} ${safeName(item.name)}`,
  );
  return { title: `📎 附件（${attachments.length}） · ${counts}`, content: names.join("\n") };
}

export function createConversationTurnCard(
  turn: ConversationTurnView,
  options: { streaming?: boolean; assistantElementId?: string } = {},
): Record<string, unknown> {
  const elements: Array<Record<string, unknown>> = [
    {
      tag: "markdown",
      content: `**👤 用户**\n${safeMarkdown(turn.userText) || "（未提供文字）"}`,
    },
  ];
  const attachments = attachmentPanel(turn.attachments);
  if (attachments) {
    elements.push({
      tag: "collapsible_panel",
      expanded: false,
      header: { title: { tag: "plain_text", content: attachments.title } },
      elements: [{ tag: "markdown", content: attachments.content }],
    });
  }
  elements.push(
    { tag: "hr" },
    {
      tag: "markdown",
      ...(options.assistantElementId ? { element_id: options.assistantElementId } : {}),
      content: renderAssistantCardMarkdown(turn.assistantText),
    },
  );
  return {
    schema: "2.0",
    config: {
      ...(options.streaming
        ? {
            streaming_mode: true,
            streaming_config: {
              print_frequency_ms: { default: 60 },
              print_step: { default: 1 },
              print_strategy: "fast",
            },
          }
        : {}),
      summary: { content: turn.title.slice(0, 100) },
    },
    header: {
      template: "blue",
      title: { tag: "plain_text", content: turn.title.slice(0, 80) },
    },
    body: { elements },
  };
}

export function renderAssistantCardMarkdown(text: string): string {
  return `**🤖 Codex**\n${safeMarkdown(text) || "正在连接 Codex…"}`;
}
