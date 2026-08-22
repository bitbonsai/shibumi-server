# History and rollback

Shibumi records verified deploys and keeps one previous image for rollback.

## Recent history

```sh
shis history example-com
```

Machine-readable form:

```sh
shis history example-com --json
```

Each app keeps its latest 100 records in mode-`0600` JSONL. Records include time, app ID, full commit, operation, result, verified delivery ID, failed stage, and duration.

History never stores webhook payloads, signatures, secrets, or request headers.

## Restore the previous image

```sh
shis rollback example-com
```

Shibumi takes the previous image retained for up to 12 hours, retags it under the Compose image name, starts it without building, and checks its health. After success, the replaced image becomes the next rollback image. If startup or health fails, Shibumi restores the current image.

For confirmed automation:

```sh
shis rollback example-com --yes
```

The receiver pauses during rollback and restarts afterward, so a webhook deploy cannot run at the same time.
