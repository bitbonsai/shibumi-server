# Security model

Caddy owns the public endpoint. The webhook service listens on loopback. Deployment runs as an unprivileged user through rootless Podman.

## Webhook trust boundary

The receiver checks event and delivery headers, limits payload size, verifies `X-Hub-Signature-256`, and matches repository, branch, and commit SHA. Verified delivery UUIDs stay in a bounded 24-hour cache. Failed deliveries can be redelivered.

HMAC proves that GitHub sent the request. It does not stop large volumes of traffic. Rate-limit the webhook path in Caddy, a firewall, or an upstream provider.

## Secrets

Each app gets a random 32-byte webhook secret in a mode-`0600` server file. Client config excludes it. `webhook-secret` prints JSON only for the explicit SSH-to-GitHub handoff, so the client can keep the value in memory.

Do not commit webhook secrets, app keys, repository credentials, registry credentials, TLS keys, databases, backups, or raw payload logs.

## Caddy privileges

Interactive setup explains the privileged change before sudo receives the password. A root-owned helper accepts validated JSON over stdin, computes its own paths, backs up the source, writes atomically, validates the full config, reloads, and restores the backup on failure.

The helper does not accept arbitrary Caddy text, shell commands, file paths, or upstream hosts.

## Image trust boundary

Ship builds only committed `HEAD` and labels the image with app ID, repository, commit, Git tree, and platform. The server fetches the webhook commit, resolves its tree independently, and verifies labels, tag, and platform before starting Compose with `--no-build`.

## Resource isolation

Memory and disk floors stop deployment before it can exhaust the host. Client builds keep production CPU and memory available. Server builds have a deadline. systemd sets memory, swap, CPU, and process limits for the receiver and its children. Rootless Podman keeps app containers under the deployment user. Compose should set per-app limits and bind app ports to loopback.

## Remaining limits

The replay cache clears when the service restarts. GitHub commit statuses and external registry workflows are planned, not built.
