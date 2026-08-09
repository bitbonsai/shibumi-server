const server = Bun.serve({
  hostname: "0.0.0.0",
  port: 3000,
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/healthz") return new Response("ok");
    return new Response("shibumi integration fixture");
  },
});

process.on("SIGTERM", () => {
  server.stop(true);
  process.exit(0);
});
