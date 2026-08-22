FROM docker.io/oven/bun:1.4.0-alpine AS build
WORKDIR /app
COPY package.json README.md ./
COPY scripts/build-site.ts ./scripts/build-site.ts
COPY site ./site
COPY docs ./docs
RUN bun scripts/build-site.ts

FROM docker.io/library/busybox:1.37-musl AS busybox
FROM scratch
COPY --from=busybox /bin/busybox /busybox
COPY --from=build --chown=65534:65534 /app/dist /www
USER 65534:65534
EXPOSE 9100
ENTRYPOINT ["/busybox", "httpd", "-f", "-p", "9100", "-h", "/www", "-c", "/www/httpd.conf"]
