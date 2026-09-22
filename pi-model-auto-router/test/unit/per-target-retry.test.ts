import { describe, expect, it } from "bun:test";
import { __internals } from "../../src/index.ts";

const { perTargetBackoffDelay } = __internals;

describe("perTargetBackoffDelay", () => {
  it("starts at perTargetBackoffMs and doubles each attempt", () => {
    const retry = { perTargetBackoffMs: 1000, backoffMaxMs: 30_000 };
    expect(perTargetBackoffDelay(1, retry)).toBe(1000);
    expect(perTargetBackoffDelay(2, retry)).toBe(2000);
    expect(perTargetBackoffDelay(3, retry)).toBe(4000);
  });

  it("caps at backoffMaxMs", () => {
    const retry = { perTargetBackoffMs: 1000, backoffMaxMs: 2500 };
    expect(perTargetBackoffDelay(1, retry)).toBe(1000);
    expect(perTargetBackoffDelay(2, retry)).toBe(2000);
    expect(perTargetBackoffDelay(3, retry)).toBe(2500);
    expect(perTargetBackoffDelay(10, retry)).toBe(2500);
  });

  it("falls back to a 1.5s base and 30s cap by default", () => {
    expect(perTargetBackoffDelay(1, undefined)).toBe(1500);
    expect(perTargetBackoffDelay(2, undefined)).toBe(3000);
    expect(perTargetBackoffDelay(20, undefined)).toBe(30_000);
  });
});
