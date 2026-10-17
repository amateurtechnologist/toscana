import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import type {
  GatewayMiddlewareContext,
  GatewayMiddlewareNext,
} from "@cloudflare/zt-types";

const CONTAINER_INSTANCE = "gateway";
const CONTAINER_PORT = 8080;
const CONTAINER_HEALTH_PATH = "/healthz";
const CONTAINER_INACTIVITY_TIMEOUT_MS = 15 * 60 * 1000;
const CONTAINER_READY_TIMEOUT_MS = 30 * 1000;
const CONTAINER_READY_POLL_MS = 200;
const CONTAINER_RECOVERY_DELAY_MS = 30 * 1000;
const NO_BODY_STATUSES = new Set([204, 205, 304]);

function logError(event: string, error: unknown, extra = {}) {
  console.error(
    JSON.stringify({
      event,
      ...extra,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
}

function containerEnvironment(env: Cloudflare.Env): Record<string, string> {
  return {
    NODE_ENV: "production",
    TOSCANA_SERVICE: "container",
    DISCORD_TOKEN: env.DISCORD_TOKEN,
    CATEGORY_A_ID: env.CATEGORY_A_ID,
    CATEGORY_A_FORWARD_CHANNEL_ID: env.CATEGORY_A_FORWARD_CHANNEL_ID,
    CATEGORY_B_ID: env.CATEGORY_B_ID,
    CATEGORY_B_FORWARD_CHANNEL_ID: env.CATEGORY_B_FORWARD_CHANNEL_ID,
  };
}

export class ToscanaContainer extends DurableObject<Cloudflare.Env> {
  private starting: Promise<void> | undefined;
  private monitoring: Promise<void> | undefined;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);

    const container = ctx.container;
    if (container?.running) {
      void ctx
        .blockConcurrencyWhile(async () => {
          await container.setInactivityTimeout(
            CONTAINER_INACTIVITY_TIMEOUT_MS,
          );
          this.observeExit();
        })
        .catch((error) => logError("container_restore_failed", error));
    }
  }

  async fetch(request: Request): Promise<Response> {
    try {
      await this.ensureReady();

      const url = new URL(request.url);
      url.protocol = "http:";
      url.host = "container";
      const forwarded = new Request(url, request);
      forwarded.headers.delete("host");

      return await this.ctx.container!.getTcpPort(CONTAINER_PORT).fetch(
        forwarded,
      );
    } catch (error) {
      logError("container_request_failed", error, {
        method: request.method,
        path: new URL(request.url).pathname,
      });
      return Response.json(
        { error: "container_unavailable" },
        {
          status: 502,
          headers: { "cache-control": "no-store" },
        },
      );
    }
  }

  async alarm(): Promise<void> {
    try {
      await this.ensureReady();
    } catch (error) {
      logError("container_recovery_failed", error);
      await this.scheduleRecovery();
    }
  }

  private async ensureReady(): Promise<void> {
    this.starting ??= this.startAndWaitForPort().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private async startAndWaitForPort(): Promise<void> {
    const container = this.ctx.container;
    if (!container) {
      throw new Error("No container is configured for this Durable Object");
    }

    if (!container.running) {
      container.start({
        enableInternet: true,
        env: containerEnvironment(this.env),
      });
      console.log(
        JSON.stringify({
          event: "container_start_requested",
          instance: CONTAINER_INSTANCE,
        }),
      );
    }

    this.observeExit();
    await container.setInactivityTimeout(CONTAINER_INACTIVITY_TIMEOUT_MS);

    const port = container.getTcpPort(CONTAINER_PORT);
    const deadline = Date.now() + CONTAINER_READY_TIMEOUT_MS;
    let lastError: unknown;

    while (Date.now() < deadline) {
      try {
        const response = await port.fetch(
          `http://container${CONTAINER_HEALTH_PATH}`,
          { signal: AbortSignal.timeout(1000) },
        );
        await response.body?.cancel();
        if (!response.ok) {
          throw new Error(`Health check returned ${response.status}`);
        }

        console.log(
          JSON.stringify({
            event: "container_ready",
            instance: CONTAINER_INSTANCE,
          }),
        );
        return;
      } catch (error) {
        lastError = error;
        await scheduler.wait(CONTAINER_READY_POLL_MS);
      }
    }

    throw new Error("Container did not become ready", { cause: lastError });
  }

  private observeExit(): void {
    if (this.monitoring || !this.ctx.container) return;

    let monitor: Promise<void>;
    try {
      monitor = this.ctx.container.monitor();
    } catch (error) {
      logError("container_monitor_start_failed", error);
      return;
    }

    this.monitoring = monitor
      .then(() => {
        console.log(
          JSON.stringify({
            event: "container_stopped",
            instance: CONTAINER_INSTANCE,
          }),
        );
      })
      .catch(async (error) => {
        logError("container_exited_with_error", error, {
          instance: CONTAINER_INSTANCE,
        });
        await this.scheduleRecovery();
      })
      .finally(() => {
        this.monitoring = undefined;
      });

    this.ctx.waitUntil(this.monitoring);
  }

  private async scheduleRecovery(): Promise<void> {
    try {
      await this.ctx.storage.setAlarm(
        Date.now() + CONTAINER_RECOVERY_DELAY_MS,
      );
    } catch (error) {
      logError("container_recovery_schedule_failed", error);
    }
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
  logError("container_request_failed", error, {
    method: request.method,
    path: new URL(request.url).pathname,
  });

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
        logError("container_wakeup_failed", error);
      }),
    );
  },
} satisfies ExportedHandler<Cloudflare.Env>;
