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

## Prepare a fresh VPS

Already have a hardened server with key-only SSH? Skip ahead.

<details>
<summary>First server? Rent, connect, and harden it step by step.</summary>

1. **Rent a VPS.** Any provider works (Hetzner, DigitalOcean, Vultr, a homelab box). 1 vCPU and 1 GB RAM run several small apps. Pick a current Debian or Ubuntu LTS image. If the provider asks for an SSH public key at creation, paste yours; that key becomes root's login.

2. **Create a local SSH key** if you have none:

   ```sh
   ssh-keygen -t ed25519
   ```

   The public half is `~/.ssh/id_ed25519.pub`. The private half never leaves your machine.

3. **Create the deployment user.** Log in as root once, then:

   ```sh
   adduser deploy
   usermod -aG sudo deploy
   ```

4. **Install your key for that user.** From your machine:

   ```sh
   ssh-copy-id deploy@<server-ip>
   ```

5. **Add an SSH alias** in `~/.ssh/config` on your machine. Better than an `/etc/hosts` entry: it also records the user and key, and Ship accepts the alias everywhere a target is asked.

   ```text
   Host myvps
     HostName <server-ip>
     User deploy
     IdentityFile ~/.ssh/id_ed25519
   ```

   Now `ssh myvps` must log in without a password. Fix that before continuing.

6. **Disable password and root login.** On the server, edit `/etc/ssh/sshd_config`:

   ```text
   PasswordAuthentication no
   PermitRootLogin no
   ```

   Then `sudo systemctl restart ssh`. Keep your current session open and confirm a second `ssh myvps` still works before closing it.

7. **Let user services survive logout.** The deploy service runs in a systemd user session:

   ```sh
   sudo loginctl enable-linger deploy
   ```

8. **Install the requirements.** On Debian or Ubuntu:

   ```sh
   sudo apt update
   sudo apt install -y git podman podman-compose
   ```

   Caddy comes from its own repository; follow the [official install steps](https://caddyserver.com/docs/install#debian-ubuntu-raspbian).

9. **Point DNS at the server.** An A record for your app domain to the server IP, DNS-only (no proxy), so Caddy can issue its own certificate.

</details>

## Run the installer

```sh
curl -fsSL https://server.shibumistack.dev/install | bash
```

The installer checks the host before writing anything. It finds a working Compose command, installs one exact npm version from its production lockfile, and disables lifecycle scripts. It adds both command names:

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

Update installs that exact version through the existing setup. Config, secrets, checkouts, and running apps stay in place. A slow or unavailable npm registry does not block other commands. `shis serve` never checks npm.
