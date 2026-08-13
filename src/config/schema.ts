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
  }),
  feishu: z.object({
    appIdEnv: envName,
    appSecretEnv: envName,
    allowedOpenIdEnv: envName,
    directMessagesOnly: z.boolean().default(true),
  }),
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
        })
        .default({ enabled: false }),
    })
    .default({
      allowedRoots: [],
      allowCreateDirectory: false,
      allowRegisterExisting: false,
      codexDesktopProjects: { enabled: false },
    }),
  projectsFile: z.string().min(1),
});

export type BridgeConfig = z.infer<typeof bridgeConfigSchema>;
export type ProjectConfig = z.infer<typeof projectSchema>;
