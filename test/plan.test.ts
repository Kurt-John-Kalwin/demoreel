import { describe, expect, it } from "vitest";
import { FixtureLlm } from "../src/adapters/llm/fixture.js";
import { extractJsonObject } from "../src/adapters/llm/index.js";
import { PlannerError } from "../src/core/errors.js";
import { buildPlannerPrompt, planStoryboard, translateNarration } from "../src/stages/plan.js";
import { sampleSite } from "./helpers.js";

const input = { url: "https://topsets.app/", sentence: "Lift tracker", scan: { ...sampleSite.scan, url: "https://topsets.app/" } };

describe("planner", () => {
  it("keeps only real selectors and same-site links, warning about the rest", async () => {
    const llm = new FixtureLlm([
      {
        title: "Top Sets",
        sentence: "A lifting tracker",
        scenes: [
          { say: "Welcome to Top Sets, the tracker.", do: [{ hover: "#living-list" }] },
          { say: "Now the builder and coaches pages.", do: [{ click: "a:has-text(\"Builder\")" }, { hover: "#does-not-exist" }, { goto: "https://topsets.app/coaches" }, { goto: "https://evil.example/" }, { goto: "/" }] },
          { say: "Type into the email field only.", do: [{ type: { selector: "input[name=\"email\"]", text: "a@b.c" } }, { type: { selector: "#living-list", text: "x" } }] },
        ],
      },
    ]);
    const { storyboard, warnings } = await planStoryboard(llm, input);
    expect(storyboard.scenes[0]!.do).toEqual([{ goto: "https://topsets.app/" }, { hover: "#living-list" }]);
    expect(storyboard.scenes[1]!.do).toEqual([{ click: "a:has-text(\"Builder\")" }, { goto: "https://topsets.app/coaches" }, { goto: "https://topsets.app/" }]);
    expect(storyboard.scenes[2]!.do).toEqual([{ type: { selector: "input[name=\"email\"]", text: "a@b.c" } }]);
    expect(warnings).toEqual(
      expect.arrayContaining([expect.stringContaining("#does-not-exist"), expect.stringContaining("evil.example"), expect.stringContaining("dropped type into")]),
    );
    expect(storyboard.sentence).toBe("Lift tracker");
    expect(storyboard.title).toBe("Top Sets");
    expect(llm.calls[0]!.user).toContain("CANDIDATES");
  });

  it("puts the same-site links and candidates in the prompt and leaves foreign links out", () => {
    const prompt = buildPlannerPrompt(input);
    expect(prompt).toContain('"Builder" -> https://topsets.app/#builder');
    expect(prompt).not.toContain("x.com/topsets");
    expect(prompt).toContain("#living-list");
    expect(prompt).toContain("WHAT THE OWNER SAYS IT IS: Lift tracker");
  });

  it("rejects a plan that fails the schema", async () => {
    const llm = new FixtureLlm([{ title: "x", sentence: "y", scenes: [{ say: "one", do: [] }] }]);
    await expect(planStoryboard(llm, input)).rejects.toThrow();
  });

  it("translates narration line for line", async () => {
    const llm = new FixtureLlm([{ lines: ["Hola", "Adiós"] }, { lines: ["solo una"] }]);
    await expect(translateNarration(llm, ["Hello", "Bye"], "es")).resolves.toEqual(["Hola", "Adiós"]);
    await expect(translateNarration(llm, ["Hello", "Bye"], "es")).rejects.toThrow(PlannerError);
  });
});

describe("json extraction", () => {
  it("finds the object inside prose and fences", () => {
    expect(extractJsonObject('Sure! ```json\n{"a": {"b": "}"}}\n``` done')).toBe('{"a": {"b": "}"}}');
    expect(extractJsonObject('text {"x":1} more')).toBe('{"x":1}');
    expect(extractJsonObject("nothing here")).toBeNull();
  });
});
