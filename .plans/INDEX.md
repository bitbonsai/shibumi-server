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

- [x] Publish `shibumi-server` 0.7.11 with strict app, repository, revision, source-tree, tag, and platform verification.
- [x] Add generic Compose identity labels and `bun ship --rebuild` in ship v24.
- [x] Remove stale exact local upload tags before cached builds in ship v25.
- [x] Add reviewed automatic ship-client updates after successful deployments in ship v27.
- [x] Benchmark same-commit server builds versus local prebuilt uploads in `docs/prebuilt-benchmark.md`.
