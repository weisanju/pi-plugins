import { describe, expect, it } from "bun:test";
import { __internals } from "../../src/index.ts";

const { classifyFailure, classifyFailureDetail } = __internals;

const ACCOUNT_DENIED = '400 event: error data: {"error":{"message":"{"message":"Access to Anthropic models is not allowed for this account."}"}}';
const UNSUPPORTED_CAPABILITY = '400 "thinking.type.enabled" is not supported for this model.';

describe("classifyFailure", () => {
  it("treats account-level model access denial as target-level (non-fatal)", () => {
    expect(classifyFailure(ACCOUNT_DENIED)).not.toBe("fatal");
    expect(classifyFailure(ACCOUNT_DENIED)).toBe("config");
  });

  it("treats unsupported model capability as target-level (non-fatal)", () => {
    expect(classifyFailure(UNSUPPORTED_CAPABILITY)).not.toBe("fatal");
    expect(classifyFailure(UNSUPPORTED_CAPABILITY)).toBe("config");
  });

  it("matches markers case-insensitively", () => {
    expect(classifyFailure("Access to Anthropic models is NOT ALLOWED FOR THIS ACCOUNT.")).toBe("config");
    expect(classifyFailure('"thinking.type.enabled" IS NOT SUPPORTED FOR THIS MODEL.')).toBe("config");
  });

  it("reports the matched marker for troubleshooting", () => {
    expect(classifyFailureDetail(ACCOUNT_DENIED)).toEqual({ class: "config", marker: "not allowed for this account" });
    expect(classifyFailureDetail(UNSUPPORTED_CAPABILITY)).toEqual({ class: "config", marker: "not supported for this model" });
  });

  it("keeps fatal for unrecognized request-level errors", () => {
    expect(classifyFailure("something totally unexpected")).toBe("fatal");
    expect(classifyFailureDetail("something totally unexpected")).toEqual({ class: "fatal" });
  });

  it("keeps existing classes intact", () => {
    expect(classifyFailure("429 too many requests")).toBe("transient");
    expect(classifyFailure("402 payment required")).toBe("quota");
    expect(classifyFailure("model not found")).toBe("config");
    expect(classifyFailure("401 unauthorized")).toBe("config");
  });
});
