import { Container } from "@cloudflare/containers";
import { WorkerEntrypoint } from "cloudflare:workers";
import type {
  GatewayMiddlewareContext,
  GatewayMiddlewareNext,
} from "@cloudflare/zt-types";

const CONTAINER_INSTANCE = "gateway";
const CONTAINER_HEALTH_PATH = "/healthz";
const NO_BODY_STATUSES = new Set([204, 205, 304]);

export class ToscanaContainer extends Container<Cloudflare.Env> {
  defaultPort = 8080;
  sleepAfter = "1h";
  envVars: Record<string, string> = {
    NODE_ENV: "production",
    TOSCANA_SERVICE: "container",
  };

  constructor(ctx: DurableObjectState<{}>, env: Cloudflare.Env) {
    super(ctx, env);
    this.envVars = {
      NODE_ENV: "production",
      TOSCANA_SERVICE: "container",
      DISCORD_TOKEN: env.DISCORD_TOKEN,
      CATEGORY_A_ID: env.CATEGORY_A_ID,
      CATEGORY_A_FORWARD_CHANNEL_ID: env.CATEGORY_A_FORWARD_CHANNEL_ID,
      CATEGORY_B_ID: env.CATEGORY_B_ID,
      CATEGORY_B_FORWARD_CHANNEL_ID: env.CATEGORY_B_FORWARD_CHANNEL_ID,
      TOSCANA_BLACKLIST_CHANNEL_IDS: env.TOSCANA_BLACKLIST_CHANNEL_IDS ?? "",
      TOSCANA_BLACKLIST_GUILD_IDS: env.TOSCANA_BLACKLIST_GUILD_IDS ?? "",
    };
  }

  override onStart(): void {
    console.log(JSON.stringify({ event: "container_started" }));
  }

  override onStop(params: { exitCode?: number; reason?: string }): void {
    console.log(JSON.stringify({ event: "container_stopped", ...params }));
  }

  override onError(error: unknown): void {
    console.error(
      JSON.stringify({
        event: "container_error",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }

  override async onActivityExpired(): Promise<void> {
    // The container owns a long-lived outbound Gateway connection. Letting the
    // inactivity alarm stop it would create an event gap after the default
    // sleep timeout, so keep the single Gateway instance alive.
    this.renewActivityTimeout();
  }
}

function markGatewayRequest(request: Request): Request {
  const headers = new Headers(request.headers);
  headers.set("x-toscana-gateway", "cloudflare-one");
  return new Request(request, { headers });
}

function markGatewayResponse(request: Request, response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("x-toscana-gateway", "container");

  const noBody =
    request.method === "HEAD" || NO_BODY_STATUSES.has(response.status);

  return new Response(noBody ? null : response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function containerUnavailable(request: Request, error: unknown): Response {
  console.error(
    JSON.stringify({
      event: "container_request_failed",
      method: request.method,
      path: new URL(request.url).pathname,
      error: error instanceof Error ? error.message : String(error),
    }),
  );

  return Response.json(
    { error: "container_unavailable" },
    {
      status: 502,
      headers: { "cache-control": "no-store" },
    },
  );
}

async function forwardToContainer(
  request: Request,
  env: Cloudflare.Env,
): Promise<Response> {
  const container = env.TOSCANA_CONTAINER.getByName(CONTAINER_INSTANCE);
  return container.fetch(markGatewayRequest(request));
}

async function wakeContainer(env: Cloudflare.Env): Promise<void> {
  const request = new Request(`https://toscana.internal${CONTAINER_HEALTH_PATH}`);
  const response = await forwardToContainer(request, env);
  const body = await response.text();
  let health: { gateway?: { state?: string } } = {};

  try {
    health = JSON.parse(body) as { gateway?: { state?: string } };
  } catch {
    // Preserve the status in the log even if the container returned a non-JSON body.
  }

  const event = {
    event: "container_wakeup",
    status: response.status,
    gateway_state: health.gateway?.state ?? "unknown",
  };

  if (response.ok) {
    console.log(JSON.stringify(event));
  } else {
    console.error(JSON.stringify(event));
  }
}

/**
 * Entry point selected by a Cloudflare One Gateway Forward policy.
 *
 * `next()` is intentionally not called: it preserves the original upstream
 * destination, while this Worker replaces that destination with the
 * Container Durable Object binding.
 */
export class GatewayMiddleware extends WorkerEntrypoint<Cloudflare.Env> {
  async handle(
    request: Request,
    _context: GatewayMiddlewareContext,
    _next: GatewayMiddlewareNext,
  ): Promise<Response> {
    try {
      const response = await forwardToContainer(request, this.env);
      return markGatewayResponse(request, response);
    } catch (error) {
      return containerUnavailable(request, error);
    }
  }
}

export default {
  async fetch(request: Request, env: Cloudflare.Env): Promise<Response> {
    try {
      const response = await forwardToContainer(request, env);
      return markGatewayResponse(request, response);
    } catch (error) {
      return containerUnavailable(request, error);
    }
  },

  async scheduled(
    _controller: ScheduledController,
    env: Cloudflare.Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(
      wakeContainer(env).catch((error) => {
        console.error(
          JSON.stringify({
            event: "container_wakeup_failed",
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }),
    );
  },
} satisfies ExportedHandler<Cloudflare.Env>;
