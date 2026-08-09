# Podman integration test

The normal test suite uses fake command runners and never touches Git or Podman.
To exercise a real disposable checkout and rootless Podman deployment:

```bash
SHIBUMI_INTEGRATION=1 bun test test/integration.test.ts

# Hosts using the standalone podman-compose executable:
SHIBUMI_INTEGRATION=1 SHIBUMI_COMPOSE_COMMAND=podman-compose bun test test/integration.test.ts
```

The test creates a temporary Git remote and checkout, builds a small Bun image,
starts it on a random loopback port, verifies its health and response, then
removes the container and temporary files. Do not run it against a production
Compose project.
