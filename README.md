# shibumi-server

Small, secure webhook deployments for a VPS running rootless Podman.

> Experimental: the receiver and installer are implemented and being dogfooded. Release `0.1.0` is not published yet.

## How it works

A signed GitHub push webhook causes `shibumi-server` to fetch the exact commit, build and test it locally, start it with Podman Compose, and check its local health endpoint. Caddy remains the public HTTPS server.

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

The first release targets Linux with Bun, rootless Podman, Caddy, and a systemd user session. Once the package is published, log in to the VPS or homelab server and run the pinned version:

```bash
bunx shibumi-server@0.1.0
```

Interactive setup first checks for Git, Caddy, rootless Podman, and a systemd user session, and lists anything that needs attention before making changes. It then asks for the domain, GitHub repository, deployment directory, local port, and test command. Setup installs the selected release locally, creates mode-restricted config and secret files, writes a resource-limited systemd user service, and registers the app. Restarts use the same installed release; upgrades are always explicit.

For scripts and unattended setup, the two operations remain available separately:

```bash
bunx shibumi-server@0.1.0 init
bunx shibumi-server@0.1.0 add example.com \
  --repository owner/repository \
  --checkout /srv/shibumi/apps/example-com \
  --port 9100 \
  -- bun test
```

`init` stores the release under `~/.local/share/shibumi-server/releases/0.1.0`, updates the local `current` symlink, and prepares the config, secrets, and systemd service. Re-running it preserves machine config and secrets. `add` validates the complete app config and stores everything after `--` as a test-command argument array, never a shell string.

Hosts with the standalone Compose frontend add `--compose-command podman-compose`. Optional flags configure the branch ref, Compose file and service, and health path; run `bunx shibumi-server@0.1.0 --help` for the full syntax.

Setup generates a unique 32-byte webhook secret, enables the user service, and prints the webhook URL, secret variable name, and Caddy upstream. It deliberately does not modify Caddy or GitHub. Add the webhook route before the site's normal handler, then copy the secret from the mode-`0600` file into GitHub's webhook settings.

## License

MIT
