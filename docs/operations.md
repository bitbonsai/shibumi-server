# Server operations

## List apps

```sh
shis list
```

Shows domain, app ID, repository, loopback upstream, checkout, Caddy ownership, and current health result for every app.

## Latest status

```sh
shis status example-com
```

Machine-readable status:

```sh
shis status example-com --commit <full-sha> --json
```

Status is the latest snapshot for one app. [History](/docs/history-rollback) keeps the latest 100 durable records.

## App environment

```sh
printf 'RESEND_API_KEY=re_xxx\n' | shis env set example-com
shis env list example-com
```

Per-app values injected at deploy. Values arrive on stdin and are stored in a mode-`0600` file; `list` prints names only. Details in [Environment and secrets](/docs/app-env).

## Update

```sh
shis update
```

User-run commands check npm with a short timeout and suggest an update when a newer stable release exists. Registry failures do not block the command. Update installs the reported version, keeps config and secrets, moves the local release link, and reloads the service.

## Remove an app

```sh
shis remove example.com
```

Removes Shibumi config, webhook secret, deployment status, history, managed Caddy route, and app containers. Keeps checkout, volumes, images, and GitHub webhook, and the outro states exactly what stayed. `--yes` skips confirmation; sudo still asks separately. Re-registering the same domain under a different repository reuses that checkout, so delete it first if you mean to start clean; use [`shis set-repository`](#repoint-an-apps-repository) when you don't.

## Repoint an app's repository

```sh
shis set-repository example.com github:owner/new-repository
```

Moves the app's existing checkout to `<checkout>.bak`, clones the new repository in its place, and updates the registration, all without touching Caddy or re-registering the app. Confirms first; `--yes` skips the prompt. Refuses only when `<checkout>.bak` already exists, since that's the one case Shibumi won't overwrite silently.

`shis add` offers the same move when it finds an existing checkout whose Git origin doesn't match the repository you're adding.

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
