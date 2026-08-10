# Agent notes

## Project

`shibumi-server` is a Bun service that receives signed GitHub push webhooks and deploys configured applications with rootless Podman Compose.

## Commands

```bash
bun install
bun test
bun run check
npm pack --dry-run
```

The real Podman integration test is opt-in:

```bash
SHIBUMI_INTEGRATION=1 bun test test/integration.test.ts
```

Use `SHIBUMI_COMPOSE_COMMAND=podman-compose` on hosts with the standalone Compose frontend.

## Security invariants

- Reject malformed event, delivery UUID, and signature headers before reading the request body; verify `X-Hub-Signature-256` over the raw body before parsing payload data.
- Compare signatures in constant time and preserve bounded replay protection for accepted `X-GitHub-Delivery` IDs.
- Match repository and exact branch against machine-local configuration.
- Accept only full lowercase 40-character commit SHAs.
- Never interpolate payload or config values into a shell command; use argument arrays.
- Keep the HTTP listener and app ports on loopback behind Caddy.
- Keep webhook secrets, credentials, real machine config, and deployment state out of Git and npm packages.
- Preserve the per-app lock: concurrent deployment requests return `409` and are not queued.
- Failed preflights, fetches, Compose validation, builds, or optional app tests must not run `compose up`.
- After a successful health check, retain the active app image and `retainedRollbackImages` earlier successful images (two by default), then prune dangling Podman images. Retention and cleanup are best effort: log failures without failing a healthy deployment. Never broaden cleanup to `--all` or `system prune`.
- Preserve host resource guards: preflight memory/disk floors, a cancellable build deadline, systemd ceilings, and per-app Compose limits.
- The systemd unit must execute a pinned local package copy, never an unpinned `bunx` command. Init must preserve machine config/secrets; repeated app registration must not rotate secrets.
- No-argument interactive setup checks Git, Caddy, rootless Podman, and the systemd user session before combining `init` and `add`; keep both explicit commands for automation. App-owned tests are optional and available only through explicit config/`add` arguments; never invoke them through a shell.
- Dynamically import interactive prompt dependencies. The pinned service release does not include `node_modules`, so `serve` and `check` must start without resolving `@clack/prompts`.
- Normal unit tests must fake Git, Podman, and systemd. Real integration tests must use unique disposable projects and clean up.

## Public versus local

Public files use generic `myapp`/`example.com` examples. Do not add hostnames, usernames, real paths, ports, webhook URLs, or app inventory from a specific installation. Actual configuration belongs outside the checkout.
