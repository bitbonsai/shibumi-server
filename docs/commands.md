# Commands

## Project client

Run these commands from a connected project:

```text
bun dev                         Run the app locally on its assigned Shibumi port
bun ship                        Build, upload, and deploy committed HEAD
bun ship --rebuild              Ship without Docker layer cache
bun ship -y                     Accept routine ship confirmations
bun ship:setup                  Register or reconfigure the project
bun ship:update                 Review and install the current Ship client
bun ship:status                 Compare server status with local HEAD
bun ship:logs                   Read the latest bounded deployment log
bun ship --rollback             Restore the retained previous image
bun ship:env set KEY=VALUE ...  Set app environment values on the server
bun ship:env import [file]      Import a local .env file (default .env.production)
bun ship:env list               List variable names, never values
bun ship:env rm KEY ...         Remove variables
```

`bun dev` runs the project's original development command, stored as `dev:app`, with `PORT` and `SHIBUMI_PORT` set to the registered app port.

## Server CLI

Use `shis` on the VPS. `shibumi-server` remains an alias.

### Setup

```text
shis                              Guided installation
shis setup                        Guided installation
shis init                         Install only, for automation
shis update                       Install latest stable release
shis uninstall [--purge] [--yes]
```

### Apps

```text
shis list
shis add <domain> [--dry-run]
shis remove <domain|app-id> [--yes]
shis set-repository <domain|app-id> <repository> [--yes]
```

Explicit add needs repository, absolute checkout, and port:

```text
shis add <domain> \
  --repository <github:owner/repo|GitHub URL> \
  --checkout <absolute-path> \
  --port <port> \
  [--ref <refs/heads/main>] \
  [--compose-file <path>] \
  [--compose-command <podman|podman-compose>] \
  [--service <name>] \
  [--health-path </healthz>] \
  [--dry-run] \
  [-- <test-command...>]
```

`set-repository` moves the existing checkout to `<checkout>.bak`, clones the new repository in its place, and updates the registration without touching Caddy or re-registering the app. The Compose file path is re-detected in the new repository rather than reused from the old one. `shis add` offers the same move when an existing checkout's Git origin doesn't match the repository being added.

### Environment

```text
shis env set <app-id>             Set vars from KEY=VALUE lines on stdin
shis env list <app-id> [--json]   List variable names, never values
shis env rm <app-id> <KEY...>     Remove variables
```

Values inject into the app container at the next deploy. See [Environment and secrets](/docs/app-env).

### Deploys

```text
shis status <app-id> [--commit <full-sha>] [--json]
shis history <app-id> [--json]
shis logs <app-id>
shis rollback <app-id> [--yes]
shis redeploy <app-id> <full-sha>
shis image-load <app-id> <full-sha> <bytes>
shis deployment-mode <app-id> <build|prebuilt>
shis caddy-cutover <app-id>
shis caddy-refresh <app-id>
```

Rollback restores the one previous image kept for up to 12 hours and checks its health without building.

### Client handoff

```text
shis client-config <app-id> [--server-hostname <host>]
shis webhook-secret <app-id>
```

`client-config` prints commit-safe JSON. `webhook-secret` prints secret JSON only for explicit SSH handoff.

### Service commands

```text
shis check --config <path>
shis serve --config <path>
```

systemd runs `serve`. It skips npm update checks.
