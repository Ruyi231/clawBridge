import * as lark from "@larksuiteoapi/node-sdk";

const [appToken, tableId] = process.argv.slice(2);
const appId = process.env.CLAWBRIDGE_FEISHU_APP_ID?.trim();
const appSecret = process.env.CLAWBRIDGE_FEISHU_APP_SECRET?.trim();

if (!appToken || !tableId) {
  throw new Error("Usage: node scripts/configure-cloud-composer.mjs <appToken> <tableId>");
}
if (!appId || !appSecret) {
  throw new Error("ClawBridge Feishu credentials are not available in the process environment");
}

const silentLogger = { debug() {}, info() {}, warn() {}, error() {}, trace() {} };
const client = new lark.Client({ appId, appSecret, logger: silentLogger });
const path = { app_token: appToken, table_id: tableId };
let listed;
try {
  listed = await client.bitable.appTableField.list({ path, params: { page_size: 100 } });
} catch (error) {
  const response = error?.response?.data;
  throw new Error(
    `Unable to read Bitable fields: ${response?.code ?? "request_failed"} ${response?.msg ?? error?.message ?? ""}`,
  );
}
if (listed.code !== 0) {
  throw new Error(`Unable to read Bitable fields: ${listed.code ?? "unknown"} ${listed.msg ?? ""}`);
}

const desired = [
  { field_name: "ClawBridge会话", type: 1, ui_type: "Text" },
  { field_name: "消息内容", type: 1, ui_type: "Text" },
  { field_name: "附件", type: 17, ui_type: "Attachment" },
  {
    field_name: "处理状态",
    type: 3,
    ui_type: "SingleSelect",
    property: {
      options: [
        { name: "待处理", color: 0 },
        { name: "处理中", color: 1 },
        { name: "已接收", color: 2 },
        { name: "失败", color: 4 },
      ],
    },
  },
  { field_name: "错误信息", type: 1, ui_type: "Text" },
];

const existing = new Map((listed.data?.items ?? []).map((field) => [field.field_name, field]));
const incompatible = desired.filter((field) => {
  const current = existing.get(field.field_name);
  return current && current.type !== field.type;
});
if (incompatible.length) {
  throw new Error(
    `Existing fields have incompatible types: ${incompatible
      .map((field) => `${field.field_name} (expected ${field.ui_type})`)
      .join(", ")}`,
  );
}

const created = [];
for (const field of desired) {
  if (existing.has(field.field_name)) continue;
  const response = await client.bitable.appTableField.create({ path, data: field });
  if (response.code !== 0) {
    throw new Error(
      `Unable to create field ${field.field_name}: ${response.code ?? "unknown"} ${response.msg ?? ""}`,
    );
  }
  created.push(field.field_name);
}

process.stdout.write(
  `${JSON.stringify({ ok: true, created, existing: desired.map((field) => field.field_name).filter((name) => !created.includes(name)) })}\n`,
);
