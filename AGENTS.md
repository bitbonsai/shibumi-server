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

- Verify `X-Hub-Signature-256` over the raw request body before parsing payload data.
- Compare signatures in constant time.
- Match repository and exact branch against machine-local configuration.
- Accept only full lowercase 40-character commit SHAs.
- Never interpolate payload or config values into a shell command; use argument arrays.
- Keep the HTTP listener and app ports on loopback behind Caddy.
- Keep webhook secrets, credentials, real machine config, and deployment state out of Git and npm packages.
- Preserve the per-app lock: concurrent deployment requests return `409` and are not queued.
- Failed fetches, builds, or tests must not run `compose up`.
- Normal unit tests must fake Git and Podman. Real integration tests must use unique disposable projects and clean up.

## Public versus local

Public files use generic `myapp`/`example.com` examples. Do not add hostnames, usernames, real paths, ports, webhook URLs, or app inventory from a specific installation. Actual configuration belongs outside the checkout.
