/** Minimal robots.txt: user-agent groups, Allow/Disallow with longest-match precedence, `*` and `$` wildcards. */
export interface RobotsRules {
  groups: Array<{ agents: string[]; rules: Array<{ allow: boolean; path: string }> }>;
}

export const ROBOTS_AGENT = "demoreel";

export function parseRobots(text: string): RobotsRules {
  const groups: RobotsRules["groups"] = [];
  let current: RobotsRules["groups"][number] | null = null;
  let lastWasAgent = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (key === "allow" || key === "disallow") {
      if (key === "disallow" && value === "") continue; // "Disallow:" empty means allow all
      current.rules.push({ allow: key === "allow", path: value });
    }
  }
  return { groups };
}

function patternToRegex(pattern: string): RegExp {
  let re = "^";
  for (const ch of pattern) {
    if (ch === "*") re += ".*";
    else if (ch === "$") re += "$";
    else re += ch.replace(/[.+?^{}()|[\]\\/]/g, "\\$&");
  }
  return new RegExp(re);
}

/** Longest matching rule wins; on a tie, Allow wins (Google's documented behaviour). */
export function isAllowed(rules: RobotsRules, path: string, agent = ROBOTS_AGENT): boolean {
  const group =
    rules.groups.find((g) => g.agents.some((a) => a === agent.toLowerCase())) ??
    rules.groups.find((g) => g.agents.includes("*"));
  if (!group) return true;
  let best: { allow: boolean; length: number } | null = null;
  for (const rule of group.rules) {
    if (!patternToRegex(rule.path).test(path)) continue;
    const length = rule.path.length;
    if (!best || length > best.length || (length === best.length && rule.allow && !best.allow)) {
      best = { allow: rule.allow, length };
    }
  }
  return best ? best.allow : true;
}

export type Fetcher = (url: string) => Promise<{ status: number; text: string }>;

export const httpFetcher: Fetcher = async (url) => {
  const res = await fetch(url, {
    headers: { "user-agent": `${ROBOTS_AGENT}/0.1 (+https://github.com/Kurt-John-Kalwin/demoreel)` },
    signal: AbortSignal.timeout(8000),
    redirect: "follow",
  });
  return { status: res.status, text: res.ok ? await res.text() : "" };
};

/** Unreachable or missing robots.txt allows crawling, as the standard says; a 5xx is treated as allowed too. */
export async function robotsAllows(target: URL, fetcher: Fetcher = httpFetcher): Promise<{ allowed: boolean; reason?: string }> {
  let body: { status: number; text: string };
  try {
    body = await fetcher(`${target.origin}/robots.txt`);
  } catch {
    return { allowed: true, reason: "robots.txt unreachable" };
  }
  if (body.status >= 400 || !body.text) return { allowed: true };
  const rules = parseRobots(body.text);
  const path = target.pathname + target.search;
  return isAllowed(rules, path) ? { allowed: true } : { allowed: false, reason: `robots.txt disallows ${path}` };
}
