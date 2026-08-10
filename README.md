# shibumi-server

Small, secure webhook deployments for a VPS running rootless Podman.

> Experimental: the receiver and installer are implemented and being dogfooded. Release `0.1.0` is not published yet.

## How it works

A signed GitHub push webhook causes `shibumi-server` to fetch the exact commit, validate the Compose config, build it locally, replace the old container with Podman Compose, and check the new container's local health endpoint. Projects can optionally run their own test command before startup. After a healthy deployment, the server keeps the active image and two rollback images, then prunes older dangling images. Caddy remains the public HTTPS server.

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

The first release targets Linux with Bun, Git, rootless Podman, Caddy, and a systemd user session. Once the package is published, log in to the VPS or homelab server as the deployment user and run:

```bash
curl -fsSL https://shibumistack.dev/install/server | bash
```

The Bash bootstrap installs Bun when needed, then runs interactive setup. Setup checks Git, Caddy, rootless Podman, and the systemd user session before changing server configuration. It copies the resolved release locally, creates mode-restricted config and secret files, writes a resource-limited systemd user service, and installs `shibumi-server` in `~/.local/bin`. The service stays pinned to that local release until you run an explicit upgrade. Make sure `~/.local/bin` is on `PATH`.

Add the first app, or another one later, with the installed command:

```bash
shibumi-server add example.com
```

Interactive app setup asks for the repository and deployment directory, then assigns the first available loopback port from `9100`. It generates a unique 32-byte webhook secret, enables the user service, and prints the webhook URL, secret variable name, and Caddy upstream. It does not modify Caddy or GitHub.

For scripts and unattended setup, pin the bootstrap release and provide every app value explicitly:

```bash
bunx shibumi-server@0.1.0 init
shibumi-server add example.com \
  --repository owner/repository \
  --checkout /srv/shibumi/apps/example-com \
  --port 9100
```

`init` stores the release under `~/.local/share/shibumi-server/releases/0.1.0`, updates the local `current` symlink and launcher, and prepares the config, secrets, and systemd service. Re-running it preserves machine config and secrets. `add` validates the complete app config. To run app-owned tests before startup, append an optional argument array such as `-- bun test`; it is never interpreted as a shell string.

Hosts with the standalone Compose frontend add `--compose-command podman-compose`. Optional flags configure the branch ref, Compose file, service, and health path. Run `shibumi-server --help` for the full syntax. Add the webhook route before the site's normal handler, then copy the secret from the mode-`0600` file into GitHub's webhook settings.

## License

MIT
