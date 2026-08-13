import { describe, expect, it } from "vitest";
import { splitMessage } from "../../src/delivery/reply-renderer.js";

describe("splitMessage", () => {
  it("splits long replies without losing content", () => {
    const input = "a".repeat(23);
    const chunks = splitMessage(input, 10);
    expect(chunks).toEqual(["a".repeat(10), "a".repeat(10), "aaa"]);
    expect(chunks.join("")).toBe(input);
  });

  it("redacts secrets before splitting", () => {
    const chunks = splitMessage("Authorization: Bearer secret-token-value", 100);
    expect(chunks.join("")).toBe("[REDACTED]");
  });
});
