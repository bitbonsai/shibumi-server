# Prebuilt deployment pilots

Recorded 2026-08-17 for future release notes and blog research.

## Environment

- Build host: Apple Silicon Mac, Colima, Docker 29.2.1, `linux/arm64`
- Deploy host: Debian 12 ARM64 VPS, 4 GB RAM, 2 GB swap, rootless Podman
- Flow: test, build exact committed `HEAD`, upload image over SSH, push or redeploy Git commit, receive signed webhook, start with `--no-build`, check health, retain rollback image

No registry or CI builder was involved.

## Pilot A: full ship

| Measurement | Result |
|---|---:|
| Historical server-build estimate shown by ship client | 1m 59s |
| Observed prebuilt end-to-end ship | 45s |
| Server deployment, accepted through healthy and retained | 18.233s |
| Difference from historical estimate | 74s faster |
| Relative end-to-end speed | 2.64x faster |
| Time reduction | 62% |
| Image size reported by server | 241 MB |
| Health request after deployment | HTTP 200 in 160ms |
| Application container memory after deployment | 13.65 MB |
| VPS available memory after deployment | 2.0 GiB |
| VPS swap used after deployment | 22 MiB |
| Preflight memory floor | 512 MiB, previously 1792 MiB for this app |

Deployment log contained no build stage. Image verification, Compose validation, startup, health checking, rollback retention, and pruning still ran on server.

## Pilot B: same-commit comparison

Server-build and prebuilt deployments used the same exact commit. Both hosts had warm build caches. Memory was sampled from `/proc/meminfo` every 200ms during each server deployment.

| Measurement | Server build | Prebuilt |
|---|---:|---:|
| Server deployment history duration | 39.221s | 5.656s |
| Redeploy command through terminal state | 40.376s | 6.752s |
| Minimum VPS available memory | 1982.7 MiB | 2072.1 MiB |
| Maximum VPS swap used | 19.5 MiB | 20.0 MiB |
| Application container memory after deployment | 31.48 MB | 31.46 MB |

Prebuilt client work before remote deployment:

| Stage | Duration |
|---|---:|
| Warm local image build | 423ms |
| Image archive creation | 457ms |
| SSH upload and server validation | 7.825s |
| Build through verified upload | 8.705s |
| Build through completed deployment | 15.457s |

Image measurements:

- Docker image: 49,203,374 bytes (46.9 MiB)
- SSH archive: 49,226,752 bytes (46.9 MiB)
- Rootless Podman image: 131,616,643 bytes (125.5 MiB)
- Platform: `linux/arm64`
- Post-deployment health request: HTTP 200 in 145ms

Same-commit result:

- Server-controlled deployment was 6.93x faster.
- Full build, archive, upload, and deployment was 2.61x faster than server build.
- End-to-end time dropped by 24.919s, or 61.7%.
- Minimum available VPS memory stayed 89.4 MiB higher during prebuilt deployment.

## Caveats

These are pilot measurements, not a broad benchmark. Local and server build caches were warm. Pilot A baseline was a historical estimate rather than a same-commit run. Pilot B is a controlled same-commit comparison, but contains one measured run per mode. Network speed affects full-image SSH upload time. Memory sampling may miss spikes shorter than 200ms.

The useful result is not raw speed. Image construction moved off the 4 GB VPS, while the server kept verification, replacement, health, and rollback.
