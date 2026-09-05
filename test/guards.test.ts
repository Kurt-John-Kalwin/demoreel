import { describe, expect, it } from "vitest";
import { GuardError, ValidationError } from "../src/core/errors.js";
import { classifyPage } from "../src/guards/page.js";
import { isAllowed, parseRobots, robotsAllows } from "../src/guards/robots.js";
import { assertPublicHost, isPrivateIp, normalizeTargetUrl } from "../src/guards/url.js";

describe("private ip detection", () => {
  it.each(["10.0.0.1", "127.0.0.1", "169.254.1.1", "172.16.5.5", "172.31.255.255", "192.168.1.1", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "::", "fc00::1", "fd12::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:10.1.2.3"])(
    "%s is private",
    (ip) => expect(isPrivateIp(ip)).toBe(true),
  );
  it.each(["8.8.8.8", "93.184.216.34", "172.32.0.1", "2606:4700::1111", "::ffff:8.8.8.8"])("%s is public", (ip) => expect(isPrivateIp(ip)).toBe(false));
  it("treats garbage as unsafe", () => expect(isPrivateIp("not-an-ip")).toBe(true));
});

describe("url normalization", () => {
  it("adds https and strips fragments", () => {
    expect(normalizeTargetUrl(" topsets.app/#builder ").href).toBe("https://topsets.app/");
    expect(normalizeTargetUrl("http://example.com/a?b=1").href).toBe("http://example.com/a?b=1");
  });
  it("refuses non-http schemes, credentials and local names", () => {
    expect(() => normalizeTargetUrl("ftp://x.y")).toThrow(ValidationError);
    expect(() => normalizeTargetUrl("https://user:pw@x.y")).toThrow(GuardError);
    expect(() => normalizeTargetUrl("localhost:3000")).toThrow(GuardError);
    expect(() => normalizeTargetUrl("http://intranet")).toThrow(GuardError);
    expect(() => normalizeTargetUrl("http://printer.local")).toThrow(GuardError);
    expect(() => normalizeTargetUrl("")).toThrow(ValidationError);
  });
});

describe("public host check", () => {
  it("refuses hosts resolving to private space or nothing", async () => {
    await expect(assertPublicHost("evil.example", async () => ["93.184.216.34", "10.0.0.5"])).rejects.toThrow(GuardError);
    await expect(assertPublicHost("gone.example", async () => [])).rejects.toThrow(/does not resolve/);
    await expect(assertPublicHost("boom.example", async () => { throw new Error("dns"); })).rejects.toThrow(/does not resolve/);
    await expect(assertPublicHost("127.0.0.1")).rejects.toThrow(GuardError);
  });
  it("accepts public hosts and literal public IPs", async () => {
    await expect(assertPublicHost("ok.example", async () => ["93.184.216.34"])).resolves.toBeUndefined();
    await expect(assertPublicHost("8.8.8.8")).resolves.toBeUndefined();
  });
});

describe("robots.txt", () => {
  const rules = parseRobots(`
# comment
User-agent: *
Disallow: /private
Allow: /private/ok
Disallow: /tmp/*.pdf$
Disallow:

User-agent: demoreel
Disallow: /nope
`);
  it("uses the agent group when present and longest match otherwise", () => {
    expect(isAllowed(rules, "/nope/x")).toBe(false);
    expect(isAllowed(rules, "/private")).toBe(true);
    expect(isAllowed(rules, "/private/x", "googlebot")).toBe(false);
    expect(isAllowed(rules, "/private/ok/x", "googlebot")).toBe(true);
    expect(isAllowed(rules, "/tmp/a.pdf", "*")).toBe(false);
    expect(isAllowed(rules, "/tmp/a.pdfx", "*")).toBe(true);
  });
  it("allows everything when there are no rules", () => {
    expect(isAllowed(parseRobots(""), "/anything")).toBe(true);
  });
  it("treats unreachable or missing files as allowed", async () => {
    const url = new URL("https://x.example/page");
    expect((await robotsAllows(url, async () => ({ status: 404, text: "" }))).allowed).toBe(true);
    expect((await robotsAllows(url, async () => { throw new Error("net"); })).allowed).toBe(true);
    const res = await robotsAllows(url, async () => ({ status: 200, text: "User-agent: *\nDisallow: /page" }));
    expect(res.allowed).toBe(false);
    expect(res.reason).toMatch(/disallows/);
  });
});

describe("page classification", () => {
  const base = { url: "https://x.example/", title: "Acme", passwordFields: 0, textSample: "welcome" };
  it("flags password fields, sign-in titles, checkout paths and error statuses", () => {
    expect(classifyPage({ ...base, passwordFields: 1 }).kind).toBe("login");
    expect(classifyPage({ ...base, title: "Sign in to Acme" }).kind).toBe("login");
    expect(classifyPage({ ...base, url: "https://x.example/checkout/step-2" }).kind).toBe("checkout");
    expect(classifyPage({ ...base, url: "https://x.example/account/settings" }).kind).toBe("account");
    expect(classifyPage({ ...base, httpStatus: 404 }).kind).toBe("error");
    expect(classifyPage({ ...base, textSample: "Enter your password to continue" }).kind).toBe("login");
  });
  it("passes ordinary pages", () => {
    expect(classifyPage(base).kind).toBe("ok");
    expect(classifyPage({ ...base, title: "Login-free analytics for logistics" }).kind).toBe("ok");
  });
});
