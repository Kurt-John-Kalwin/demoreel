import { describe, expect, it } from "vitest";
import { extraHeadersFromEnv } from "../src/adapters/browser/solari.js";

describe("extraHeadersFromEnv", () => {
  it("is undefined when unset or empty", () => {
    expect(extraHeadersFromEnv({})).toBeUndefined();
    expect(extraHeadersFromEnv({ DEMOREEL_EXTRA_HEADERS: "   " })).toBeUndefined();
  });

  it("parses a JSON object of string headers", () => {
    expect(extraHeadersFromEnv({ DEMOREEL_EXTRA_HEADERS: '{"ngrok-skip-browser-warning":"1"}' })).toEqual({
      "ngrok-skip-browser-warning": "1",
    });
  });

  it("ignores malformed JSON rather than failing the render", () => {
    expect(extraHeadersFromEnv({ DEMOREEL_EXTRA_HEADERS: "{not json" })).toBeUndefined();
    expect(extraHeadersFromEnv({ DEMOREEL_EXTRA_HEADERS: '["a","b"]' })).toBeUndefined();
    expect(extraHeadersFromEnv({ DEMOREEL_EXTRA_HEADERS: '"a string"' })).toBeUndefined();
  });

  it("drops non-string values and blank names, and is undefined when nothing survives", () => {
    expect(extraHeadersFromEnv({ DEMOREEL_EXTRA_HEADERS: '{"a":1,"  ":"x","b":"y"}' })).toEqual({ b: "y" });
    expect(extraHeadersFromEnv({ DEMOREEL_EXTRA_HEADERS: '{"a":1}' })).toBeUndefined();
  });
});
