# Connect a project

Each project owns its deployment setup: a checked-in `scripts/ship.ts` client and a commit-safe `shibumi-server.json` file.

## Add Ship to the project

From the local Git root:

```sh
curl -fsSL https://shibumistack.dev/install/ship.sh | sh
```

The installer refuses to run outside a Git root. It never overwrites local edits to `scripts/ship.ts`. Setup can install or upgrade `shibumi-server`, register the app, and configure GitHub through SSH. You do not need to run `shis add` first.

If the repository has no tracked Compose file, setup can generate `Dockerfile`, `compose.yaml`, and `.dockerignore` from standard Bun scripts. Review, commit, and push those files. Then run `bun ship:setup` again. Existing files stay untouched.

## Run first setup

```sh
bun ship:setup
```

Use the `user@server` target or SSH alias you already use. Password login works. Enter the password once per run, and Ship reuses the temporary SSH connection.

SSH targets stay in `~/.config/shibumi/config.json`, or `$XDG_CONFIG_HOME/shibumi/config.json`, with mode `0600`. They are not committed. Projects with one saved server reuse it; projects with several saved servers show a picker. Setup runs `~/.local/bin/shibumi-server` remotely and writes only sanitized project config.

Choose **Run bun ship** or **Deploy every GitHub push**.

- **Run bun ship** builds locally, uploads the image, and asks the server to deploy over SSH. If GitHub CLI is signed in, setup disables the matching webhook. GitHub access never blocks shipping.
- **Deploy every GitHub push** switches the server to build mode and creates, repairs, enables, and tests the webhook. Its secret stays in memory and on the server.

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

Before each deploy, Ship checks the mutable latest pointer against its reviewed immutable source. When a newer client exists, it offers to run that version now. After a successful deployment, it updates tracked `scripts/ship.ts` and leaves the change unstaged for review. `bun ship -y` accepts that update automatically.

Network failures keep the current client. Unknown local edits are never overwritten. Server setup, webhook, SSH target, and `shibumi-server.json` stay unchanged.

Manual update:

```sh
bun ship:update
```
