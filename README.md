# shibumi-server

Small, secure webhook deployments for a VPS running rootless Podman.

> Experimental: release `0.5.4` is being dogfooded.

Installed commands use short name `shis`. Original `shibumi-server` remains a compatible alias. Interactive output uses Clack's native interface with persimmon branding and plain text when color is unavailable.

## How it works

A signed GitHub push webhook causes `shibumi-server` to fetch the exact commit, validate the Compose config, build it locally, replace the old container with Podman Compose, and check the new container's local health endpoint. Projects can optionally run their own test command before startup. After a healthy deployment, the server keeps two successful images total (the active image and one rollback), then prunes older dangling images. Caddy remains the public HTTPS server.

```text
GitHub → Caddy → shibumi-server → Git → rootless Podman → health check
```

See [docs/architecture.md](docs/architecture.md) for the trust boundary and security model.

## Development

Requires [Bun](https://bun.sh/).

```bash
bun install
bun test
bun run check
```

Validate configuration and secrets:

```bash
bun src/cli.ts check --config ./config.json
```

Start the receiver:

```bash
bun src/cli.ts serve --config ./config.json
```

Copy [`examples/config.example.json`](examples/config.example.json) to a machine-local `config.json`. Real configuration and secrets are deliberately ignored by Git.

## Resource safety

Each deployment checks available host memory and free space on the checkout filesystem before touching Git. Defaults require 2 GiB of available memory and 4 GiB of free disk. Builds are killed after 10 minutes by default. Configure these per app with `minimumFreeMemoryMb`, `minimumFreeDiskMb`, and `buildTimeoutMs`.

The example systemd unit also caps the receiver and its direct build processes at 1.5 GiB of memory, 256 MiB of swap, two CPUs, and 512 tasks. Tune these ceilings for the host, but always leave capacity for SSH, Caddy, and existing apps. App containers run in Podman-managed cgroups and need their own Compose resource limits; see [the architecture guide](docs/architecture.md#resource-guards).

## GitHub webhook

Configure one webhook per app:

- URL: `https://example.com/hooks/github/myapp`
- Content type: `application/json`
- Event: push
- SSL verification: enabled
- Secret: a unique random value generated with `openssl rand -hex 32`

The receiver rejects malformed event, delivery, and signature headers before reading the body, then verifies `X-Hub-Signature-256`, repository, branch, and full commit SHA. Active and successful `X-GitHub-Delivery` UUIDs are remembered in a bounded 24-hour replay cache; a duplicate is acknowledged without deploying again, while failed deliveries can be retried. If the app is already deploying for a different delivery, it returns `409 Conflict`; deployments are not queued.

HMAC verification prevents fake requests from authorizing code, but it is not volumetric DDoS protection. Keep the listener on loopback and use Caddy, the host firewall, or an upstream provider to rate-limit the public webhook path. For stricter installations, allowlist GitHub's current `hooks` CIDRs from the [GitHub Meta API](https://api.github.com/meta) and automate updates so the list cannot silently go stale.

## Installation

The first release targets Linux with Bun, Git, rootless Podman, a usable Compose frontend (`podman compose` or `podman-compose`), Caddy, and a systemd user session. Log in to the VPS or homelab server as the deployment user and run:

```bash
curl -fsSL https://shibumistack.dev/install/server | bash
```

The Bash bootstrap installs Bun when needed, then runs interactive setup. Setup checks Git, Caddy, rootless Podman, a working Compose frontend, and the systemd user session before changing server configuration. It copies the resolved release locally, installs its lockfile-pinned production dependencies without lifecycle scripts, creates mode-restricted config and secret files, writes a resource-limited systemd user service, and installs `shibumi-server` in `~/.local/bin`. The service stays pinned to that local release until you run an explicit upgrade. Make sure `~/.local/bin` is on `PATH`.

Add the first app, or another one later, with the installed command:

```bash
shis add example.com
```

Interactive app setup retries transient DNS failures, falls back to the server's system resolver, distinguishes unavailable lookups from confirmed missing records, detects an existing Caddy site, accepts `github:owner/repo`, a GitHub repository URL, or a `/tree/<branch>` URL, suggests a user-owned checkout under `~/shibumi`, then assigns the first available loopback port from `9100`. Recommended Caddy settings enable Zstd with gzip fallback, indexing, safe baseline headers, and bounded JSON logs; Custom exposes each setting. Existing sites preserve their current block by default, with explicit rewrite available. Add `--dry-run` to follow the same detection, prompts, port selection, and validation without writing config or secrets, invoking sudo, or changing Caddy or systemd. A real add clones a missing checkout or safely fast-forwards a clean existing checkout to its configured origin branch, generates a unique 32-byte webhook secret, enables the user service, and asks sudo only when its constrained helper validates and reloads Caddy. GitHub remains unchanged until the client ship script configures its webhook. Rerunning the same domain command validates stored settings, preserves the checkout and webhook secret, skips Caddy mutation, and restarts the user service.

For scripts and unattended setup, pin the bootstrap release and provide every app value explicitly:

```bash
bunx shibumi-server@0.5.4 init
shis add example.com \
  --repository github:owner/repository \
  --checkout /srv/shibumi/apps/example-com \
  --port 9100
```

`init` stores the release under `~/.local/share/shibumi-server/releases/0.5.4`, updates the local `current` symlink and launcher, and prepares the config, secrets, and systemd service. Re-running it preserves machine config and secrets. `add` validates the complete app config. To run app-owned tests before startup, append an optional argument array such as `-- bun test`; it is never interpreted as a shell string.

List or remove registered apps with branded server-side flows:

```bash
shis list
shis remove example.com
```

Removal confirms the selected app, removes its Shibumi config, webhook secret, deployment status, managed Caddy route, and app containers, then validates and reloads Caddy. It preserves the checkout, volumes, images, and GitHub webhook. Remove the preserved webhook from GitHub when the domain will no longer deploy from that repository. `--yes` skips Shibumi's confirmation for automation but never bypasses sudo. Removing the last app stops the service.

Uninstall the service, launcher, and installed releases while preserving machine config and webhook secrets:

```bash
shis uninstall
```

Uninstall asks for confirmation and preserves config and webhook secrets by default. `shis uninstall --purge` also deletes them with a stronger confirmation. Automation can use `--yes`; purging requires explicit `--purge --yes`. Neither mode removes app checkouts, containers, Caddy routes, or GitHub settings.

Export commit-safe client configuration and inspect deployment status over SSH:

```bash
shis client-config example-com --server-hostname server.example.com
shis status example-com --commit <full-sha> --json
```

`client-config` contains app identity and routing metadata but no webhook secret, credentials, checkout path, or local SSH alias. `webhook-secret` exists only for an explicit SSH-to-`gh` handoff and prints JSON to stdout so clients can keep it in memory. Deployment status files are mode-restricted and updated atomically as webhook work moves through preflight, checkout, build, startup, and health stages. Verified webhook deliveries also append safe metadata to a mode-restricted, bounded history. Payloads, signatures, secrets, and request headers are never stored.

Inspect recent deployments, redeploy an already-pushed exact commit, or rollback to an earlier commit from the configured branch:

```bash
shis history example-com
shis history example-com --json
shis redeploy example-com <full-sha>
shis rollback example-com <sha>
```

Rollback accepts a unique SHA prefix of 7 to 40 lowercase hexadecimal characters, resolves it to a full commit, verifies the commit is an ancestor of the configured branch, then runs the normal resource checks, build, optional tests, startup, and health checks. It never accepts an arbitrary commit outside that branch. Before replacing a running app, every deployment records its current image. If the new release fails startup or health checks, Shibumi retags and recreates the previous image, then verifies its health.

Every user-run command checks npm for a newer stable release with a short timeout. When one exists, it suggests `shis update`; registry failures never block local work. Update installs the exact stable version reported by npm through Bun, reuses the idempotent `init` path, preserves config and secrets, updates the local release symlink and launcher, then reloads the systemd user service:

```bash
shis update
``` Hosts with the standalone Compose frontend add `--compose-command podman-compose`. Optional flags configure the branch ref, Compose file, service, and health path. Run `shis --help` for the full syntax. Add the webhook route before the site's normal handler, then copy the secret from the mode-`0600` file into GitHub's webhook settings.

## License

MIT
