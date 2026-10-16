import { createServer } from "node:http";

const port = Number(process.env.PORT ?? 8080);

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://container");
  request.resume();

  const health = url.pathname === "/healthz";
  const payload = health
    ? { ok: true, service: "toscana-container" }
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
  console.error(error);
  process.exitCode = 1;
});

server.listen(port, "0.0.0.0", () => {
  console.log(`toscana container listening on ${port}`);
});
