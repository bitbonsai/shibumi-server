# Install shibumi-server

Run the installer on the Linux account that will own your deployments.

## Requirements

- Linux
- Git
- Caddy
- rootless Podman
- Podman Compose through `podman compose` or `podman-compose`
- a systemd user session

The installer adds Bun if it is missing. On macOS or Windows, SSH into the Linux server first. Enter SSH and sudo passwords in your terminal, never on a website.

## Run the installer

```sh
curl -fsSL https://server.shibumistack.dev/install | bash
```

The installer checks the host before writing anything. It finds a working Compose command, installs one fixed npm release with its production lockfile, and disables lifecycle scripts. It adds both command names:

```text
~/.local/bin/shis
~/.local/bin/shibumi-server
```

The docs use `shis`. Existing scripts can keep using `shibumi-server`.

## Files on the server

```text
~/.config/shibumi-server/config.json
~/.config/shibumi-server/secrets.env
~/.config/systemd/user/shibumi-server.service
~/.local/share/shibumi-server/releases/<version>/
~/.local/share/shibumi-server/current
```

Config and secret files use mode `0600`. The service runs the installed release. It does not download a package when it starts.

## Check the install

```sh
shis --version
systemctl --user status shibumi-server
```

A new install has no apps. Continue with [Connect project](/docs/ship), or use [`shis add`](/docs/add-app) on the server.

## Update

`shis` checks npm for newer stable releases and suggests this command when one exists:

```sh
shis update
```

Update installs that exact version and reuses the existing setup. It keeps config, secrets, checkouts, and running apps. A slow or unavailable npm registry does not block other commands. `shis serve` never checks npm.
