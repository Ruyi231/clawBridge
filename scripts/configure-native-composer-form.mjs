import * as lark from "@larksuiteoapi/node-sdk";

const args = process.argv.slice(2);
const valueAfter = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};
const dedicated = args.includes("--dedicated");
const positional = args.filter(
  (value, index) =>
    !value.startsWith("--") &&
    (index === 0 || !["--app-token", "--table-id"].includes(args[index - 1])),
);
const appToken = valueAfter("--app-token") ?? positional[0];
const requestedTableId = valueAfter("--table-id") ?? positional[1];
let tableId = requestedTableId;
const appId = process.env.CLAWBRIDGE_FEISHU_APP_ID?.trim();
const appSecret = process.env.CLAWBRIDGE_FEISHU_APP_SECRET?.trim();
if (!appToken || (!dedicated && !tableId) || !appId || !appSecret) {
  throw new Error(
    "Usage: configure-native-composer-form.mjs --app-token <appToken> (--dedicated | --table-id <tableId>); ClawBridge Feishu credentials are also required",
  );
}

const silentLogger = { debug() {}, info() {}, warn() {}, error() {}, trace() {} };
const client = new lark.Client({ appId, appSecret, logger: silentLogger });

async function call(label, operation) {
  try {
    const response = await operation();
    if (response.code !== 0) {
      throw new Error(`${response.code ?? "unknown"} ${response.msg ?? ""}`);
    }
    return response;
  } catch (error) {
    const detail = error?.response?.data;
    throw new Error(
      `${label}: ${detail?.code ?? "request_failed"} ${detail?.msg ?? error?.message ?? ""}`,
    );
  }
}

if (dedicated) {
  const tableName = "ClawBridge 组合发送数据";
  const tables = await call("Unable to list Bitable tables", () =>
    client.bitable.appTable.list({ path: { app_token: appToken }, params: { page_size: 100 } }),
  );
  let table = (tables.data?.items ?? []).find((item) => item.name === tableName);
  if (!table?.table_id) {
    const created = await call("Unable to create dedicated composer table", () =>
      client.bitable.appTable.create({
        path: { app_token: appToken },
        data: {
          table: {
            name: tableName,
            default_view_name: "提交记录",
            fields: [
              { field_name: "消息内容", type: 1, ui_type: "Text" },
              { field_name: "附件", type: 17, ui_type: "Attachment" },
              { field_name: "ClawBridge会话", type: 1, ui_type: "Text" },
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
            ],
          },
        },
      }),
    );
    table = { table_id: created.data?.table_id, name: tableName };
  }
  if (!table.table_id) throw new Error("The dedicated composer table is missing its table ID");
  tableId = table.table_id;
}

const path = { app_token: appToken, table_id: tableId };

const views = await call("Unable to list Bitable views", () =>
  client.bitable.appTableView.list({ path, params: { page_size: 100 } }),
);
let formView = (views.data?.items ?? []).find(
  (view) => view.view_type === "form" && view.view_name === "ClawBridge 组合发送",
);
if (!formView?.view_id) {
  const created = await call("Unable to create native composer form", () =>
    client.bitable.appTableView.create({
      path,
      data: { view_name: "ClawBridge 组合发送", view_type: "form" },
    }),
  );
  formView = created.data?.view;
}
const formId = formView?.view_id;
if (!formId) throw new Error("The native composer form is missing its view ID");

const fields = await call("Unable to list Bitable fields", () =>
  client.bitable.appTableField.list({ path, params: { page_size: 100 } }),
);
const questions = await call("Unable to list native form questions", () =>
  client.bitable.appTableFormField.list({
    path: { ...path, form_id: formId },
    params: { page_size: 100 },
  }),
);
const fieldsById = new Map(
  (fields.data?.items ?? [])
    .filter((field) => field.field_id)
    .map((field) => [field.field_id, field]),
);
const visible = new Set(["消息内容", "附件"]);
for (const question of questions.data?.items ?? []) {
  if (!question.field_id) continue;
  const field = fieldsById.get(question.field_id);
  if (!field) continue;
  await call(`Unable to configure form field ${field.field_name}`, () =>
    client.bitable.appTableFormField.patch({
      path: { ...path, form_id: formId, field_id: field.field_id },
      data: visible.has(field.field_name) ? { visible: true, required: false } : { visible: false },
    }),
  );
}

await call("Unable to publish native composer form", () =>
  client.bitable.appTableForm.patch({
    path: { ...path, form_id: formId },
    data: {
      name: "ClawBridge 组合发送",
      description: "输入本轮问题，并可同时上传多张图片和多个文件。提交后返回飞书对话查看处理结果。",
      shared: true,
      shared_limit: "tenant_editable",
      submit_limit_once: false,
    },
  }),
);
const form = await call("Unable to read published composer form", () =>
  client.bitable.appTableForm.get({ path: { ...path, form_id: formId } }),
);
const formUrl = form.data?.form.shared_url;
if (!formUrl) throw new Error("The published native composer form has no shared URL");
process.stdout.write(`${JSON.stringify({ ok: true, tableId, formId, formUrl })}\n`);
