import { describe, expect, it } from "vitest";
import { pickBrowser } from "../src/adapters/browser/index.js";
import { ValidationError } from "../src/core/errors.js";

describe("pickBrowser", () => {
  it("uses the cloud provider when a key is set", async () => {
    const p = await pickBrowser({ SOLARI_API_KEY: "sk-test" } as NodeJS.ProcessEnv);
    expect(p.name).toBe("solari");
  });

  it("uses a local Chromium when asked, with no key at all", async () => {
    const p = await pickBrowser({ DEMOREEL_BROWSER: "local" } as NodeJS.ProcessEnv);
    expect(p.name).toBe("local");
  });

  it("prefers the explicit local choice over an available key", async () => {
    const p = await pickBrowser({ DEMOREEL_BROWSER: "local", SOLARI_API_KEY: "sk-test" } as NodeJS.ProcessEnv);
    expect(p.name).toBe("local");
  });

  it("names the local escape hatch when there is no key", async () => {
    await expect(pickBrowser({} as NodeJS.ProcessEnv)).rejects.toThrow(ValidationError);
    await expect(pickBrowser({} as NodeJS.ProcessEnv)).rejects.toThrow(/DEMOREEL_BROWSER=local/);
  });
});
