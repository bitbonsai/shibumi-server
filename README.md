# shibumi-server

Small, secure webhook deployments for a VPS running rootless Podman.

> Experimental: the receiver is being built and dogfooded. The installation commands are not published yet.

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

## GitHub webhook

Configure one webhook per app:

- URL: `https://example.com/hooks/github/myapp`
- Content type: `application/json`
- Event: push
- SSL verification: enabled
- Secret: a unique random value generated with `openssl rand -hex 32`

The receiver verifies `X-Hub-Signature-256`, repository, branch, and full commit SHA. If the app is already deploying, it returns `409 Conflict`; deployments are not queued.

## Future installation

The intended installation UX is:

```bash
bunx shibumi-server init
bunx shibumi-server add example.com
```

The installer will place a pinned copy on the server and create a systemd unit. It will not run an unpinned `bunx` download on every restart.

## License

MIT
