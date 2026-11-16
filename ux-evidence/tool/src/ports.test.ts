import { describe, expect, it } from "vitest";
import { findFreePortOffset, portsForOffset } from "./ports.ts";

describe("portsForOffset", () => {
  it("derives all six ports at offset 5000", () => {
    expect(portsForOffset(5000)).toEqual([10432, 15020, 14229, 8000, 8010, 8001]);
  });
});

describe("findFreePortOffset", () => {
  it("skips an offset with any busy port", async () => {
    await expect(findFreePortOffset({ candidateOffsets: [5000, 5100],
      isPortAvailable: async (p) => p !== 8000 })).resolves.toBe(5100);
  });
  it("fails when no offset is free", async () => {
    await expect(findFreePortOffset({ candidateOffsets: [5000], isPortAvailable: async () => false }))
      .rejects.toThrow("no free port offset among 5000");
  });
});
