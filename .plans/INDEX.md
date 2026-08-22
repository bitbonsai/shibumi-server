# Plans

## Active

- [ ] Add protected-branch PR flow: detect protection before build, open/reuse PR, preserve exact merged-SHA deployment.
- [ ] Bootstrap owned clients to current reviewed Ship client: Vibetoolbox v22, MCPVault v24. Remove MCPVault root `bun.lock` in same PR.
- [ ] Exercise automatic Ship client update end to end from one committed older client.

## Planned

- [ ] Let signed prebuilt webhooks wait bounded time for exact image instead of failing while protected-branch merge image arrives.
- [ ] Move `shibumistack.dev` from legacy VPS builds to Shibumi prebuilt deployment.
- [ ] Record image digest in deployment status and history.

## Recently shipped

- [x] Standardize website build, generated apps, and integration fixture on `oven/bun:alpine`; smoke-test ARM64 and AMD64 `/healthz`.
- [x] Rewrite standalone website docs around current Ship workflow and fix initial theme icon state.
- [x] Adopt shared `shibumi.css` and retell homepage as one deployment story.
- [x] Register and deploy `server.shibumistack.dev` through Shibumi.
- [x] Update project Ship client to reviewed v41 with Clack 0.7/1.x support.
