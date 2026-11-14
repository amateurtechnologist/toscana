import { createServer } from "node:http";
const port = Number(process.env.PORT ?? 8080);
// Discord message forwarding is handled exclusively by agitat.ing BUMP.
const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://container");
  request.resume();

  const health = url.pathname === "/healthz";
  const payload = health
    ? {
        ok: true,
        service: "toscana-container",
        automatic_forwarding: false,
        gateway: { state: "disabled", reason: "bump_runs_in_agitat_ing" },
      }
    : {
        ok: true,
        service: "toscana-container",
        method: request.method,
        path: `${url.pathname}${url.search}`,
        gateway: request.headers["x-toscana-gateway"] ?? null,
      };

  response.statusCode = 200;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
});

server.on("error", (error) => {
  console.error(
    JSON.stringify({
      event: "http_server_failed",
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exit(1);
});

process.on("uncaughtException", (error) => {
  console.error(
    JSON.stringify({
      event: "uncaught_exception",
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exit(1);
});

process.on("unhandledRejection", (error) => {
  console.error(
    JSON.stringify({
      event: "unhandled_rejection",
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exit(1);
});

function shutdown() {
  server.close(() => process.exit(0));
}

process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);

server.listen(port, "0.0.0.0", () => {
  console.log(JSON.stringify({
    event: "toscana_container_listening", port: server.address().port, automatic_forwarding: false,
  }));
});

