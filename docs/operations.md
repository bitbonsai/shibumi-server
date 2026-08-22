# Server operations

## List apps

```sh
shis list
```

Shows domain, app ID, repository, loopback upstream, checkout, and Caddy ownership.

## Latest status

```sh
shis status example-com
```

Machine-readable status:

```sh
shis status example-com --commit <full-sha> --json
```

Status is the latest snapshot for one app. Use [history](/docs/history-rollback) for recent durable records.

## Update

```sh
shis update
```

User-run commands check npm with a short timeout and suggest an update when a newer stable release exists. Registry failures never block local work. Update installs the exact reported version, keeps config and secrets, moves the local release link, and reloads the service.

## Remove an app

```sh
shis remove example.com
```

Removes Shibumi config, webhook secret, deployment status, history, managed Caddy route, and app containers. Keeps checkout, volumes, images, and GitHub webhook. `--yes` skips confirmation; sudo still asks separately.

## Uninstall

```sh
shis uninstall
```

Asks for confirmation, then removes the service, launchers, and installed releases. Config, secrets, checkouts, containers, Caddy routes, and GitHub settings stay. Automation can pass `--yes`.

```sh
shis uninstall --purge
```

Purge asks a stronger confirmation and also removes config and webhook secrets. Automation must pass `--purge --yes` explicitly.

## Service logs

```sh
journalctl --user -u shibumi-server -f
```

Logs include deployment stages and results. They do not include raw webhook payloads or secrets.
