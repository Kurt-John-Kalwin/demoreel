export type PageKind = "ok" | "login" | "checkout" | "account" | "error";

export interface PageSignals {
  url: string;
  title: string;
  passwordFields: number;
  textSample: string;
  httpStatus?: number;
}

const loginRe = /(?:^|\s)(log ?in|sign ?in|signin|login|authenticate|two-factor|2fa|one-time code|verify your identity)(?:\s|$|[|:·,.])/i;
const checkoutRe = /\b(checkout|payment|billing|cart|order summary|credit card)\b/i;
const accountRe = /\b(my account|account settings|dashboard|admin)\b/i;

/** Heuristic classification used by the public door. Site owners rendering their own storyboard bypass it. */
export function classifyPage(signals: PageSignals): { kind: PageKind; reason: string } {
  if (signals.httpStatus !== undefined && signals.httpStatus >= 400) {
    return { kind: "error", reason: `page returned HTTP ${signals.httpStatus}` };
  }
  const path = safePath(signals.url);
  const head = `${signals.title} ${path}`;
  if (signals.passwordFields > 0) return { kind: "login", reason: "the page has a password field" };
  if (loginRe.test(head)) return { kind: "login", reason: "the page looks like a sign-in page" };
  if (checkoutRe.test(head)) return { kind: "checkout", reason: "the page looks like a checkout or payment page" };
  if (accountRe.test(head)) return { kind: "account", reason: "the page looks like a private account area" };
  if (/\b(sign in to continue|enter your password)\b/i.test(signals.textSample)) {
    return { kind: "login", reason: "the page asks for a password" };
  }
  return { kind: "ok", reason: "public page" };
}

function safePath(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname).replace(/[-_/]+/g, " ");
  } catch {
    return "";
  }
}
