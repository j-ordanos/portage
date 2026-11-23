import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Info,
  Lightbulb,
} from "lucide-react";
import type { ReactNode } from "react";
import { AUTHOR, VERSION } from "./brand";

const Callout = ({
  tone,
  children,
}: {
  tone: "tip" | "warn" | "info";
  children: ReactNode;
}) => {
  const Icon =
    tone === "tip" ? Lightbulb : tone === "warn" ? AlertTriangle : Info;
  return (
    <div className={`callout ${tone}`} role="note">
      <Icon size={18} aria-hidden="true" />
      <p>{children}</p>
    </div>
  );
};

interface Doc {
  slug: string;
  title: string;
  group: "Start here" | "Connect your servers" | "Migrating" | "Reference";
  body: ReactNode;
}

export const DOCS: Doc[] = [
  {
    slug: "start",
    title: "Overview",
    group: "Start here",
    body: (
      <>
        <h1>Portage documentation</h1>
        <p className="lead">
          Portage recreates your Coolify projects in Dokploy. You review
          everything first, nothing is deployed, and every step can be undone.
        </p>
        <h2>The five steps</h2>
        <ol>
          <li>
            <strong>Connect.</strong> Pick a saved Coolify and a saved Dokploy.
            Portage reads Coolify and nothing else.
          </li>
          <li>
            <strong>Choose.</strong> Browse your projects and decide what moves.
            Private repositories are matched to Git access in Dokploy.
          </li>
          <li>
            <strong>Review.</strong> See the exact list of what will be created,
            with the Coolify name next to the Dokploy name.
          </li>
          <li>
            <strong>Migrate.</strong> Portage creates the resources, one step at
            a time, with live progress. You can pause, retry or skip.
          </li>
          <li>
            <strong>Finish.</strong> Portage reads everything back to check it,
            and hands you a to-do list for what only a person can do.
          </li>
        </ol>
        <Callout tone="tip">
          First time? Add your two servers in <a href="#/settings">Settings</a>,
          then start a <a href="#/new">new migration</a>. It takes about two
          minutes for a small setup.
        </Callout>
        <h2>What it will not do</h2>
        <ul>
          <li>
            It never deploys anything. You press deploy in Dokploy when you are
            ready.
          </li>
          <li>It never changes Coolify.</li>
          <li>
            It does not copy data: database contents and volume files stay where
            they are. The report gives you the dump and restore commands.
          </li>
        </ul>
      </>
    ),
  },
  {
    slug: "how-it-works",
    title: "How it works",
    group: "Start here",
    body: (
      <>
        <h1>How it works</h1>
        <p className="lead">
          Portage speaks to both platforms through their official APIs. It does
          not read either platform's database or files.
        </p>
        <h2>Read, plan, write, verify</h2>
        <ol>
          <li>
            <strong>Read.</strong> It lists your Coolify teams, projects,
            environments, apps, databases and services, then reads each one's
            settings, variables and storage.
          </li>
          <li>
            <strong>Plan.</strong> It works out the Dokploy equivalent of each
            resource, without calling Dokploy to write. This is what you see on
            the review screen.
          </li>
          <li>
            <strong>Write.</strong> Only when you confirm, it creates projects,
            apps, databases and compose stacks in Dokploy, then configures
            source, build, variables, volumes and domains.
          </li>
          <li>
            <strong>Verify.</strong> It reads every created resource back and
            compares it with the plan, using key names, hosts and counts, never
            values.
          </li>
        </ol>
        <h2>Safe to repeat</h2>
        <p>
          Every created resource carries a marker saying where it came from. If
          a request is lost halfway, Portage finds what it already made instead
          of creating a duplicate. You can stop a migration and resume it, even
          after the server restarts.
        </p>
      </>
    ),
  },
  {
    slug: "coolify-token",
    title: "Create a Coolify token",
    group: "Connect your servers",
    body: (
      <>
        <h1>Create a Coolify API token</h1>
        <p className="lead">
          Portage only needs to read. Create a token just for this migration and
          delete it afterwards.
        </p>
        <ol>
          <li>
            In Coolify, open <strong>Keys &amp; Tokens</strong>, then{" "}
            <strong>API tokens</strong>.
          </li>
          <li>
            Create a token with the <code>read</code> permission.
          </li>
          <li>
            Also tick <code>read:sensitive</code> if you want environment
            variable values and database passwords copied. Without it, Portage
            still creates the variable names and lists the missing values for
            you to fill in.
          </li>
          <li>Copy the token. Coolify shows it once.</li>
        </ol>
        <Callout tone="warn">
          A token that can read sensitive values can read every secret on that
          Coolify. Use a temporary one and revoke it when you finish.
        </Callout>
        <h3>The address</h3>
        <p>
          Use the address you open Coolify at, for example{" "}
          <code>https://coolify.example.com</code>. Portage adds the API path
          itself. Coolify 4.1 or newer is required.
        </p>
      </>
    ),
  },
  {
    slug: "dokploy-key",
    title: "Create a Dokploy API key",
    group: "Connect your servers",
    body: (
      <>
        <h1>Create a Dokploy API key</h1>
        <p className="lead">
          Portage uses this key to create new projects and resources. It deletes
          only what it created, and only when you ask it to roll back.
        </p>
        <ol>
          <li>
            In Dokploy, open <strong>Settings</strong>, then{" "}
            <strong>Profile</strong>, then the <strong>API / CLI</strong>{" "}
            section.
          </li>
          <li>Create an API key and copy it.</li>
        </ol>
        <Callout tone="info">
          Dokploy keys are not limited to read or write, so the key can do
          everything your account can. Create one for this migration and delete
          it afterwards.
        </Callout>
        <h3>Private Git repositories</h3>
        <p>
          If your Coolify apps use private repositories, add a GitHub App or an
          SSH key in Dokploy first. Portage then links each app to one that
          works. See <a href="#/docs/git-access">Git access</a>.
        </p>
      </>
    ),
  },
  {
    slug: "what-moves",
    title: "What moves",
    group: "Migrating",
    body: (
      <>
        <h1>What moves, and what does not</h1>
        <p className="lead">
          Structure and settings move. Data and history do not.
        </p>
        <table>
          <thead>
            <tr>
              <th>In Coolify</th>
              <th>In Dokploy</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Project and environments</td>
              <td>
                Project and environments. The default <code>production</code>{" "}
                environment is reused, not duplicated.
              </td>
            </tr>
            <tr>
              <td>App from Git (Nixpacks, Railpack, Dockerfile, static)</td>
              <td>
                Application with the same repository, branch, base directory and
                build type.
              </td>
            </tr>
            <tr>
              <td>App from a Docker image</td>
              <td>Application using the same image and tag.</td>
            </tr>
            <tr>
              <td>Docker Compose app</td>
              <td>
                Compose from Git with the same file path, and the domains
                attached to the right services.
              </td>
            </tr>
            <tr>
              <td>One-click service</td>
              <td>
                Compose with the service's own file. Coolify magic variables are
                flagged.
              </td>
            </tr>
            <tr>
              <td>Postgres, MySQL, MariaDB, MongoDB, Redis</td>
              <td>
                Same engine and image. Credentials are copied when readable,
                otherwise new ones are generated and listed.
              </td>
            </tr>
            <tr>
              <td>Environment variables</td>
              <td>
                Environment variables with correct quoting. References such as{" "}
                <code>{"{{environment.X}}"}</code> become Dokploy's{" "}
                <code>{"${{environment.X}}"}</code>.
              </td>
            </tr>
            <tr>
              <td>Domains</td>
              <td>
                Domains with HTTPS. The automatic <code>sslip.io</code>{" "}
                addresses are skipped.
              </td>
            </tr>
            <tr>
              <td>Persistent storage</td>
              <td>Volumes and file mounts, created empty.</td>
            </tr>
          </tbody>
        </table>
        <h2>Not moved</h2>
        <ul>
          <li>
            Data inside databases and volumes. The report includes dump and
            restore commands.
          </li>
          <li>Deployment logs and history.</li>
          <li>
            Scheduled tasks, webhooks, notifications, backup schedules and
            preview deployments.
          </li>
          <li>
            Resource limits and health checks are listed on the report to set by
            hand.
          </li>
          <li>
            Coolify team-level shared variables, which Dokploy has no equivalent
            for.
          </li>
        </ul>
      </>
    ),
  },
  {
    slug: "git-access",
    title: "Git access",
    group: "Migrating",
    body: (
      <>
        <h1>Git access for private repositories</h1>
        <p className="lead">
          Coolify and Dokploy name their GitHub Apps differently, so Portage
          ignores names and checks what actually works.
        </p>
        <h2>How a private repository is linked</h2>
        <ol>
          <li>
            <strong>A Dokploy GitHub App that can see the repository.</strong>{" "}
            Portage asks Dokploy which repositories each of its GitHub Apps can
            access, and uses the first one that includes <code>owner/repo</code>
            .
          </li>
          <li>
            <strong>The same SSH key.</strong> For deploy-key repositories,
            Portage compares the SHA-256 fingerprint of the Coolify key with
            each Dokploy SSH key. A match means it is provably the same key.
          </li>
          <li>
            <strong>An SSH key with the same name.</strong> A weaker match, used
            when nothing better is found.
          </li>
          <li>
            <strong>Otherwise it is created unlinked,</strong> with a clear note
            to link it in Dokploy.
          </li>
        </ol>
        <p>
          Every repository shows what was chosen and why, with a menu to pick a
          different GitHub App, an SSH key, or to leave it unlinked. Your choice
          always wins.
        </p>
        <Callout tone="tip">
          If Dokploy has no GitHub App or SSH key yet, add one under Dokploy
          settings first, then press <strong>Check again</strong> on the choose
          screen.
        </Callout>
        <p>
          Portage never copies private keys or Git credentials between the two
          platforms.
        </p>
      </>
    ),
  },
  {
    slug: "names",
    title: "Name conflicts",
    group: "Migrating",
    body: (
      <>
        <h1>When a name already exists</h1>
        <p className="lead">
          If Dokploy already has a project with the same name (ignoring
          capitals), Portage does not overwrite or merge. By default it creates
          the new one with a <code>*</code> added.
        </p>
        <p>
          So <code>name-saver</code> becomes <code>name-saver*</code>, and a
          second time <code>name-saver**</code>. The new name appears before you
          confirm, on the choose and review screens.
        </p>
        <h3>Other choices</h3>
        <ul>
          <li>
            <strong>Marker.</strong> Use a different marker, such as{" "}
            <code>-migrated</code>.
          </li>
          <li>
            <strong>Add to the existing project.</strong> New resources go into
            the project that is already there. A resource whose name collides
            gets the marker.
          </li>
          <li>
            <strong>Skip it.</strong> Leave that project out.
          </li>
        </ul>
      </>
    ),
  },
  {
    slug: "rollback",
    title: "Rollback",
    group: "Migrating",
    body: (
      <>
        <h1>Undoing a migration</h1>
        <p className="lead">
          Rollback deletes what Portage created in Dokploy, and nothing else.
        </p>
        <ul>
          <li>
            It lists every item first, in the order it will delete them:
            domains, mounts, apps, databases, then environments and projects.
          </li>
          <li>You must type the exact confirmation phrase.</li>
          <li>
            Anything that already existed in Dokploy, such as a project you
            chose to add to, is never deleted.
          </li>
          <li>
            Running it twice is harmless. Things already gone are skipped.
          </li>
        </ul>
        <Callout tone="warn">
          Rollback cannot restore data you added to the new resources after the
          migration, for example rows in a restored database.
        </Callout>
      </>
    ),
  },
  {
    slug: "after",
    title: "After the migration",
    group: "Migrating",
    body: (
      <>
        <h1>After the migration</h1>
        <p className="lead">
          Everything is created but nothing runs yet. Here is the safe order to
          switch over.
        </p>
        <ol>
          <li>
            <strong>Back up</strong> every database and volume on Coolify,
            somewhere off the server.
          </li>
          <li>
            <strong>Relink Git access</strong> for any repository Portage could
            not link.
          </li>
          <li>
            <strong>Restore data</strong> using the commands in your report.
          </li>
          <li>
            <strong>Deploy</strong> in Dokploy, preferably on a temporary
            domain, and test.
          </li>
          <li>
            <strong>Lower the DNS TTL</strong> a day before, freeze writes, sync
            data once more, then point DNS at Dokploy.
          </li>
          <li>
            <strong>Keep Coolify running</strong> for a few days before deleting
            anything.
          </li>
          <li>
            <strong>Revoke</strong> the temporary Coolify token and the Dokploy
            key.
          </li>
        </ol>
        <p>
          The report on the final screen contains the same checklist, filled in
          with your resources.
        </p>
      </>
    ),
  },
  {
    slug: "security",
    title: "Security and privacy",
    group: "Reference",
    body: (
      <>
        <h1>Security and privacy</h1>
        <p className="lead">
          Portage holds keys to your infrastructure, so it is built to keep as
          little as possible, for as short a time as possible.
        </p>
        <h2>What is stored</h2>
        <table>
          <thead>
            <tr>
              <th>Data</th>
              <th>How it is kept</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Your password</td>
              <td>
                Hashed with argon2id. Never stored or logged in plain text.
              </td>
            </tr>
            <tr>
              <td>Saved server tokens and keys</td>
              <td>
                Encrypted with AES-256-GCM. The API never returns them: you can
                replace one, not read it back.
              </td>
            </tr>
            <tr>
              <td>Variable values and passwords read from Coolify</td>
              <td>
                Encrypted while a migration is in progress, and erased when it
                finishes.
              </td>
            </tr>
            <tr>
              <td>Migration records</td>
              <td>Names, ids and step results. Never secrets.</td>
            </tr>
          </tbody>
        </table>
        <h2>Guarantees</h2>
        <ul>
          <li>Coolify is only ever read.</li>
          <li>
            Nothing is deployed, and only what Portage created can be rolled
            back.
          </li>
          <li>Each account sees only its own servers and migrations.</li>
          <li>
            Secrets are scrubbed from logs, progress events, errors and exports.
          </li>
          <li>
            Addresses pointing at cloud metadata services are always refused.
          </li>
        </ul>
        <h2>The honest limits</h2>
        <ul>
          <li>
            Whoever administers the server Portage runs on can access it while
            it runs. Run it on infrastructure you control.
          </li>
          <li>
            The encryption key lives next to the data by default. For stronger
            protection, set <code>MASTER_KEY</code> so a copied data folder is
            useless on its own.
          </li>
          <li>
            Use HTTPS, and ideally a private network or VPN, for any shared
            instance.
          </li>
        </ul>
      </>
    ),
  },
  {
    slug: "self-hosting",
    title: "Run your own",
    group: "Reference",
    body: (
      <>
        <h1>Run your own Portage</h1>
        <p className="lead">
          Portage is one small Node service with a SQLite file. You can deploy
          it from its repository with Dokploy.
        </p>
        <h2>Deploy it on Dokploy</h2>
        <ol>
          <li>
            Create an <strong>Application</strong> and point it at the Portage
            repository.
          </li>
          <li>
            Set the build type to <strong>Dockerfile</strong>.
          </li>
          <li>
            Add a <strong>volume mount</strong> for <code>/data</code>. This is
            where accounts, saved connections and migrations live.
          </li>
          <li>
            Add a domain with HTTPS, container port <code>3000</code>, and
            deploy.
          </li>
        </ol>
        <p>
          Open the site and create your account. The first account is always
          allowed.
        </p>
        <h2>Settings</h2>
        <table>
          <thead>
            <tr>
              <th>Variable</th>
              <th>Default</th>
              <th>What it does</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <code>PORT</code>
              </td>
              <td>3000</td>
              <td>Port to listen on.</td>
            </tr>
            <tr>
              <td>
                <code>DATA_DIR</code>
              </td>
              <td>./data</td>
              <td>
                Where the database and generated key are kept. Use{" "}
                <code>/data</code> in a container.
              </td>
            </tr>
            <tr>
              <td>
                <code>MASTER_KEY</code>
              </td>
              <td>generated</td>
              <td>
                Optional. A base64 32-byte key (
                <code>openssl rand -base64 32</code>) that seals saved tokens.
                Without it, one is generated into <code>DATA_DIR</code>.
              </td>
            </tr>
            <tr>
              <td>
                <code>ALLOW_SIGNUP</code>
              </td>
              <td>true</td>
              <td>
                Set to <code>false</code> to stop others creating accounts once
                yours exists.
              </td>
            </tr>
            <tr>
              <td>
                <code>UPSTREAM_ALLOW_PRIVATE</code>
              </td>
              <td>true</td>
              <td>
                Allow Coolify or Dokploy at private addresses. Set to{" "}
                <code>false</code> on a public instance.
              </td>
            </tr>
            <tr>
              <td>
                <code>PUBLIC_URL</code>
              </td>
              <td>none</td>
              <td>Your public https address. Turns on secure cookies.</td>
            </tr>
          </tbody>
        </table>
        <Callout tone="warn">
          Back up the data folder together with the key. Without the key, saved
          tokens cannot be decrypted and must be added again.
        </Callout>
      </>
    ),
  },
  {
    slug: "vercel",
    title: "Put the website on Vercel",
    group: "Reference",
    body: (
      <>
        <h1>Put the website on Vercel</h1>
        <p className="lead">
          Vercel can host Portage's website. The server that does the work has
          to run somewhere that keeps its files and can run for a while, such as
          your Dokploy.
        </p>
        <h2>Why not everything on Vercel?</h2>
        <p>
          Portage is more than a website. It stores accounts and saved servers
          in a database file, and it applies a migration in the background for
          minutes at a time while streaming progress. Vercel's functions have no
          permanent disk and stop after a short time, so the server cannot live
          there. The website itself is just static files, which Vercel hosts
          very well.
        </p>
        <pre>{`Browser ──▶ Vercel (website)  ──/api──▶  Your Dokploy (Portage server + /data volume)`}</pre>
        <Callout tone="tip">
          The simplest setup is to deploy the whole thing on Dokploy, as in{" "}
          <a href="#/docs/self-hosting">Run your own</a>. One deploy, one
          address. Use Vercel only if you want the website there.
        </Callout>
        <Callout tone="warn">
          With this setup, requests to <code>/api</code> pass through Vercel on
          their way to your server. That includes the tokens you type when
          saving a connection. Vercel forwards them without keeping them, but if
          you do not want a third party in that path, serve everything from your
          own server instead.
        </Callout>
        <h2>Steps</h2>
        <h3>1. Run the server first</h3>
        <p>
          Deploy Portage on Dokploy as described in{" "}
          <a href="#/docs/self-hosting">Run your own</a>, with its own HTTPS
          address such as <code>https://portage-api.example.com</code>. Then add
          these settings to it:
        </p>
        <table>
          <thead>
            <tr>
              <th>Variable</th>
              <th>Value</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <code>PUBLIC_URL</code>
              </td>
              <td>
                The address people will open, which is your{" "}
                <strong>Vercel</strong> address, for example{" "}
                <code>https://portage.vercel.app</code>. The server uses it to
                accept requests that arrive through Vercel and to set secure
                cookies.
              </td>
            </tr>
            <tr>
              <td>
                <code>UPSTREAM_ALLOW_PRIVATE</code>
              </td>
              <td>
                <code>false</code> if others will use it and your Coolify and
                Dokploy are public. Leave <code>true</code> for servers on a
                private network.
              </td>
            </tr>
            <tr>
              <td>
                <code>ALLOW_SIGNUP</code>
              </td>
              <td>
                <code>false</code> once your account exists, if it is only for
                you.
              </td>
            </tr>
          </tbody>
        </table>
        <h3>2. Point the website at the server</h3>
        <p>
          In the repository, open <code>vercel.json</code> and replace{" "}
          <code>YOUR-PORTAGE-SERVER.example.com</code> (two places) with your
          server's address, without <code>https://</code> in front of the host
          in the text you replace. Commit and push.
        </p>
        <h3>3. Import the repository in Vercel</h3>
        <ol>
          <li>
            In Vercel choose <strong>Add New… Project</strong> and import the
            repository.
          </li>
          <li>
            Leave the root directory as it is and the framework as{" "}
            <strong>Other</strong>. The build settings come from{" "}
            <code>vercel.json</code>.
          </li>
          <li>Deploy.</li>
        </ol>
        <h3>4. Check it</h3>
        <p>
          Open your Vercel address. The landing page loads, and creating an
          account should work. If the page loads but sign-up fails, check that{" "}
          <code>PUBLIC_URL</code> on the server is exactly the Vercel address,
          including <code>https://</code> and with no trailing path.
        </p>
        <h3>Using your own domain</h3>
        <p>
          Add the domain in Vercel, then change <code>PUBLIC_URL</code> on the
          server to the same address and redeploy the server.
        </p>
        <h2>Things to know</h2>
        <ul>
          <li>
            The live progress view uses a long-lived connection. If Vercel
            closes it, the page reconnects and also refreshes by itself every
            few seconds, so progress keeps moving. The migration itself runs on
            your server and continues either way.
          </li>
          <li>
            Sessions and saved servers live on your server. Back up its{" "}
            <code>/data</code> volume and key as before.
          </li>
          <li>
            Every change to the website needs a push, and every server update
            needs a redeploy on Dokploy. They are deployed separately.
          </li>
        </ul>
      </>
    ),
  },
  {
    slug: "troubleshooting",
    title: "Troubleshooting",
    group: "Reference",
    body: (
      <>
        <h1>Troubleshooting</h1>
        <h3>“Can’t connect” or a timeout</h3>
        <p>
          Portage connects from the server it runs on, not from your browser.
          That server must be able to reach the address. Include{" "}
          <code>https://</code> and the port if it is not standard. For a
          private address, make sure <code>UPSTREAM_ALLOW_PRIVATE</code> is not
          set to <code>false</code>.
        </p>
        <h3>“Upstream authentication failed”</h3>
        <p>
          The token or key is wrong, expired or revoked. Create a new one and
          replace it in Settings.
        </p>
        <h3>“Upstream permission denied”</h3>
        <p>
          The Coolify token lacks the read permission, or belongs to a user who
          cannot see those projects.
        </p>
        <h3>“Returned HTML instead of JSON”</h3>
        <p>
          The address points at a login page or proxy, not the API. Use the
          address you open Coolify or Dokploy at.
        </p>
        <h3>Variable values are empty</h3>
        <p>
          The Coolify token does not have the sensitive permission. Portage
          created the names and listed them on your report.
        </p>
        <h3>A private repository was left unlinked</h3>
        <p>
          No Dokploy GitHub App can access it and no SSH key matches. Add one in
          Dokploy, then check again, or pick one from the menu.
        </p>
        <h3>A project name ends with *</h3>
        <p>
          Dokploy already had a project with that name. See{" "}
          <a href="#/docs/names">Name conflicts</a>.
        </p>
        <h3>A verification check failed</h3>
        <p>
          Something in Dokploy differs from the plan, for example a resource was
          edited or deleted after the migration. The failing check names the
          resource and what is missing.
        </p>
      </>
    ),
  },
  {
    slug: "faq",
    title: "FAQ",
    group: "Reference",
    body: (
      <>
        <h1>Frequently asked questions</h1>
        <h3>Does it copy my database contents?</h3>
        <p>
          No. It creates empty databases with the same engine and image. Your
          report includes dump and restore commands.
        </p>
        <h3>Will it deploy my apps?</h3>
        <p>Never. You review in Dokploy and deploy when you are ready.</p>
        <h3>Can I run it more than once?</h3>
        <p>
          Yes. A name that already exists gets the marker, so nothing is
          overwritten.
        </p>
        <h3>Will it change or delete anything in Coolify?</h3>
        <p>No. Coolify is only read.</p>
        <h3>Which versions work?</h3>
        <p>
          Tested on Coolify 4.7 and Dokploy 0.31. Other 4.x and 0.3x versions
          usually work, with a warning when something differs.
        </p>
        <h3>Can a team share one instance?</h3>
        <p>
          Yes. Each person creates an account and sees only their own servers
          and migrations.
        </p>
        <h3>I forgot my password.</h3>
        <p>
          Portage sends no emails, so there is no reset link. The person who
          runs the server can delete the account row, or you can sign up again
          with another email.
        </p>
        <p className="muted small">
          Portage v{VERSION}, made by{" "}
          <a href={AUTHOR.github} target="_blank" rel="noreferrer">
            {AUTHOR.name}
          </a>
          .
        </p>
      </>
    ),
  },
];

const GROUPS: Doc["group"][] = [
  "Start here",
  "Connect your servers",
  "Migrating",
  "Reference",
];

export function Docs({ slug }: { slug: string }) {
  const index = Math.max(
    0,
    DOCS.findIndex((d) => d.slug === slug),
  );
  const doc = DOCS[index] as Doc;
  const prev = DOCS[index - 1];
  const next = DOCS[index + 1];
  return (
    <div className="docs">
      <nav className="docs-nav" aria-label="Documentation">
        {GROUPS.map((g) => (
          <div key={g} style={{ display: "contents" }}>
            <h2>{g}</h2>
            {DOCS.filter((d) => d.group === g).map((d) => (
              <a
                key={d.slug}
                href={d.slug === "start" ? "#/docs" : `#/docs/${d.slug}`}
                aria-current={d.slug === doc.slug ? "page" : undefined}
              >
                {d.title}
              </a>
            ))}
          </div>
        ))}
      </nav>
      <article className="prose">
        {doc.body}
        <div className="docs-pager">
          {prev ? (
            <a href={prev.slug === "start" ? "#/docs" : `#/docs/${prev.slug}`}>
              <small>
                <ArrowLeft size={12} aria-hidden="true" /> Previous
              </small>
              {prev.title}
            </a>
          ) : (
            <span />
          )}
          {next ? (
            <a className="next" href={`#/docs/${next.slug}`}>
              <small>
                Next <ArrowRight size={12} aria-hidden="true" />
              </small>
              {next.title}
            </a>
          ) : null}
        </div>
      </article>
    </div>
  );
}
