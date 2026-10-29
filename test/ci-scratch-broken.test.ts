import { describe, expect, it } from "vitest";

describe("COL-307 scratch", () => {
  it("fails on purpose to show the CI check failing", () => {
    expect(1).toBe(2);
  });
});
