import { redactSecrets } from "../security/redaction.js";
import type {
  ConversationArtifactView,
  ConversationAttachmentView,
  ConversationTurnView,
} from "./channel-adapter.js";

function safeMarkdown(
  markdown: string,
  imageNote = "图片未同步",
  fileNote = "本机文件未同步",
): string {
  let insideFence = false;
  return redactSecrets(markdown)
    .split("\n")
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        insideFence = !insideFence;
        return line;
      }
      if (insideFence) return line;
      const withoutImages = line
        .replace(
          /!\[([^\]]*)\]\([^\r\n)]*\)/g,
          (_match, alt: string) => `🖼️ ${alt.trim() || "图片"}（${imageNote}）`,
        )
        .replace(/<img\b[^>]*>/gi, `🖼️ 图片（${imageNote}）`);
      return withoutImages.replace(
        /\[([^\]]+)\]\((<[^>]+>|[^)\r\n]+)\)/g,
        (match, label: string, destination: string) => {
          const target = destination.trim().replace(/^<|>$/g, "");
          if (/^(?:https?:|mailto:|#)/i.test(target)) return match;
          return `📄 ${label.trim() || "文件"}（${fileNote}）`;
        },
      );
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
  attachments: ConversationAttachmentView[] | undefined,
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

function imageGallery(
  images: Array<{ name: string; imageKey: string }>,
  prefix: string,
): Record<string, unknown>[] {
  const visible = images.slice(0, 6);
  const rows: Record<string, unknown>[] = [];
  for (let offset = 0; offset < visible.length; offset += 2) {
    const row = visible.slice(offset, offset + 2);
    rows.push({
      tag: "column_set",
      element_id: `${prefix}_row_${offset / 2 + 1}`,
      flex_mode: row.length === 2 ? "bisect" : "flow",
      horizontal_spacing: "8px",
      columns: row.map((image, index) => ({
        tag: "column",
        width: "weighted",
        weight: 1,
        elements: [
          {
            tag: "img",
            element_id: `${prefix}_${offset + index + 1}`,
            img_key: image.imageKey,
            alt: { tag: "plain_text", content: safeName(image.name) || "图片" },
            title: {
              tag: "plain_text",
              content: safeName(image.name) || `图片 ${offset + index + 1}`,
            },
            mode: "crop_center",
            preview: true,
          },
        ],
      })),
    });
  }
  return rows;
}

function artifactPanel(
  artifacts: ConversationArtifactView[] | undefined,
): Record<string, unknown>[] {
  if (!artifacts?.length) return [];
  const images = artifacts.filter(
    (item): item is ConversationArtifactView & { imageKey: string } =>
      item.type === "image" && Boolean(item.imageKey),
  );
  const lines = artifacts.map((item) => {
    const suffix =
      item.delivery === "embedded"
        ? "已嵌入预览"
        : item.delivery === "attachment"
          ? "已发送为下方附件"
          : "发送失败，本机文件仍保留";
    return `${item.type === "image" ? "🖼️" : "📄"} ${safeName(item.name)} · ${suffix}`;
  });
  return [
    { tag: "hr" },
    {
      tag: "collapsible_panel",
      expanded: true,
      header: {
        title: { tag: "plain_text", content: `📦 Codex 产物（${artifacts.length}）` },
      },
      elements: [
        ...imageGallery(images, "output_image"),
        { tag: "markdown", content: lines.join("\n") },
      ],
    },
  ];
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
  const inputImages = (turn.attachments ?? []).filter(
    (item): item is ConversationAttachmentView & { imageKey: string } =>
      item.type === "image" && Boolean(item.imageKey),
  );
  if (inputImages.length) {
    elements.push({
      tag: "collapsible_panel",
      expanded: true,
      header: {
        title: { tag: "plain_text", content: `🖼️ 本轮图片预览（${inputImages.length}）` },
      },
      elements: imageGallery(inputImages, "input_image"),
    });
  }
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
      content: renderAssistantCardMarkdown(
        turn.assistantText,
        turn.artifacts?.some((item) => item.type === "image" && item.delivery === "embedded")
          ? "见下方预览"
          : "图片未同步",
        turn.artifacts?.some((item) => item.delivery === "attachment")
          ? "已发送为下方附件"
          : "本机文件未同步",
      ),
    },
  );
  elements.push(...artifactPanel(turn.artifacts));
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

export function renderAssistantCardMarkdown(
  text: string,
  imageNote = "图片未同步",
  fileNote = "本机文件未同步",
): string {
  return `**🤖 Codex**\n${safeMarkdown(text, imageNote, fileNote) || "正在连接 Codex…"}`;
}
