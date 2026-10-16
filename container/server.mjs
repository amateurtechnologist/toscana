import { createServer } from "node:http";
import {
  createGatewayConfig,
  DiscordGatewayClient,
  evaluateMessage,
  ForwardQueue,
  forwardMessage,
} from "./gateway.mjs";

const port = Number(process.env.PORT ?? 8080);
let gateway;
let startupError;

try {
  const config = createGatewayConfig();
  const queue = new ForwardQueue((message) => forwardMessage(message, config));
  gateway = new DiscordGatewayClient({
    config,
    onMessage(message) {
      const decision = evaluateMessage(message, config);
      if (!decision.forward) return;

      return queue
        .enqueue(message)
        .then(() => {
          console.log(
            JSON.stringify({
              event: "message_forwarded",
              message_id: message.id,
              source_channel_id: message.channel_id,
              target_channel_id: config.targetChannelId,
            }),
          );
        })
        .catch((error) => {
          console.error(
            JSON.stringify({
              event: "message_forward_failed",
              message_id: message.id,
              source_channel_id: message.channel_id,
              error: error instanceof Error ? error.message : String(error),
            }),
          );
        });
    },
  });
  gateway.start();
} catch (error) {
  startupError = error;
  console.error(
    JSON.stringify({
      event: "gateway_start_failed",
      error: error instanceof Error ? error.message : String(error),
    }),
  );
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://container");
  request.resume();

  const health = url.pathname === "/healthz";
  const payload = health
    ? {
        ok: !startupError && Boolean(gateway),
        service: "toscana-container",
        gateway: gateway?.status() ?? { state: "startup_failed" },
      }
    : {
        ok: true,
        service: "toscana-container",
        method: request.method,
        path: `${url.pathname}${url.search}`,
        gateway: request.headers["x-toscana-gateway"] ?? null,
      };

  response.statusCode = health && (!gateway || startupError) ? 503 : 200;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
});

server.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});

function shutdown() {
  gateway?.stop();
  server.close(() => process.exit(0));
}

process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);

server.listen(port, "0.0.0.0", () => {
  console.log(`toscana container listening on ${port}`);
});
