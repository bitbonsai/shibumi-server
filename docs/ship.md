# Connect a project

Ship adds two tracked files to the project: `scripts/ship.ts` runs deployments, and `shibumi-server.json` stores public app settings.

## Add Ship to the project

From the local Git root:

```sh
curl -fsSL https://shibumistack.dev/install/ship.sh | sh
```

The installer refuses to run outside a Git root. It never overwrites local edits to `scripts/ship.ts`. Setup can install or upgrade `shibumi-server`, register the app, and configure GitHub through SSH. You do not need to run `shis add` first.

The installer reserves `bun dev` for Ship's local deployment preview. If the project already has a `dev` script, it keeps that command as `bun dev:app`.

If the repository has no tracked Compose file, setup can generate `Dockerfile`, `compose.yaml`, and `.dockerignore` from standard Bun scripts. Review, commit, and push those files. Then run `bun ship:setup` again. Existing files stay untouched.

If setup stops after writing the client files, fix the reported problem and resume with `bun ship:setup`. You do not need to rerun the curl installer.

## Run first setup

```sh
bun ship:setup
```

Use the `user@server` target or SSH alias you already use. Password login works. Enter the password once per run, and Ship reuses the temporary SSH connection. To select the target without a text prompt:

```sh
bun ship:setup --server user@server
```

SSH targets stay in `~/.config/shibumi/config.json`, or `$XDG_CONFIG_HOME/shibumi/config.json`, with mode `0600`. They are not committed. Projects with one saved server reuse it; projects with several saved servers show a picker. Setup runs `~/.local/bin/shibumi-server` remotely, then writes public settings to `shibumi-server.json`.

Choose **Run bun ship** or **Deploy every GitHub push**.

- **Run bun ship** builds locally, uploads the image, and starts deployment over SSH. If GitHub CLI is signed in, setup disables the matching webhook. Direct shipping still works when `gh` is not signed in.
- **Deploy every GitHub push** switches the server to build mode, then creates or repairs the webhook and tests delivery. Its secret stays in memory and on the server.

The committed `shibumi-server.json` has the deployment trigger, app ID, repository, branch, webhook URL, service, app port, health path, and server hostname. It has no secrets, checkout paths, SSH users, aliases, or credentials.

## Ship

Local prebuilt shipping needs Colima, Docker CLI, Docker Compose, and Buildx. On macOS:

```sh
brew install colima docker docker-compose docker-buildx
colima start
docker info
docker compose version
docker buildx version
```

Then ship from the project root:

```sh
bun ship
```

Ship checks the build tools, Git state, and project checks before asking for confirmation. If Docker config names an unavailable credential helper, it offers to remove that stale reference after writing a mode-`0600` backup. Non-interactive runs print manual recovery steps instead.

Ship creates its build context from committed `HEAD` with `git archive`. Local files, ignored files, credentials, and machine-built `node_modules` stay out. It builds for the server's Linux platform, labels the image with repository, app, commit, Git tree, and platform, then uploads it over SSH. Git push happens only after upload succeeds.

In direct mode, Ship asks the server to deploy the exact commit and follows its status. In GitHub mode, it waits for the webhook after a new push. If `HEAD` is already pushed, either mode can redeploy it directly.

Docker keeps layer cache. Use `bun ship --rebuild` for a no-cache build. Git submodules fail closed because `git archive` cannot prove their nested content.

Agents can run `bun ship -y` when the routine confirmation is safe to accept. Clean-tree checks, project checks, image verification, and failures still run. Missing SSH, GitHub, domain, registration, or cutover prerequisites stop and tell the agent to ask you.

## Change setup later

```sh
bun ship:setup
```

This updates project config or changes the deployment trigger. Automation can choose directly:

```sh
bun ship:setup --trigger ship
bun ship:setup --trigger github-push
```

Change the SSH target with `git config --local shibumi.server user@server`.

## Update the client

Before each deploy, Ship compares the latest client with the fixed version named in `scripts/ship.ts`. When a newer client exists, it offers to use it for that run. After a successful deployment, Ship writes the reviewed client to `scripts/ship.ts` and leaves the change unstaged. `bun ship -y` accepts the update automatically.

Network failures keep the current client. Unknown local edits are never overwritten. Server setup, webhook, SSH target, and `shibumi-server.json` stay unchanged.

If the installer reports that `scripts/ship.ts` contains owned changes, review and merge the immutable client URL printed in the error. The refusal is intentional: Ship will not replace a modified deployment client. Rerun setup after the reviewed client is committed.

Manual update:

```sh
bun ship:update
```
