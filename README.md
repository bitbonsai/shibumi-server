# shibumi-server

Deploy apps to a Linux VPS with rootless Podman, Caddy, and systemd.

> Experimental. Version `0.10.6` is in dogfood use.

The command is `shis`. `shibumi-server` still works. Terminal output uses Clack with persimmon branding, and plain text when color is unavailable.

## How it works

`bun ship` checks your committed code, builds the server image on your computer, and uploads it over SSH before pushing Git. The signed GitHub webhook tells `shibumi-server` to fetch that exact commit. The server checks repository, app, commit, Git tree, tag, and platform before replacing the container and checking its health.

```text
local build → SSH image upload → Git push → signed webhook → verify → rootless Podman → health check
```

Server-side builds remain available with `deploymentMode: "build"`.

Apps can run a test command before startup. Every app gets `SHIBUMI_COMMIT` and `SHIBUMI_DEPLOYED_AT` in its environment. After a healthy deploy, the server keeps the active image plus one rollback image, then prunes dangling image data. Caddy handles public HTTPS and retries the app upstream for 20 seconds during replacement.

Read the [documentation](https://server.shibumistack.dev/docs). Markdown sources live in [`docs/`](docs/).

## Development

Requires [Bun](https://bun.sh/).

```bash
bun install
bun test
bun run check
```

Validate config and secrets:

```bash
bun src/cli.ts check --config ./config.json
```

Start the receiver:

```bash
bun src/cli.ts serve --config ./config.json
```

Copy [`examples/config.example.json`](examples/config.example.json) to a machine-local `config.json`. Git ignores real config and secrets.

## Resource safety

Before touching Git, each deploy checks available memory and free space on the checkout filesystem. Server builds default to 2 GiB available memory; prebuilt apps default to 512 MiB. Both default to 4 GiB free disk. Server builds stop after 10 minutes. Set `minimumFreeMemoryMb`, `minimumFreeDiskMb`, and `buildTimeoutMs` per app.

The systemd unit caps the receiver at 1.5 GiB memory, 256 MiB swap, two CPUs, and 512 tasks. Leave capacity for SSH, Caddy, and running apps. Set app limits in Compose; see [resource guards](docs/architecture.md#resource-guards).

## GitHub webhook

Configure one webhook per app:

- URL: `https://example.com/hooks/github/myapp`
- Content type: `application/json`
- Event: push
- SSL verification: enabled
- Secret: unique random value from `openssl rand -hex 32`

The receiver rejects malformed headers before reading the body, then verifies the signature, repository, branch, and commit SHA. Verified delivery IDs stay in a bounded 24-hour cache. A duplicate gets acknowledged without another deploy. If an app is already deploying, a newer commit waits in a persistent latest-wins queue; later pushes replace it.

HMAC blocks fake requests, not heavy traffic. Keep the listener on loopback and rate-limit the public path in Caddy, the firewall, or an upstream provider. For stricter installs, allowlist GitHub's current `hooks` CIDRs from the [GitHub Meta API](https://api.github.com/meta) and update the list automatically.

## Installation

The server needs Linux with Bun, Git, rootless Podman, `podman compose` or `podman-compose`, Caddy, and a systemd user session.

Start from the local project root:

```bash
curl -fsSL https://shibumistack.dev/install/ship.sh | sh
```

Ship connects over confirmed SSH, installs or upgrades `shibumi-server`, enables prebuilt deploys, registers the app, and configures GitHub. Local builds need Colima, Docker CLI, Docker Compose, and Buildx. If Docker config names a missing credential helper, Ship offers to remove that reference after saving a mode-`0600` backup.

Recommended macOS setup:

```bash
brew install colima docker docker-compose docker-buildx
colima start
docker info
docker compose version
docker buildx version
```

To prepare the server directly, log in as the deployment user and run:

```bash
curl -fsSL https://server.shibumistack.dev/install | bash
```

The bootstrap installs Bun when needed, then runs setup. Setup checks the host before changing config. It installs the fixed release locally, creates restricted config and secret files, writes the systemd user service, and installs `shis` in `~/.local/bin`. The service runs that local release until you update it. Put `~/.local/bin` on `PATH`.

Add an app on the server with:

```bash
shis add example.com
```

Setup checks DNS and existing Caddy config, accepts `github:owner/repo` or a GitHub URL, suggests a checkout under `~/shibumi`, and picks the first free loopback port above `9000`. It writes the app config, creates a 32-byte webhook secret, enables the service, and asks sudo only when the constrained Caddy helper has validated the change. GitHub stays unchanged until the project client configures its webhook.

Use `--dry-run` to follow the same path without writing config or secrets, running sudo, or changing Caddy or systemd. Repeating the same registration keeps stored settings and restarts the service. Conflicting settings fail.

For unattended setup, pin the release and provide every app value:

```bash
bunx shibumi-server@0.10.6 init
shis add example.com \
  --repository github:owner/repository \
  --checkout /srv/shibumi/apps/example-com \
  --port 9100 \
  --deployment-mode prebuilt
```

`init` stores the release under `~/.local/share/shibumi-server/releases/0.10.6`, updates the `current` link and launcher, and prepares config, secrets, and systemd. Re-running it keeps machine config and secrets. Prebuilt mode accepts only the exact commit-tagged Linux image loaded through `shis image-load`. Add app tests after `--`, such as `-- bun test`.

List or remove apps:

```bash
shis list
shis remove example.com
```

Removal deletes Shibumi config, secret, status, managed Caddy route, and app containers. It keeps the checkout, volumes, images, and GitHub webhook. Remove that webhook in GitHub when the domain no longer deploys from its repository. `--yes` skips Shibumi confirmation, not sudo. Removing the last app stops the service.

Uninstall the service, launcher, and installed releases:

```bash
shis uninstall
```

Config and webhook secrets stay. `shis uninstall --purge` deletes them after a stronger confirmation. Automation must pass `--purge --yes`. Neither mode removes checkouts, containers, Caddy routes, or GitHub settings.

Export client config and inspect status over SSH:

```bash
shis client-config example-com --server-hostname server.example.com
shis status example-com --commit <full-sha> --json
```

Client config has app identity and routing metadata, with no secret, credentials, checkout path, or SSH alias. `webhook-secret` prints JSON only for explicit SSH-to-`gh` handoff.

Inspect recent deploys, redeploy an existing commit, or restore the previous image:

```bash
shis history example-com
shis history example-com --json
shis logs example-com
shis redeploy example-com <full-sha>
shis deployment-mode example-com prebuilt
shis rollback example-com
```

`deployment-mode` switches between local prebuilt images and server builds, adjusts its memory floor, and restarts the service. `enable-prebuilt` remains an alias. `logs` prints the latest mode-`0600` deployment log, bounded to 256 KiB.

Rollback restores the previous image kept for up to 12 hours, starts it without building, and checks health. A successful rollback keeps the replaced image for the next rollback. If rollback fails health, Shibumi restores the current image. Normal deploys also record the running image and restore it after failed startup or health.

`shis` checks npm for newer stable releases and suggests `shis update` when one exists. Registry failures never block local work. `update` installs the exact stable version, keeps config and secrets, updates the local release link, and reloads the service.

Hosts with the standalone Compose frontend can pass `--compose-command podman-compose`. Optional flags set branch, Compose file, service, and health path. Run `shis --help` for full syntax.

## License

MIT
