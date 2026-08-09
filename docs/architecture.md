# Architecture

`shibumi-server` is a small host service for webhook-driven deployments to a VPS running rootless Podman.

## Request flow

```text
Git push
  → git host sends HTTPS webhook
  → Caddy proxies the webhook path to localhost
  → shibumi-server verifies the signature, repository, and branch
  → shibumi-server fetches the exact commit
  → Podman builds and tests the application
  → Podman replaces the application container
  → shibumi-server checks the local health endpoint
```

The receiver listens on a loopback address. Caddy is the only public HTTP server.

## Trust boundary

A valid webhook authorizes repository code to build and run as the deployment Unix user. Use a dedicated unprivileged account and rootless Podman. Do not give that account access to unrelated applications.

The receiver never executes command text from the webhook. Repository, branch, checkout, Compose service, test command, and port all come from local configuration. Webhook values are compared against that configuration and commands are executed as argument arrays without a shell.

## Request validation

GitHub requests must:

- fit within the configured body limit;
- use JSON;
- include a valid `X-Hub-Signature-256` HMAC over the raw body;
- identify the configured repository and exact `refs/heads/*` branch; and
- contain a full lowercase 40-character commit SHA.

A signed GitHub `ping` receives `200`. A valid push receives `202` while deployment continues asynchronously.

Deployments are locked per application. A second request for an app that is already deploying receives `409 Conflict` and is not queued. It must be redelivered after the active deployment finishes.

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

Compose builds have a configurable deadline, 10 minutes by default. The receiver starts each command in its own process group, sends `SIGKILL` to the build group when it exceeds the deadline, and never proceeds to tests or startup. This bounds a stuck build, but a killed build may leave intermediate Podman data for an operator to inspect and prune deliberately.

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

## Ports and Caddy

Every app has an explicit Compose frontend and host port. Modern installations can use `["podman", "compose"]`; hosts with the standalone frontend can use `["podman-compose"]`. Compose binds the app only to loopback:

```yaml
services:
  web:
    ports:
      - "127.0.0.1:${SHIBUMI_PORT}:3000"
```

Caddy maps the public domain to that port. Other Compose services remain private on the application network. Ports are operational configuration, not secrets, but real machine inventory does not belong in the public repository.

## Secrets

The public JSON configuration stores only an environment-variable name. The HMAC secret itself belongs in a mode-`0600` environment file or systemd credential. Use a different random secret for every app.

Never commit webhook secrets, application keys, repository credentials, registry credentials, TLS private keys, database data, backups, or raw webhook payload logs.

## Service installation

The first release targets Bun and a systemd user service. A future `bunx shibumi-server install` command will install a pinned local package and write the unit. The unit will not execute an unpinned package download at every restart.

Caddy API automation, automatic port allocation, immutable-image rollback, deployment queues, GitHub commit statuses, GHCR, and Node/`npx` compatibility are later work.
