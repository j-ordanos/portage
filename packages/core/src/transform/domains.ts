export interface SourceDomain {
  host: string;
  https: boolean;
  port?: number;
  path?: string;
  source: string;
}

export function parseDomain(source: string): SourceDomain {
  const hasScheme = /^[a-z]+:\/\//i.test(source);
  const parsed = new URL(hasScheme ? source : `https://${source}`);
  const port = parsed.port ? Number(parsed.port) : undefined;
  return {
    host: parsed.hostname.toLowerCase().replace(/\.$/, ""),
    https: parsed.protocol === "https:",
    ...(port === undefined ? {} : { port }),
    ...(parsed.pathname === "/" ? {} : { path: parsed.pathname }),
    source,
  };
}

export function validDomainHost(host: string): boolean {
  if (!host || host.length > 253 || host.includes("*") || /\s/.test(host))
    return false;
  if (host.includes("..") || host.startsWith(".") || host.endsWith("."))
    return false;
  return host
    .split(".")
    .every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
}

export function mapDomains(
  domains: SourceDomain[],
  policy: "keep-original" | "temp-suffix" | "custom",
  tempBase?: string,
  customMap: Record<string, string> = {},
): SourceDomain[] {
  return domains.map((domain) => {
    const target =
      customMap[domain.source] ??
      customMap[domain.host] ??
      (policy === "keep-original"
        ? domain.host
        : policy === "temp-suffix" && tempBase
          ? `${domain.host.split(".")[0]}.${tempBase.replace(/^\./, "")}`
          : domain.host);
    return { ...domain, host: target, source: domain.source };
  });
}
