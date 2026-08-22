# Add an app from the server

Use this path for server-side setup or automation. For normal app setup, start from the [local project](/docs/ship). Ship runs this registration over SSH and configures deployment afterward.

## Before you start

The repository needs a Compose file and a service with a loopback health endpoint. Point the domain at the server, directly or through Cloudflare. For a proxied Cloudflare record, use **Full (strict)** SSL/TLS mode so Cloudflare verifies Caddy's origin certificate.

## Preview without changing the server

```sh
shis add example.com --dry-run
```

Dry run follows the normal setup path: DNS and Caddy checks, prompts, port selection, and checkout validation. It does not write config or secrets, run sudo, or change Caddy or systemd.

## Register the app

```sh
shis add example.com
```

Setup asks for the repository and checkout. It picks the first free port above `9000` and shows the Caddy change before applying it. It can clone public repositories.

For a private repository, give the deployment user non-interactive read access. GitHub CLI can set up HTTPS credentials:

```sh
gh auth login
gh auth setup-git
git ls-remote https://github.com/owner/private-repo.git
```

Run those commands as the same user that runs `shibumi-server`. A read-only SSH deploy key also works. Registration will fail until `git ls-remote` works without a prompt.

If Caddy already serves the domain, Shibumi leaves that upstream in place. It adds only the webhook route. You choose when to switch traffic after the first healthy deploy.

## Automation

```sh
shis add example.com \
  --repository github:owner/repository \
  --checkout /home/deploy/shibumi/example-com \
  --port 9100
```

A GitHub tree URL selects its branch:

```sh
shis add staging.example.com \
  --repository https://github.com/owner/repository/tree/shibumi \
  --checkout /home/deploy/shibumi/staging-example-com \
  --port 9101
```

The equivalent explicit option is `--repository github:owner/repository --ref refs/heads/shibumi`. Domain and branch names do not have to match. Each domain accepts webhooks only for its configured branch.

You can also set the Compose file, Compose command, service, and health path. Put an app-owned test command after `--`:

```sh
shis add example.com \
  --repository github:owner/repository \
  --checkout /home/deploy/shibumi/example-com \
  --port 9100 \
  -- bun test
```

Shibumi passes test arguments directly to the container. It does not build a shell command from them.

## Running setup again

Running the same registration again keeps the checkout, webhook secret, and Caddy config, then restarts the service. Conflicting settings fail instead of overwriting the app.
