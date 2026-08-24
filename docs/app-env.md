# Environment and secrets

Each app has one server-side environment store. Deploys inject its values into the app container. Values never live in the repository, the image, or `shibumi-server.json`.

## Set values from the project

```sh
bun ship:env set APP_ORIGIN=https://example.com ADMIN_EMAILS=you@example.com
bun ship:env import .env.production
bun ship:env list
bun ship:env rm OLD_KEY
```

`set` takes `KEY=VALUE` pairs. `import` reads a local `.env` file and sends its entries; the file itself stays local and uncommitted. `list` prints variable names only. Values are never printed after they are set.

Changes apply at the next deploy:

```sh
bun ship
```

## Set values on the server

```sh
printf 'RESEND_API_KEY=re_xxx\n' | shis env set example-com
shis env list example-com
shis env rm example-com OLD_KEY
```

`shis env set` reads `KEY=VALUE` lines from stdin, so values stay out of shell history and the process list. Input is capped at 1 MiB.

## Storage and injection

Values live in one file per app, `~/.config/shibumi-server/env/<app-id>.env`, mode `0600` in a mode-`0700` directory. Writes go through a temp file and rename, so a reader never sees a partial file.

At deploy, the server merges the store into the Compose override as literal environment values. The same injection runs on rollback and on the automatic restore after a failed health check, so a restored container keeps its configuration.

## Rules

- Keys match `[A-Z_][A-Z0-9_]*`.
- Values cannot contain newlines.
- `SHIBUMI_COMMIT` and `SHIBUMI_DEPLOYED_AT` are reserved. The server sets them at deploy and `env set` rejects them.
- `list` shows names, never values.

## What belongs here

App configuration and secrets read by the app at runtime: origins, admin allowlists, API keys. Compose-level settings such as ports and volumes stay in the committed `compose.yaml`. Webhook secrets have their own store; see the [security model](/docs/security).
