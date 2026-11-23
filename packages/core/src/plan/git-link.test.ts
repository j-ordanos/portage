import { describe, expect, it } from "vitest";
import {
  candidatesFor,
  type GitSnapshot,
  repoSlug,
  resolveGitLink,
  sshFingerprint,
} from "./git-link.js";

// Reference values produced by `ssh-keygen -lf` for a real ed25519 key.
const PUBLIC_KEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAh/P3om9kNDHtwXC482JGF3ZE/8oaMLw46fMGk6RfIQ test@lab";
const FINGERPRINT = "YSqbHglVIZM+P5SKq51rr/u5J9YesKuw0UWK8NDVV8s";

const snapshot = (over: Partial<GitSnapshot> = {}): GitSnapshot => ({
  github: [
    {
      githubId: "gh-a",
      label: "Dokploy-V2.1",
      repos: new Set(["j-ordanos/dev-showcase"]),
    },
    { githubId: "gh-b", label: "Other app", repos: new Set(["someone/else"]) },
  ],
  ssh: [
    { sshKeyId: "k1", name: "deploy-main", fingerprint: FINGERPRINT },
    { sshKeyId: "k2", name: "github-dev-showcase" },
  ],
  ...over,
});

describe("repoSlug", () => {
  it("normalises every way Coolify and Dokploy spell a repository", () => {
    for (const input of [
      "J-Ordanos/Dev-Showcase",
      "https://github.com/j-ordanos/dev-showcase",
      "https://github.com/j-ordanos/dev-showcase.git",
      "git@github.com:j-ordanos/dev-showcase.git",
      "ssh://git@github.com/j-ordanos/dev-showcase.git",
    ]) {
      expect(repoSlug(input), input).toBe("j-ordanos/dev-showcase");
    }
    expect(repoSlug("not a repo")).toBeUndefined();
  });
});

describe("sshFingerprint", () => {
  it("matches ssh-keygen output (the form Coolify displays)", () => {
    expect(sshFingerprint(PUBLIC_KEY)).toBe(FINGERPRINT);
    expect(sshFingerprint("garbage")).toBeUndefined();
    expect(sshFingerprint("")).toBeUndefined();
  });
});

describe("resolveGitLink", () => {
  const privateApp = {
    provider: "github-app",
    repo: "j-ordanos/dev-showcase",
    url: "https://github.com/j-ordanos/dev-showcase",
  };

  it("links a GitHub App repo through the Dokploy provider that can access it, whatever the app is called", () => {
    const link = resolveGitLink(
      { ...privateApp, keyName: undefined },
      snapshot(),
    );
    expect(link).toMatchObject({ kind: "github", githubId: "gh-a" });
  });

  it("prefers the same SSH key (fingerprint) for a deploy-key repo, even when a GitHub App also has access", () => {
    const link = resolveGitLink(
      {
        provider: "deploy-key",
        repo: "git@github.com:j-ordanos/dev-showcase.git",
        keyName: "anything",
        keyFingerprint: FINGERPRINT,
      },
      snapshot(),
    );
    expect(link).toMatchObject({ kind: "ssh", sshKeyId: "k1" });
    expect(link.reason).toContain("same key");
  });

  it("falls back to a GitHub App with access, then to a key with the same name", () => {
    const deployKey = {
      provider: "deploy-key",
      repo: "git@github.com:j-ordanos/dev-showcase.git",
      keyName: "github-dev-showcase",
      keyFingerprint: "unknown",
    };
    expect(resolveGitLink(deployKey, snapshot())).toMatchObject({
      kind: "github",
      githubId: "gh-a",
    });
    expect(resolveGitLink(deployKey, snapshot({ github: [] }))).toMatchObject({
      kind: "ssh",
      sshKeyId: "k2",
    });
  });

  it("does not use a provider that cannot see the repository", () => {
    const link = resolveGitLink(
      {
        ...privateApp,
        repo: "j-ordanos/other",
        url: "https://github.com/j-ordanos/other",
      },
      snapshot(),
    );
    expect(link.kind).toBe("url");
    expect(link.reason).toContain("No Dokploy GitHub App can access");
  });

  it("explains when Dokploy has nothing to link to at all", () => {
    expect(
      resolveGitLink(privateApp, snapshot({ github: [], ssh: [] })).reason,
    ).toContain("no Git provider or SSH key yet");
  });

  it("needs no link for public repositories", () => {
    expect(
      resolveGitLink({ provider: "public", repo: "a/b" }, snapshot()),
    ).toMatchObject({ kind: "url" });
  });

  it("a user override always wins, and an unknown override id is ignored", () => {
    expect(
      resolveGitLink(privateApp, snapshot(), { sshKeyId: "k2" }),
    ).toMatchObject({ kind: "ssh", sshKeyId: "k2", reason: "Chosen by you" });
    expect(
      resolveGitLink(privateApp, snapshot(), { githubId: "gh-b" }),
    ).toMatchObject({ kind: "github", githubId: "gh-b" });
    expect(resolveGitLink(privateApp, snapshot(), { url: true }).kind).toBe(
      "url",
    );
    expect(
      resolveGitLink(privateApp, snapshot(), { githubId: "gone" }),
    ).toMatchObject({ kind: "github", githubId: "gh-a" });
  });

  it("treats a provider whose repos could not be listed as unknown, not as access", () => {
    const snap = snapshot({
      github: [{ githubId: "gh-x", label: "Broken", repos: null }],
    });
    expect(candidatesFor(privateApp, snap).github[0]?.hasAccess).toBeNull();
    expect(resolveGitLink(privateApp, snap).kind).toBe("url");
  });
});
