import { describe, expect, it } from "vitest";
import { redactSecrets } from "../../src/security/redaction.js";

describe("redactSecrets", () => {
  it("redacts bearer tokens and named secrets", () => {
    const result = redactSecrets("Authorization: Bearer abc.def.ghi\napp_secret=topsecretvalue");
    expect(result).not.toContain("abc.def.ghi");
    expect(result).not.toContain("topsecretvalue");
    expect(result).toContain("[REDACTED]");
  });
});
