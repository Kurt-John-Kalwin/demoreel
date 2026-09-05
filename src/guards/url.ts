import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { GuardError, ValidationError } from "../core/errors.js";

/** Accepts what people paste ("topsets.app", "https://x.y/z") and returns a clean http(s) URL, or throws. */
export function normalizeTargetUrl(input: string): URL {
  const trimmed = input.trim();
  if (!trimmed) throw new ValidationError("Enter a URL.");
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new ValidationError(`"${input}" is not a valid URL.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ValidationError("Only http and https URLs can be demoed.");
  }
  if (url.username || url.password) throw new GuardError("URLs with embedded credentials are refused.", "credentials-in-url");
  url.hash = "";
  const host = url.hostname.toLowerCase();
  if (!host.includes(".") || host.endsWith(".local") || host.endsWith(".internal") || host === "localhost") {
    throw new GuardError("Only public websites can be demoed.", "private-host");
  }
  return url;
}

function ipv4ToInt(ip: string): number {
  return ip.split(".").reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

const v4Blocks: Array<[string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 3],
];

function isPrivateV4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  return v4Blocks.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (n & mask) === (ipv4ToInt(base) & mask);
  });
}

function expandV6(ip: string): string[] {
  const [head = "", tail = ""] = ip.split("::");
  const headParts = head ? head.split(":") : [];
  const tailParts = tail ? tail.split(":") : [];
  const fill = 8 - headParts.length - tailParts.length;
  const parts = [...headParts, ...Array(Math.max(fill, 0)).fill("0"), ...tailParts];
  return parts.map((p) => p.padStart(4, "0").toLowerCase());
}

function isPrivateV6(ip: string): boolean {
  const lower = ip.toLowerCase();
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateV4(mapped[1]!);
  const parts = expandV6(lower);
  const joined = parts.join(":");
  if (joined === "0000:0000:0000:0000:0000:0000:0000:0001") return true; // ::1
  if (joined === "0000:0000:0000:0000:0000:0000:0000:0000") return true; // ::
  const first = parseInt(parts[0]!, 16);
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link local
  if ((first & 0xff00) === 0xff00) return true; // multicast
  return false;
}

/** True for loopback, link-local, RFC1918, CGNAT, documentation, multicast and v4-mapped equivalents. */
export function isPrivateIp(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return isPrivateV4(ip);
  if (kind === 6) return isPrivateV6(ip);
  return true; // not an IP at all: treat as unsafe
}

export type Resolver = (host: string) => Promise<string[]>;

export const dnsResolver: Resolver = async (host) => {
  const records = await lookup(host, { all: true, verbatim: true });
  return records.map((r) => r.address);
};

/** Every address the host resolves to must be public. A host with no records is refused too. */
export async function assertPublicHost(hostname: string, resolve: Resolver = dnsResolver): Promise<void> {
  if (isIP(hostname)) {
    if (isPrivateIp(hostname)) throw new GuardError("Only public websites can be demoed.", "private-host");
    return;
  }
  let addresses: string[];
  try {
    addresses = await resolve(hostname);
  } catch {
    throw new GuardError(`"${hostname}" does not resolve.`, "dns");
  }
  if (addresses.length === 0) throw new GuardError(`"${hostname}" does not resolve.`, "dns");
  if (addresses.some(isPrivateIp)) throw new GuardError("Only public websites can be demoed.", "private-host");
}
