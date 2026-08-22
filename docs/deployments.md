# Deployments

`bun ship` builds committed `HEAD` on your computer and uploads that exact image. Direct mode starts deployment over SSH. GitHub-push mode waits for the signed webhook.

## Client pipeline

1. Require a clean tree on the configured branch.
2. Fetch Git and reject a behind or diverged branch.
3. Run project tests and type checks.
4. Build from committed `HEAD` with `git archive`.
5. Build for the server's Linux platform with Docker layer cache.
6. Label the image with app ID, repository, full commit, Git tree, and platform.
7. Upload the commit-tagged image over SSH.
8. Push Git. If the commit is already remote, request a redeploy instead.
9. Start deployment directly or wait for its GitHub webhook.
10. Follow server status over SSH.

Upload happens before Git push, so the webhook cannot race a missing image. `bun ship --rebuild` disables cache without changing image identity.

## Request checks

The receiver checks route, method, content type, GitHub event, delivery UUID, and signature shape before reading the full body. It then enforces body size, verifies the HMAC, parses the payload, and matches repository, branch, and commit SHA.

The receiver acknowledges a duplicate verified delivery without deploying it again. Each app runs one deploy at a time. One newer push can wait in a persistent slot; a later push replaces the queued commit. Queue state survives service restart.

## Server pipeline

1. Check free memory and disk space.
2. Require a clean managed checkout.
3. Fetch the configured branch and verify the webhook SHA.
4. Resolve the Git tree independently.
5. Validate Compose config.
6. Verify the uploaded tag, app ID, repository, commit, Git tree, and platform.
7. Run optional app tests in a temporary container.
8. Record the running image.
9. Start the replacement with `--no-build` and check its loopback health endpoint.
10. Keep the active image and one rollback image for up to 12 hours. Remove legacy, superseded, and dangling image data.

The current app keeps running through validation and optional tests. Replacement starts only after those steps pass.

## Runtime metadata

Every app service gets two environment variables:

- `SHIBUMI_COMMIT`: full commit SHA for the running image
- `SHIBUMI_DEPLOYED_AT`: ISO 8601 deployment timestamp

Rollback updates `SHIBUMI_COMMIT` to the restored image's commit. Apps can expose these values from a version or health endpoint; apps that ignore them need no changes.

## Failed replacement

If startup or health fails, Shibumi retags the previous image under the Compose image name, starts it again without building, and checks its health. The attempted deploy remains failed in status and history.

## Resource defaults

- Prebuilt available memory: 512 MiB
- Server-build available memory: 2 GiB
- Free disk: 4 GiB
- Server-build deadline: 10 minutes
- Kept images: active image plus one rollback image for up to 12 hours

Local builds keep image construction away from production CPU and memory. systemd limits the receiver and any server build. Set per-app resource limits in Compose.
