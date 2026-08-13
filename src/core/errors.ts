export type ErrorCode =
  | "CONFIG_INVALID"
  | "UNAUTHORIZED"
  | "GROUP_DISABLED"
  | "DUPLICATE_EVENT"
  | "INVALID_PROJECT"
  | "PROJECT_NOT_FOUND"
  | "PROJECT_CREATE_DISABLED"
  | "PROJECT_IMPORT_DISABLED"
  | "PROJECT_PATH_EXISTS"
  | "PROJECT_PATH_AMBIGUOUS"
  | "PROJECT_ROOT_MISSING"
  | "INVALID_PROJECT_PATH"
  | "PATH_OUTSIDE_PROJECT"
  | "CODEX_START_FAILED"
  | "CODEX_PROTOCOL_ERROR"
  | "CODEX_TIMEOUT"
  | "CODEX_INTERRUPTED"
  | "TASK_CONFLICT"
  | "DELIVERY_FAILED";

export class BridgeError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly retryable = false,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "BridgeError";
  }
}
