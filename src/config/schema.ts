import { z } from "zod";

const envName = z.string().regex(/^[A-Z][A-Z0-9_]*$/);

export const projectSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  name: z.string().min(1).max(100),
  rootPath: z.string().min(1),
  enabled: z.boolean().default(true),
});

export const projectsFileSchema = z.object({
  projects: z.array(projectSchema).min(1),
});

export const bridgeConfigSchema = z.object({
  bridge: z.object({
    databasePath: z.string().min(1).default("./data/clawbridge.db"),
    logLevel: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
    maxConcurrency: z.number().int().min(1).max(4).default(1),
    deliveryMaxAttempts: z.number().int().min(1).max(20).default(5),
    deliveryRetryBaseMs: z.number().int().min(10).max(60_000).default(1_000),
    attachmentDirectory: z.string().min(1).default("./data/attachments"),
    attachmentMaxBytes: z
      .number()
      .int()
      .min(1_024)
      .max(100 * 1024 * 1024)
      .default(20 * 1024 * 1024),
  }),
  feishu: z.object({
    appIdEnv: envName,
    appSecretEnv: envName,
    allowedOpenIdEnv: envName,
    directMessagesOnly: z.boolean().default(true),
  }),
  composer: z
    .object({
      enabled: z.boolean().default(false),
      routingMode: z.enum(["sessionParam", "singleActive"]).default("sessionParam"),
      formUrl: z.string().url().optional(),
      appToken: z.string().min(1).optional(),
      tableId: z.string().min(1).optional(),
      pollIntervalMs: z
        .number()
        .int()
        .min(1_000)
        .max(5 * 60_000)
        .default(5_000),
      maxFiles: z.number().int().min(1).max(50).default(20),
      tokenTtlMinutes: z
        .number()
        .int()
        .min(1)
        .max(24 * 60)
        .default(30),
      fields: z
        .object({
          session: z.string().min(1).default("ClawBridge会话"),
          text: z.string().min(1).default("消息内容"),
          attachments: z.string().min(1).default("附件"),
          status: z.string().min(1).default("处理状态"),
          error: z.string().min(1).default("错误信息"),
        })
        .default({
          session: "ClawBridge会话",
          text: "消息内容",
          attachments: "附件",
          status: "处理状态",
          error: "错误信息",
        }),
      statuses: z
        .object({
          pending: z.string().min(1).default("待处理"),
          processing: z.string().min(1).default("处理中"),
          accepted: z.string().min(1).default("已接收"),
          failed: z.string().min(1).default("失败"),
        })
        .default({ pending: "待处理", processing: "处理中", accepted: "已接收", failed: "失败" }),
    })
    .default({
      enabled: false,
      routingMode: "sessionParam",
      pollIntervalMs: 5_000,
      maxFiles: 20,
      tokenTtlMinutes: 30,
      fields: {
        session: "ClawBridge会话",
        text: "消息内容",
        attachments: "附件",
        status: "处理状态",
        error: "错误信息",
      },
      statuses: { pending: "待处理", processing: "处理中", accepted: "已接收", failed: "失败" },
    })
    .refine(
      (value) => !value.enabled || Boolean(value.formUrl && value.appToken && value.tableId),
      {
        message:
          "composer.formUrl, appToken and tableId are required when composer.enabled is true",
      },
    ),
  codex: z.object({
    command: z.string().min(1).default("codex"),
    args: z.array(z.string()).default(["app-server"]),
    approvalPolicy: z.enum(["unlessTrusted", "onRequest", "never"]).default("never"),
    sandbox: z.enum(["readOnly", "workspaceWrite"]).default("workspaceWrite"),
    requestTimeoutMs: z
      .number()
      .int()
      .min(1_000)
      .max(5 * 60_000)
      .default(30_000),
    turnTimeoutMs: z
      .number()
      .int()
      .min(10_000)
      .max(60 * 60_000)
      .default(10 * 60_000),
  }),
  projectManagement: z
    .object({
      allowedRoots: z.array(z.string().min(1)).default([]),
      allowCreateDirectory: z.boolean().default(false),
      allowRegisterExisting: z.boolean().default(false),
      codexDesktopProjects: z
        .object({
          enabled: z.boolean().default(false),
          stateFile: z.string().min(1).optional(),
          registerCreatedProjects: z.boolean().default(false),
        })
        .default({ enabled: false, registerCreatedProjects: false }),
    })
    .default({
      allowedRoots: [],
      allowCreateDirectory: false,
      allowRegisterExisting: false,
      codexDesktopProjects: { enabled: false, registerCreatedProjects: false },
    }),
  projectsFile: z.string().min(1),
});

export type BridgeConfig = z.infer<typeof bridgeConfigSchema>;
export type ProjectConfig = z.infer<typeof projectSchema>;
