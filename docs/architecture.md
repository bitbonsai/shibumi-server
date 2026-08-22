# Architecture

`shibumi-server` receives a signed webhook and replaces an app with the image that `bun ship` uploaded from the same commit.

## Request flow

```text
Ship checks committed work
  → Docker builds the server-platform image from a Git archive
  → Ship uploads the exact commit tag over SSH
  → Git push sends an HTTPS webhook
  → Caddy proxies it to loopback
  → shibumi-server verifies signature, repository, and branch
  → the server fetches the exact commit
  → Podman verifies image labels, Git tree, tag, and platform
  → optional app tests run in a temporary container
  → Podman replaces the app container
  → shibumi-server checks the loopback health endpoint
  → Podman keeps two successful images and prunes dangling data
```

Only Caddy listens publicly. The receiver binds to loopback.

## Trust boundary

A valid webhook lets repository code, or its uploaded image, run as the deployment Unix user. Give that user only the apps it should deploy. Rootless Podman keeps those containers separate from root.

The receiver never runs text from a webhook. Repository, branch, checkout, Compose service, tests, and port come from local config. Webhook values are matched against that config, and commands use argument arrays without a shell.

## Request validation

GitHub requests must:

- fit within the body limit;
- use JSON;
- include a well-formed `X-GitHub-Delivery` UUID and supported event;
- include a valid `X-Hub-Signature-256` over the raw body;
- match the configured repository and `refs/heads/*` branch; and
- contain a full lowercase 40-character commit SHA.

Malformed authentication headers fail before the body is read. A signed GitHub `ping` gets `200`. A valid push gets `202`, and deployment continues asynchronously.

Verified delivery UUIDs stay in a bounded 24-hour memory cache. Repeating a successful or active delivery gets `200` without another deploy. Failed deliveries leave the cache so an operator can redeliver them. The cache clears on service restart; durable replay state is not built yet.

One deploy runs per app. A newer verified push waits in a persistent latest-wins slot. Another newer push replaces it. The queued commit starts when active work finishes, including after failure.

## Deterministic checkout

The deployment checkout belongs to Shibumi. It must be clean before deployment.

```text
git status --porcelain
git fetch --prune origin <configured-ref>
git rev-parse FETCH_HEAD
git reset --hard <verified-commit>
```

The fetched commit must match the signed webhook payload. Runtime data and secrets live outside the checkout.

## Prebuilt images

Ship refuses dirty work, runs project checks, and builds from `git archive` at exact `HEAD`. Ignored files, untracked files, credentials, and local `node_modules` stay out of the build context. Git submodules fail closed.

Docker Compose builds for the server's platform, such as `linux/arm64`. A Compose override adds repository, app ID, commit, and Git-tree labels without changing the app Dockerfile. Ship saves the image under `localhost/shibumi-server/upload/<app-id>:<full-commit>` and streams the archive through SSH to `shis image-load`.

The server accepts stdin only for a registered prebuilt app. It checks archive size against free disk and the configured floor, removes any older copy of that tag, loads it with rootless Podman, then verifies labels, tag, and platform. After fetching the signed commit, it resolves the Git tree and requires it to match the image label. Upload must finish before Git push.

After webhook verification and fetch, Shibumi validates Compose with the image override, runs optional tests, tags the upload as the app runtime image, and starts with `--no-build`. Failed tests never start the image. Failed startup or health restores the previous runtime image. Successful retention removes the temporary upload tag. Server-side builds remain available for manual registrations.

## Resource guards

Before touching the checkout or deploying, the receiver checks Linux `MemAvailable` and free space on the checkout filesystem. Prebuilt apps default to a 512 MiB memory floor. Server builds default to 2 GiB. Both default to a 4 GiB disk floor. Missing or low measurements stop at the `preflight` stage. Keep the checkout and rootless Podman storage on the same filesystem when disk accounting matters.

Server builds have a deadline, 10 minutes by default. The receiver runs the command in its own process group and kills that group on deadline. It never proceeds to tests or startup. A killed build may leave Podman data for deliberate operator cleanup.

The systemd unit adds these default ceilings:

```ini
MemoryHigh=1280M
MemoryMax=1536M
MemorySwapMax=256M
CPUQuota=200%
TasksMax=512
OOMPolicy=stop
```

They protect a small host. Tune them after reserving capacity for the operating system, SSH, Caddy, and running apps. Set app limits in Compose:

```yaml
services:
  web:
    deploy:
      resources:
        limits:
          cpus: "1.0"
          memory: 512M
```

These checks are defense in depth. They do not replace filesystem quotas, monitoring, backups, or testing on another host.

## Image cleanup

After a healthy deploy, the receiver keeps the active image and one app-specific `rollback-<timestamp>-<commit>` tag. The rollback tag expires after 12 hours. Startup restores expiry timers after service restart.

Cleanup removes legacy `release-*`, `staging-*`, prior rollback, current upload, and superseded upload tags, then prunes dangling images. `releaseRetention` accepts one or two total images and defaults to two. Cleanup never uses `--all` or `system prune`. Retention or cleanup failure logs a warning and does not fail a healthy deploy.

## Ports and Caddy

Each app has an explicit Compose frontend and host port. Current installs can use `["podman", "compose"]`; standalone hosts can use `["podman-compose"]`. Old `composeCommand: ["podman"]` registrations normalize before deploy or removal.

Compose binds only loopback:

```yaml
services:
  web:
    ports:
      - "127.0.0.1:${SHIBUMI_PORT}:3000"
```

Caddy maps the public domain to that port. Managed proxies use a 20-second `lb_try_duration`, so requests wait while Compose briefly releases the port during replacement. Existing long-lived connections can still fail, and a restart past that budget returns an upstream error.

Each successful deploy log records replacement time and remaining retry budget. Read it with `shis logs <app-id>`. Logs use mode `0600` and stay below 256 KiB. `shis caddy-refresh <app-id>` adds retry budget to an existing managed fragment without changing other Caddy settings.

HMAC blocks forged hooks, not traffic volume. Reject abuse at Caddy, the firewall, or an upstream provider. A source-IP allowlist must come from GitHub's current `hooks` ranges at `https://api.github.com/meta` and update automatically. Do not trust public `X-Forwarded-For` values unless the listener stays loopback-only behind a correctly configured proxy.

## Secrets

Public config stores only the environment-variable name. The HMAC secret belongs in a mode-`0600` environment file or systemd credential. Every app gets a different random secret.

Do not commit webhook secrets, app keys, repository credentials, registry credentials, TLS keys, database data, backups, or raw webhook logs.

## Installation

The first release targets Bun and a systemd user service. `install.sh` installs Bun when missing, then hands setup to `bunx shibumi-server@latest`. Direct `bunx shibumi-server@<version> init` remains the fixed automation path.

Initialization stages the exact invoked package, installs locked production dependencies with lifecycle scripts disabled, updates the local `current` link and `shis` launchers, writes mode-`0600` config and secret files, and writes the user unit. Startup, restart, and app registration use that local copy. They never download through `bunx`. Re-running `init` keeps machine-owned files and moves the service to the invoked version.

`shis update` validates npm's stable version, invokes that exact package through Bun, and reuses `init`. Routine update checks are short and non-blocking, and `serve` skips them.

`add <domain>` checks DNS, retries transient failures, and falls back to the OS resolver. Missing records, records elsewhere, Cloudflare-proxied records, and resolver failure remain separate states. Lookup failure never turns into DNS setup advice.

Registration then detects existing Caddy config, accepts repository names or GitHub URLs, asks for missing values, and picks the first free loopback port above `9000`. Automation can provide all three values as flags without loading prompt dependencies. App tests are optional.

Dots become hyphens in the app ID; literal hyphens first become double hyphens. This keeps `example.com` and `example-com.example` from colliding. Repeating the same registration keeps stored values, secret, checkout, and Caddy config. Conflicting values fail.

`add --dry-run` follows the same checks but changes no config, secrets, filesystem, systemd, containers, Caddy, or GitHub. Real registration accepts a clean matching checkout or clones a public repository. Dirty, diverged, or mismatched checkouts fail with recovery steps. Private repositories need server-side Git authentication first.

Caddy changes are declarative. New domains get per-site fragments with compression, safe headers, and bounded JSON logs. Existing domains keep their source block and import only the webhook route unless the operator chooses rewrite. The root helper accepts validated JSON, computes paths, backs up source, writes atomically, validates full config, reloads, and restores backup on failure. Setup explains the privileged action before sudo receives the password.

Each app can export `shibumi-server.json` with domain, app ID, repository, branch, webhook URL, service, app port, health path, mode, image platform, and confirmed server hostname. It excludes secrets, checkout paths, SSH users, aliases, and credentials. Deployment status writes mode-restricted snapshots so a client can poll `status --json` over SSH.

`list` shows registered apps and their Caddy ownership. `remove` resolves a domain or app ID, removes managed config, secret, status, route, and containers, and keeps checkout, volumes, images, and webhook. Removing the last app stops the service.

Uninstall asks first, stops and disables the service, then removes its unit, launchers, and installed releases. Config and secrets stay by default. `--yes` is the automation path. `--purge` asks again and removes those machine-owned files; automation must pass `--purge --yes`.

Initialization does not clone repositories, edit Caddy, call GitHub, or print secrets. App registration can clone and apply reviewed Caddy changes after confirmation and sudo. GitHub webhook creation remains a client action through `gh`. The server exposes its secret only as JSON through an explicit SSH command.

Verified deployments write bounded mode-`0600` JSONL history with time, app ID, delivery ID, commit, result, failed stage, and duration. Each app also keeps one mode-`0600` deployment log below 256 KiB. Payloads, signatures, secrets, and headers are never retained.

`rollback` restores the retained previous image without fetching, building, or running app tests. It starts the service and checks health. A successful rollback keeps the replaced image for the next rollback. Before startup, deployment records the running image. Failed startup or health restores it and checks it before reporting failure.

Durable replay state, GitHub commit statuses, GHCR, and Node/`npx` support are planned but not built.
