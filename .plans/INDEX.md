# Plans

## Active

- [ ] Add protected-branch PR flow: detect protection before build, open/reuse PR, preserve exact merged-SHA deployment.
- [ ] Bootstrap owned clients to ship v27: Vibetoolbox v22, MCPVault v24. Remove MCPVault root `bun.lock` in same PR.
- [ ] Exercise v27 automatic update end to end from one committed older client.

## Planned

- [ ] Let signed prebuilt webhooks wait bounded time for exact image instead of failing while protected-branch merge image arrives.
- [ ] Move `shibumistack.dev` from legacy VPS builds to Shibumi prebuilt deployment.
- [ ] Record image digest in deployment status and history.

## Recently shipped

- [x] Add standalone `server.shibumistack.dev` static site, docs, Markdown agent versions, Dockerfile, Compose, and Bun dev server.
- [x] Show app health in `shis list`.
- [x] Limit deploy images to short-lived rollback.
- [x] Migrate existing Caddy retry budgets safely.
- [x] Reinstall Caddy helper when retry budget changes.
