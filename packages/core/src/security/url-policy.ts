import { isIP } from "node:net";

export interface UrlPolicyOptions {
  allowPrivate: boolean;
  allowedHosts?: string[];
  ownAddress?: string;
}

function isPrivateIp(address: string): boolean {
  if (address === "::1" || address === "127.0.0.1" || address === "0.0.0.0")
    return true;
  if (address === "169.254.169.254") return true;
  if (address.includes(":")) {
    const normalized = address.toLowerCase();
    return normalized.startsWith("fc") || normalized.startsWith("fd");
  }
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part)))
    return false;
  const second = parts[1] ?? -1;
  return (
    parts[0] === 10 ||
    (parts[0] === 172 && second >= 16 && second <= 31) ||
    (parts[0] === 192 && second === 168) ||
    parts[0] === 127 ||
    (parts[0] === 169 && second === 254) ||
    (parts[0] === 100 && second >= 64 && second <= 127)
  );
}

export function validateUpstreamUrl(
  input: string,
  options: UrlPolicyOptions,
  allowInsecureHttp = false,
): URL {
  if (input.length > 2048) throw new Error("Upstream URL is too long");
  const url = new URL(input);
  if (url.username || url.password)
    throw new Error("Upstream URLs must not contain credentials");
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && allowInsecureHttp)
  ) {
    throw new Error(
      "Upstream URL must use HTTPS unless insecure HTTP is explicitly allowed",
    );
  }
  if (url.port && (Number(url.port) < 1 || Number(url.port) > 65535)) {
    throw new Error("Invalid upstream port");
  }
  if (
    options.allowedHosts?.length &&
    !options.allowedHosts.includes(url.hostname.toLowerCase())
  ) {
    throw new Error("Upstream host is not allowlisted");
  }
  if (options.ownAddress && url.hostname === options.ownAddress) {
    throw new Error("Upstream URL points to this server");
  }
  const hostIp = isIP(url.hostname);
  if (hostIp) {
    const parts = url.hostname.split(".").map(Number);
    if (parts[0] === 169 && parts[1] === 254) {
      throw new Error("Link-local and cloud metadata addresses are blocked");
    }
    if (isPrivateIp(url.hostname) && !options.allowPrivate) {
      throw new Error("Private and loopback upstream addresses are blocked");
    }
  }
  if (url.hostname === "localhost" && !options.allowPrivate) {
    throw new Error("Localhost upstream is blocked");
  }
  return url;
}
