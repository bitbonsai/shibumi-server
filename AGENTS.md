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

## Releases

Create and push matching `v${version}` Git tag at release commit before `npm publish`. Postpublish website sync verifies tagged `install.sh`; publishing first uploads package but leaves sync failed.

## Security invariants

- Reject malformed event, delivery UUID, and signature headers before reading the request body; verify `X-Hub-Signature-256` over the raw body before parsing payload data.
- Compare signatures in constant time and preserve bounded replay protection for accepted `X-GitHub-Delivery` IDs.
- Match repository and exact branch against machine-local configuration.
- Accept only full lowercase 40-character commit SHAs.
- Prebuilt images require exact app ID, repository, commit revision, Git source-tree, tag, and server-platform identity. Resolve source tree independently after webhook fetch; never trust upload labels alone.
- Never interpolate payload or config values into a shell command; use argument arrays.
- Keep the HTTP listener and app ports on loopback behind Caddy.
- Keep webhook secrets, credentials, real machine config, and deployment state out of Git and npm packages.
- Preserve the per-app lock: concurrent deployment requests return `409` and are not queued.
- Failed preflights, fetches, Compose validation, builds, or optional app tests must not run `compose up`.
- After a successful health check, retain the active app image and `retainedRollbackImages` earlier successful images (one by default, two successful images total), then prune dangling Podman images. Retention and cleanup are best effort: log failures without failing a healthy deployment. Never broaden cleanup to `--all` or `system prune`.
- Preserve host resource guards: preflight memory/disk floors, a cancellable build deadline, systemd ceilings, and per-app Compose limits.
- The systemd unit must execute a pinned local package copy, never an unpinned `bunx` command. Init must preserve machine config/secrets. Repeating an existing domain registration must preserve its checkout, config, secret, and Caddy state while restarting the service; conflicting settings fail closed.
- Wrap imported `node:dns/promises` functions in arrow functions before storing them on the DNS resolver object. Bun fails those functions when invoked with the resolver object as `this`. Preserve lookup errors, retry transient failures, fall back to the OS resolver, and report `unknown` separately; never turn resolver failure into missing DNS.
- Installed releases expose compatible `shis` and `shibumi-server` launchers. Human-facing help and interactive flows brand themselves exactly `渋み  shis (shibumi-server)` and prefer concise `shis` commands. Keep Clack's native interface and color only branding persimmon through `terminal-ui.ts`. Respect `NO_COLOR`, non-TTY output, and `TERM=dumb`; machine-readable JSON commands stay free of decorative output.
- Verified webhook deployments write bounded mode-`0600` history without payloads, signatures, secrets, or request headers. Keep only latest per-app deployment log, mode `0600`, bounded to 256 KiB, with ANSI/control characters stripped. Rollback restores the one retained previous image without fetching or building, verifies health, rotates retention so the replaced image becomes the next rollback image, and restores the current image if rollback fails. Capture the running image before cutover and restore it when startup or health checks fail.
- No-argument interactive setup checks Git, Caddy, rootless Podman, and the systemd user session before installing the pinned service and `~/.local/bin/shibumi-server` launcher. `add <domain>` checks DNS, detects existing Caddy state, accepts canonical repository names or HTTPS GitHub URLs, prompts for missing repository and checkout values with a user-owned `~/shibumi/<app-id>` checkout default, then assigns the first available port above `9000`; keep complete flags available for automation. `add --dry-run` must follow the same detection, prompt, port-selection, and validation path while making no config, secret, filesystem, systemd, container, Caddy, or GitHub changes. App-owned tests are optional and available only through explicit config or `add` arguments; never invoke them through a shell.
- Dynamically import interactive prompt dependencies so `serve` and `check` do not load `@clack/prompts`. Each pinned release must include `runtime-lock.json`, kept byte-identical to `bun.lock`, rename it to `bun.lock` during staging, and install production dependencies with `--frozen-lockfile --production --ignore-scripts` before activation; interactive commands run from that self-contained release.
- Caddy changes require explicit confirmation before sudo handles the password directly. Keep the installed root helper constrained to schema-validated JSON over stdin, computed paths, loopback upstreams, fixed directives, bounded logs, atomic writes, full validation, reload, and rollback. Never accept arbitrary Caddy text, commands, paths, or upstream hosts.
- Commit-safe `client-config` output must never include secrets, checkout paths, SSH users, local aliases, or credentials. Webhook secret handoff is JSON over explicit SSH and must not print in interactive prose. Successful manual registration ends with a concise branded summary and exact local ship installer command, never raw secret paths or placeholder commands. Status snapshots stay mode-restricted and expose no logs or secrets.
- User-run CLI commands check the npm registry for newer stable releases, suggest `shis update` when outdated, and fail open on timeout or registry errors. Keep `serve` startup independent from this network check. Explicit update resolves one validated stable version, installs that exact npm release through Bun, and reuses idempotent `init` so config and secrets survive.
- Release version digits must add up to one of Mauricio's preferred totals: `1`, `2`, `3`, `5`, `7`, or `9`. Enforce this in package tests; `0.3.2` is valid because its digits total `5`.
- Every user-facing CLI failure includes a concrete `Next:` action or command. Syntax errors may show usage; operational failures never dump full help.
- Existing clean app checkouts fast-forward to configured origin/ref during registration. Dirty, diverged, inaccessible, or source-incomplete checkouts fail with specific recovery; never reset or discard user work.
- `list` and `remove` use branded output. Legacy `composeCommand: ["podman"]` config normalizes to `["podman", "compose"]` before deploy or removal. Default app removal deletes Shibumi config, its secret, deployment status, managed Caddy route, and app containers while preserving checkout, volumes, images, and GitHub webhook. Last-app removal stops the service. Caddy removal stays constrained, backed up, validated, reloaded, and rolled back by the root helper.
- Normal unit tests must fake Git, Podman, and systemd. Real integration tests must use unique disposable projects and clean up.

## Public versus local

Public files use generic `myapp`/`example.com` examples. Do not add hostnames, usernames, real paths, ports, webhook URLs, or app inventory from a specific installation. Actual configuration belongs outside the checkout.
