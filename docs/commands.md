# shis commands

Installed command is `shis`. `shibumi-server` remains an alias.

## Setup

```text
shis                              Guided installation
shis setup                        Guided installation
shis init                         Install only, for automation
shis update                       Install latest stable release
shis uninstall [--purge] [--yes]
```

## Apps

```text
shis list
shis add <domain> [--dry-run]
shis remove <domain|app-id> [--yes]
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

## Deploys

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

## Client handoff

```text
shis client-config <app-id> [--server-hostname <host>]
shis webhook-secret <app-id>
```

`client-config` prints commit-safe JSON. `webhook-secret` prints secret JSON only for explicit SSH handoff.

## Service commands

```text
shis check --config <path>
shis serve --config <path>
```

systemd runs `serve`. It skips npm update checks.
