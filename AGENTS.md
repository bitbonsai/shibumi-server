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
- No-argument interactive setup checks Git, Caddy, rootless Podman, and the systemd user session before installing the pinned service and `~/.local/bin/shibumi-server` launcher. `add <domain>` checks DNS, detects existing Caddy state, prompts for missing repository and checkout values, then assigns the first available port from `9100`; keep complete flags available for automation. `add --dry-run` must follow the same detection, prompt, port-selection, and validation path while making no config, secret, filesystem, systemd, container, Caddy, or GitHub changes. App-owned tests are optional and available only through explicit config or `add` arguments; never invoke them through a shell.
- Dynamically import interactive prompt dependencies. The pinned service release does not include `node_modules`, so `serve` and `check` must start without resolving `@clack/prompts`.
- Caddy changes require explicit confirmation before sudo handles the password directly. Keep the installed root helper constrained to schema-validated JSON over stdin, computed paths, loopback upstreams, fixed directives, bounded logs, atomic writes, full validation, reload, and rollback. Never accept arbitrary Caddy text, commands, paths, or upstream hosts.
- Commit-safe `client-config` output must never include secrets, checkout paths, SSH users, local aliases, or credentials. Webhook secret handoff is JSON over explicit SSH and must not print in interactive prose. Status snapshots stay mode-restricted and expose no logs or secrets.
- User-run CLI commands check the npm registry for newer stable releases, warn with the reviewed installer command when outdated, and fail open on timeout or registry errors. Keep `serve` startup independent from this network check.
- Release version digits must add up to one of Mauricio's preferred totals: `1`, `2`, `3`, `5`, `7`, or `9`. Enforce this in package tests; `0.1.6` is valid because its digits total `7`.
- Normal unit tests must fake Git, Podman, and systemd. Real integration tests must use unique disposable projects and clean up.

## Public versus local

Public files use generic `myapp`/`example.com` examples. Do not add hostnames, usernames, real paths, ports, webhook URLs, or app inventory from a specific installation. Actual configuration belongs outside the checkout.
