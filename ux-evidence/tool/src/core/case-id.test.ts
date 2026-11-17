import { describe, expect, it } from "vitest";
import { assertValidCaseId } from "./case-id.ts";

describe("assertValidCaseId", () => {
  it.each(["a", "weekly-play-counts", "case-2"])("accepts %j", (id) => {
    expect(() => assertValidCaseId(id)).not.toThrow();
  });

  it.each(["", "../client", "a/b", "Upper", "a_b", "a b", "..", ".", "-/..", "a\n"])("rejects %j", (id) => {
    expect(() => assertValidCaseId(id)).toThrow("case id must be lowercase letters, digits and hyphens");
  });
});
