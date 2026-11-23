import { createHash } from "node:crypto";

/** Read-only picture of what Dokploy can link to. Built from gitProvider.getAll, github.getGithubRepositories and sshKey.all. */
export interface GitSnapshot {
  github: Array<{
    githubId: string;
    /** Human label, e.g. the GitHub App name. */
    label: string;
    /** `owner/repo` (lowercase) this provider can access; null when it could not be listed. */
    repos: Set<string> | null;
  }>;
  ssh: Array<{ sshKeyId: string; name: string; fingerprint?: string }>;
}

export type GitLink =
  | { kind: "github"; githubId: string; label: string; reason: string }
  | { kind: "ssh"; sshKeyId: string; label: string; reason: string }
  | { kind: "url"; reason: string };

export interface GitSourceInfo {
  provider: string;
  repo: string;
  url?: string | undefined;
  keyName?: string | undefined;
  keyFingerprint?: string | undefined;
}

export interface GitCandidates {
  github: Array<{ githubId: string; label: string; hasAccess: boolean | null }>;
  ssh: Array<{
    sshKeyId: string;
    label: string;
    match: "fingerprint" | "name" | null;
  }>;
}

export interface GitOverride {
  githubId?: string | undefined;
  sshKeyId?: string | undefined;
  /** Link by plain URL and relink by hand later. */
  url?: boolean | undefined;
}

/** `owner/repo` (lowercase) for github.com style references: `owner/repo`, https URLs and scp-style ssh URLs. */
export function repoSlug(repo: string): string | undefined {
  const trimmed = repo.trim().replace(/\.git$/i, "");
  const scp = /^[\w.-]+@[\w.-]+:([\w.-]+\/[\w.-]+)$/.exec(trimmed);
  if (scp) return scp[1]?.toLowerCase();
  const url =
    /^(?:https?|ssh|git):\/\/(?:[^/@]+@)?[^/]+\/([\w.-]+\/[\w.-]+)$/i.exec(
      trimmed,
    );
  if (url) return url[1]?.toLowerCase();
  const plain = /^([\w.-]+\/[\w.-]+)$/.exec(trimmed);
  return plain ? plain[1]?.toLowerCase() : undefined;
}

/**
 * SHA-256 fingerprint of an OpenSSH public key, in the form Coolify shows it
 * (base64 without padding and without the `SHA256:` prefix).
 */
export function sshFingerprint(publicKey: string): string | undefined {
  const blob = publicKey.trim().split(/\s+/)[1];
  if (!blob) return undefined;
  try {
    const raw = Buffer.from(blob, "base64");
    if (raw.length === 0) return undefined;
    return createHash("sha256").update(raw).digest("base64").replace(/=+$/, "");
  } catch {
    return undefined;
  }
}

const norm = (value: string) => value.trim().toLowerCase();

export function candidatesFor(
  source: GitSourceInfo,
  snapshot: GitSnapshot,
): GitCandidates {
  const slug = repoSlug(source.url ?? source.repo) ?? repoSlug(source.repo);
  return {
    github: snapshot.github.map((g) => ({
      githubId: g.githubId,
      label: g.label,
      hasAccess: g.repos === null || !slug ? null : g.repos.has(slug),
    })),
    ssh: snapshot.ssh.map((k) => ({
      sshKeyId: k.sshKeyId,
      label: k.name,
      match:
        source.keyFingerprint &&
        k.fingerprint &&
        source.keyFingerprint === k.fingerprint
          ? ("fingerprint" as const)
          : source.keyName && norm(source.keyName) === norm(k.name)
            ? ("name" as const)
            : null,
    })),
  };
}

/**
 * Decide how Dokploy should reach a private repository. Names of the two tools' GitHub Apps are irrelevant;
 * what counts is whether the Dokploy provider can actually see `owner/repo`.
 *   github-app source : provider with access  >  fingerprint-matched key  >  name-matched key
 *   deploy-key source : fingerprint-matched key  >  provider with access  >  name-matched key
 * Public repositories need no link. An explicit user override always wins.
 */
export function resolveGitLink(
  source: GitSourceInfo,
  snapshot: GitSnapshot,
  override?: GitOverride,
): GitLink {
  if (override?.url)
    return {
      kind: "url",
      reason:
        "Linked by URL as chosen; relink Git access in Dokploy if the repository is private",
    };
  if (override?.githubId) {
    const g = snapshot.github.find((p) => p.githubId === override.githubId);
    if (g)
      return {
        kind: "github",
        githubId: g.githubId,
        label: g.label,
        reason: "Chosen by you",
      };
  }
  if (override?.sshKeyId) {
    const k = snapshot.ssh.find((p) => p.sshKeyId === override.sshKeyId);
    if (k)
      return {
        kind: "ssh",
        sshKeyId: k.sshKeyId,
        label: k.name,
        reason: "Chosen by you",
      };
  }
  if (source.provider === "public")
    return { kind: "url", reason: "Public repository: no credentials needed" };

  const c = candidatesFor(source, snapshot);
  const viaGithub = c.github.filter((g) => g.hasAccess === true);
  const github = (): GitLink | undefined => {
    const hit = viaGithub[0];
    return hit
      ? {
          kind: "github",
          githubId: hit.githubId,
          label: hit.label,
          reason: `Dokploy GitHub App “${hit.label}” can access this repository`,
        }
      : undefined;
  };
  const key = (match: "fingerprint" | "name"): GitLink | undefined => {
    const hit = c.ssh.find((k) => k.match === match);
    return hit
      ? {
          kind: "ssh",
          sshKeyId: hit.sshKeyId,
          label: hit.label,
          reason:
            match === "fingerprint"
              ? `Dokploy SSH key “${hit.label}” is the same key as the Coolify deploy key`
              : `Dokploy SSH key “${hit.label}” has the same name as the Coolify deploy key`,
        }
      : undefined;
  };
  const order =
    source.provider === "deploy-key"
      ? [key("fingerprint"), github(), key("name")]
      : [github(), key("fingerprint"), key("name")];
  const found = order.find((link) => link !== undefined);
  if (found) return found;
  return {
    kind: "url",
    reason:
      snapshot.github.length === 0 && snapshot.ssh.length === 0
        ? "Dokploy has no Git provider or SSH key yet: add one, then relink this app"
        : "No Dokploy GitHub App can access this repository and no SSH key matches: pick one or relink by hand",
  };
}
