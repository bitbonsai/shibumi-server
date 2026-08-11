# Architecture

`shibumi-server` is a small host service for webhook-driven deployments to a VPS running rootless Podman.

## Request flow

```text
Git push
  → git host sends HTTPS webhook
  → Caddy proxies the webhook path to localhost
  → shibumi-server verifies the signature, repository, and branch
  → shibumi-server fetches the exact commit
  → Podman validates and builds the application
  → optional app-owned tests run in a temporary container
  → Podman replaces the application container
  → shibumi-server checks the local health endpoint
  → Podman retains two rollback images and prunes older dangling images
```

The receiver listens on a loopback address. Caddy is the only public HTTP server.

## Trust boundary

A valid webhook authorizes repository code to build and run as the deployment Unix user. Use a dedicated unprivileged account and rootless Podman. Do not give that account access to unrelated applications.

The receiver never executes command text from the webhook. Repository, branch, checkout, Compose service, optional test command, and port all come from local configuration. Webhook values are compared against that configuration and commands are executed as argument arrays without a shell.

## Request validation

GitHub requests must:

- fit within the configured body limit;
- use JSON;
- include a well-formed `X-GitHub-Delivery` UUID and supported event name;
- include a valid `X-Hub-Signature-256` HMAC over the raw body;
- identify the configured repository and exact `refs/heads/*` branch; and
- contain a full lowercase 40-character commit SHA.

Malformed authentication headers are rejected before the body is read. A signed GitHub `ping` receives `200`. A valid push receives `202` while deployment continues asynchronously.

Accepted delivery UUIDs are held in an in-memory, bounded 24-hour replay cache. Repeating a successful or active delivery receives `200` and does not build again. The cache deliberately records only fully verified pushes after the app lock is acquired, so an attacker cannot fill it with unsigned IDs. Failed deployments are removed so an operator can redeliver them; a delivery rejected with `409` is never recorded. Durable replay state across service restarts is later work.

Deployments are locked per application. A different delivery for an app that is already deploying receives `409 Conflict` and is not queued. It must be redelivered after the active deployment finishes.

## Deterministic checkout

The deployment checkout is dedicated to the service. It must be clean before deployment.

```text
git status --porcelain
git fetch --prune origin <configured-ref>
git rev-parse FETCH_HEAD
git reset --hard <verified-commit>
```

The fetched commit must exactly match the signed webhook payload. Runtime data and secrets must live outside the checkout.

## Resource guards

Before changing the checkout or starting a build, the receiver checks Linux `MemAvailable` and free space on the checkout filesystem. The default per-app floors are 2 GiB of available memory and 4 GiB of disk. If either cannot be measured or is below its configured floor, deployment stops at the `preflight` stage. Put the checkout and rootless Podman storage on the same filesystem; otherwise the disk check does not cover image storage.

Compose builds have a configurable deadline, 10 minutes by default. The receiver starts each command in its own process group, sends `SIGKILL` to the build group when it exceeds the deadline, and never proceeds to optional tests or startup. This bounds a stuck build, but a killed build may leave intermediate Podman data for an operator to inspect and prune deliberately.

The shipped systemd unit adds cgroup ceilings for the receiver and direct child processes:

```ini
MemoryHigh=1280M
MemoryMax=1536M
MemorySwapMax=256M
CPUQuota=200%
TasksMax=512
OOMPolicy=stop
```

These defaults are intended to preserve a small host rather than make every framework build succeed. Tune them only after reserving capacity for the operating system, SSH, Caddy, and already-running applications. Podman-managed application containers need explicit Compose limits of their own:

```yaml
services:
  web:
    deploy:
      resources:
        limits:
          cpus: "1.0"
          memory: 512M
```

Preflight checks, deadlines, and cgroup ceilings are defense in depth, not a substitute for filesystem quotas, monitoring, backups, or testing builds away from a constrained production VPS.

## Image cleanup

After a healthy deployment, the receiver tags the active image in an app-specific local repository. It keeps that image plus the configured number of earlier successful images, two by default, so an operator has known images available for rollback. Release tags older than that window are removed before `podman image prune --force` removes dangling data.

The retention setting accepts zero through ten rollback images. Image cleanup does not use `--all` or `system prune`, so retained tags, running containers, volumes, and unrelated networks remain. Retention or cleanup failure is logged but does not turn a healthy deployment into a failed one.

## Ports and Caddy

Every app has an explicit Compose frontend and host port. Modern installations can use `["podman", "compose"]`; hosts with the standalone frontend can use `["podman-compose"]`. Compose binds the app only to loopback:

```yaml
services:
  web:
    ports:
      - "127.0.0.1:${SHIBUMI_PORT}:3000"
```

Caddy maps the public domain to that port. Other Compose services remain private on the application network. Ports are operational configuration, not secrets, but real machine inventory does not belong in the public repository.

HMAC authentication prevents forged hooks from authorizing a deployment; it does not absorb volumetric traffic. Reject abuse at Caddy, the firewall, or an upstream provider before it reaches Bun. An optional source-IP allowlist must be generated from GitHub's current `hooks` CIDRs at `https://api.github.com/meta` and updated automatically. Do not copy a static range into the project and forget it, and do not trust public `X-Forwarded-For` values unless the listener remains loopback-only behind a correctly configured proxy.

## Secrets

The public JSON configuration stores only an environment-variable name. The HMAC secret itself belongs in a mode-`0600` environment file or systemd credential. Use a different random secret for every app.

Never commit webhook secrets, application keys, repository credentials, registry credentials, TLS private keys, database data, backups, or raw webhook payload logs.

## Service installation

The first release targets Bun and a systemd user service. `install.sh` is a Bash bootstrap for Linux deployment users; it installs Bun when missing, then hands interactive setup to `bunx shibumi-server@latest`. Direct `bunx shibumi-server@<version> init` remains the pinned automation path. Initialization copies the exact invoked package into a staged versioned release directory, installs lockfile-pinned production dependencies with lifecycle scripts disabled, atomically updates a local `current` symlink and `~/.local/bin/shibumi-server` launcher, creates mode-`0600` config and secret files, and writes the user unit. The unit and launcher execute that local copy and never download through `bunx` during startup, restart, or app registration. Re-running `init` preserves machine-owned files and lets an active service move to the newly invoked version. `shibumi-server update` validates the stable version reported by npm, invokes that exact package through Bun, and reuses `init`; routine update checks remain short, non-blocking, and disabled in `serve`.

`add <domain>` verifies DNS, retrying transient A/AAAA failures and falling back to the server's OS resolver. Confirmed absent records, records pointing elsewhere, Cloudflare-proxied records, and unavailable resolvers are distinct states; lookup failure never produces DNS setup instructions. It then detects whether Caddy already serves the hostname, accepts canonical repository names or HTTPS GitHub URLs, prompts for a missing repository or absolute checkout with a `~/www/<app-id>` default, and assigns the first unassigned and locally available loopback port from `9100`. Automation can provide all three values as flags and avoid loading the prompt dependency. An app-owned test command is optional. The domain becomes a safe app ID by escaping literal hyphens as `--` before replacing dots with `-`, preventing dashed labels from colliding with domain separators. The rest of the deployment values come only from local prompts, flags, and safe defaults. Registration validates the complete config before writing it, creates a different random 32-byte HMAC secret for each app, and restarts the service. `add --dry-run` follows the same DNS and Caddy detection, prompt, port-selection, and validation path but returns the candidate configuration before cloning, reading or writing secrets, invoking sudo, writing config, or changing Caddy or systemd. Real registration verifies an existing checkout origin or clones a public repository; private repositories must already have working server-side Git authentication.

Caddy integration is declarative and constrained. New domains get per-site fragments with Zstd and gzip compression, indexing allowed, safe baseline headers, and bounded JSON access logs by default. Existing domains preserve their source block and import only a fixed webhook route unless the operator explicitly chooses rewrite. A root-owned helper accepts schema-validated JSON through stdin, computes all paths itself, backs up source files, writes atomically, validates the complete Caddy configuration, reloads without stopping active connections, and restores the backup on failure. Shibumi explains the exact privileged action before `sudo` receives the password directly.

Each app can export `shibumi-server.json`, a versioned client document containing domain, app ID, repository, branch, webhook URL, service, health path, and a confirmed server hostname. It excludes secrets, checkout paths, SSH users, aliases, and credentials. Webhook deployments write mode-restricted status snapshots atomically so a client can poll `status --json` over existing SSH access without a public status endpoint or GitHub deployment token. Repeating the same registration is idempotent and does not rotate the secret; conflicting settings fail closed.

Uninstall stops and disables the webhook service, then removes its unit, launcher, and installed releases while preserving config and secrets by default. `--purge` requires confirmation and removes those machine-owned files; `--purge --yes` is the explicit automation path. Neither mode removes app checkouts, containers, Caddy routes, or GitHub settings.

Initialization does not clone repositories, edit Caddy, call GitHub, or print secret values. Interactive app registration can clone a public repository and apply reviewed Caddy changes only after explicit confirmation and sudo authorization. GitHub webhook creation remains a client action over `gh`; the server exposes its secret only as JSON through an explicit SSH command. Durable replay state, automatic health rollback, deployment queues, GitHub commit statuses, GHCR, and Node/`npx` compatibility remain later work.
