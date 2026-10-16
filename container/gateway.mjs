const DefaultWebSocket = globalThis.WebSocket;

export const DISCORD_API = "https://discord.com/api/v10";
export const DISCORD_GATEWAY_VERSION = 10;
export const THREAD_CHANNEL_TYPES = new Set([10, 11, 12]);
export const FORWARDABLE_MESSAGE_TYPES = new Set([0, 19, 20, 23]);

const GUILDS_INTENT = 1 << 0;
const GUILD_MESSAGES_INTENT = 1 << 9;
const MESSAGE_CONTENT_INTENT = 1 << 15;

export const GATEWAY_INTENTS =
  GUILDS_INTENT | GUILD_MESSAGES_INTENT | MESSAGE_CONTENT_INTENT;

const FATAL_CLOSE_CODES = new Set([4003, 4004, 4005, 4010, 4011, 4012, 4013, 4014]);
const RESET_SESSION_CLOSE_CODES = new Set([1000, 1001, 4007, 4009]);
const MAX_RECONNECT_DELAY_MS = 30_000;
const MAX_FORWARD_RETRIES = 3;

function isSnowflake(value) {
  return typeof value === "string" && /^\d+$/.test(value);
}

export function parseSnowflakeList(value) {
  return new Set(
    String(value ?? "")
      .split(/[\s,]+/)
      .map((item) => item.trim())
      .filter(isSnowflake),
  );
}

export function createGatewayConfig(env = process.env) {
  const token = env.DISCORD_TOKEN?.trim();
  const targetChannelId = env.TOSCANA_FORWARD_CHANNEL_ID?.trim();

  if (!token) {
    throw new Error("DISCORD_TOKEN is required");
  }
  if (!isSnowflake(targetChannelId)) {
    throw new Error("TOSCANA_FORWARD_CHANNEL_ID must be a Discord channel ID");
  }

  return {
    token,
    targetChannelId,
    blacklistedChannelIds: parseSnowflakeList(env.TOSCANA_BLACKLIST_CHANNEL_IDS),
    blacklistedGuildIds: parseSnowflakeList(env.TOSCANA_BLACKLIST_GUILD_IDS),
    gatewayUrl: env.TOSCANA_GATEWAY_URL?.trim() || undefined,
    intents: GATEWAY_INTENTS,
  };
}

export function evaluateMessage(message, config) {
  if (!message || typeof message !== "object") {
    return { forward: false, reason: "invalid_message" };
  }
  if (!isSnowflake(message.id) || !isSnowflake(message.channel_id)) {
    return { forward: false, reason: "invalid_message_location" };
  }
  if (!THREAD_CHANNEL_TYPES.has(Number(message.channel_type))) {
    return { forward: false, reason: "not_a_thread" };
  }
  if (config.blacklistedChannelIds.has(message.channel_id)) {
    return { forward: false, reason: "blacklisted_channel" };
  }
  if (message.guild_id && config.blacklistedGuildIds.has(message.guild_id)) {
    return { forward: false, reason: "blacklisted_guild" };
  }
  if (message.channel_id === config.targetChannelId) {
    return { forward: false, reason: "target_channel" };
  }
  if (message.author?.bot) {
    return { forward: false, reason: "bot_message" };
  }
  if (
    message.type !== undefined &&
    !FORWARDABLE_MESSAGE_TYPES.has(Number(message.type))
  ) {
    return { forward: false, reason: "unsupported_message_type" };
  }
  return { forward: true, reason: "thread_message" };
}

export function createForwardPayload(message) {
  if (!isSnowflake(message?.id) || !isSnowflake(message?.channel_id)) {
    throw new Error("A message ID and channel ID are required for forwarding");
  }

  return {
    allowed_mentions: { parse: [] },
    message_reference: {
      type: 1,
      channel_id: message.channel_id,
      message_id: message.id,
      fail_if_not_exists: true,
    },
  };
}

export class DiscordApiError extends Error {
  constructor(status, data) {
    const detail = typeof data?.message === "string" ? `: ${data.message}` : "";
    super(`Discord API returned ${status}${detail}`);
    this.name = "DiscordApiError";
    this.status = status;
    this.data = data;
  }
}

async function responseData(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function retryAfterMs(response, data) {
  const value = Number(
    data?.retry_after ?? response.headers.get("retry-after") ?? 1,
  );
  if (!Number.isFinite(value) || value < 0) return 1000;
  return Math.min(Math.max(value * 1000, 50), 15_000);
}

export async function forwardMessage(
  message,
  config,
  {
    fetchImpl = fetch,
    sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    maxRetries = MAX_FORWARD_RETRIES,
  } = {},
) {
  const payload = createForwardPayload(message);

  for (let attempt = 0; ; attempt += 1) {
    const response = await fetchImpl(
      `${DISCORD_API}/channels/${config.targetChannelId}/messages`,
      {
        method: "POST",
        headers: {
          authorization: `Bot ${config.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
      },
    );
    const data = await responseData(response);

    if (response.ok) return data;

    const error = new DiscordApiError(response.status, data);
    if (response.status !== 429 || attempt >= maxRetries) throw error;
    await sleep(retryAfterMs(response, data));
  }
}

export class ForwardQueue {
  constructor(send) {
    this.send = send;
    this.tail = Promise.resolve();
  }

  enqueue(message) {
    const result = this.tail.then(() => this.send(message));
    this.tail = result.catch(() => undefined);
    return result;
  }
}

function gatewayUrlWithParams(url) {
  const parsed = new URL(url);
  parsed.searchParams.set("v", String(DISCORD_GATEWAY_VERSION));
  parsed.searchParams.set("encoding", "json");
  parsed.searchParams.delete("compress");
  return parsed.toString();
}

function websocketIsOpen(socket) {
  return socket?.readyState === 1;
}

function bindSocketEvent(socket, eventName, handler) {
  if (typeof socket.on === "function") {
    socket.on(eventName, handler);
    return;
  }
  if (typeof socket.addEventListener === "function") {
    socket.addEventListener(eventName, (event) => {
      if (eventName === "message") {
        handler(event.data);
      } else if (eventName === "close") {
        handler(event.code, event.reason);
      } else {
        handler(event);
      }
    });
    return;
  }
  throw new Error("WebSocket implementation has no event API");
}

function closeSocket(socket, code, reason) {
  if (!socket) return;
  if (typeof socket.terminate === "function") {
    socket.terminate();
    return;
  }
  if (typeof socket.close === "function") {
    try {
      socket.close(code, reason);
    } catch {
      socket.close();
    }
  }
}

function messageText(data) {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return String(data);
}

export class DiscordGatewayClient {
  constructor({
    config,
    onMessage,
    fetchImpl = fetch,
    WebSocketImpl = DefaultWebSocket,
    logger = console,
    random = Math.random,
  }) {
    this.config = config;
    this.onMessage = onMessage;
    this.fetchImpl = fetchImpl;
    this.WebSocketImpl = WebSocketImpl;
    this.logger = logger;
    this.random = random;
    this.socket = null;
    this.baseGatewayUrl = config.gatewayUrl;
    this.resumeGatewayUrl = undefined;
    this.sessionId = undefined;
    this.sequence = null;
    this.userId = undefined;
    this.heartbeatStartTimer = null;
    this.heartbeatTimer = null;
    this.awaitingHeartbeatAck = false;
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
    this.nextResume = false;
    this.running = false;
    this.state = "stopped";
    this.lastEventAt = null;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.state = "starting";
    void this.openSocket(false);
  }

  stop() {
    this.running = false;
    this.state = "stopped";
    this.clearHeartbeat();
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket) {
      if (typeof this.socket.removeAllListeners === "function") {
        this.socket.removeAllListeners();
      }
      closeSocket(this.socket, 1000, "shutdown");
      this.socket = null;
    }
  }

  status() {
    return {
      state: this.state,
      session: Boolean(this.sessionId),
      sequence: this.sequence,
      reconnect_attempt: this.reconnectAttempt,
      last_event_at: this.lastEventAt,
    };
  }

  async getBaseGatewayUrl() {
    if (this.baseGatewayUrl) return this.baseGatewayUrl;

    const response = await this.fetchImpl(`${DISCORD_API}/gateway/bot`, {
      headers: { authorization: `Bot ${this.config.token}` },
    });
    const data = await responseData(response);
    if (!response.ok || typeof data?.url !== "string") {
      throw new DiscordApiError(response.status, data);
    }

    this.baseGatewayUrl = data.url;
    return data.url;
  }

  async openSocket(resume) {
    if (!this.running) return;

    const shouldResume = Boolean(resume && this.sessionId);
    this.state = shouldResume ? "resuming" : "connecting";

    try {
      const target = shouldResume
        ? this.resumeGatewayUrl ?? (await this.getBaseGatewayUrl())
        : await this.getBaseGatewayUrl();
      if (!this.running) return;
      if (typeof this.WebSocketImpl !== "function") {
        throw new Error("Node WebSocket is unavailable");
      }

      const socket = new this.WebSocketImpl(gatewayUrlWithParams(target));
      this.socket = socket;
      this.connectMode = shouldResume ? "resume" : "identify";

      bindSocketEvent(socket, "open", () => {
        this.logger.info(JSON.stringify({ event: "gateway_socket_open" }));
      });
      bindSocketEvent(socket, "message", (data) => {
        void this.handleMessage(data).catch((error) => {
          this.logger.error(
            JSON.stringify({
              event: "gateway_message_failed",
              error: error instanceof Error ? error.message : String(error),
            }),
          );
        });
      });
      bindSocketEvent(socket, "error", (error) => {
        this.logger.error(
          JSON.stringify({
            event: "gateway_socket_error",
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      });
      bindSocketEvent(socket, "close", (code, reason) => {
        this.handleClose(socket, code, reason);
      });
    } catch (error) {
      this.logger.error(
        JSON.stringify({
          event: "gateway_connect_failed",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      this.scheduleReconnect(shouldResume);
    }
  }

  async handleMessage(raw) {
    let packet;
    try {
      packet = JSON.parse(messageText(raw));
    } catch (error) {
      this.logger.error(
        JSON.stringify({
          event: "gateway_decode_failed",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      return;
    }

    this.lastEventAt = new Date().toISOString();
    if (packet.s !== null && packet.s !== undefined) {
      this.sequence = packet.s;
    }

    switch (packet.op) {
      case 0:
        await this.handleDispatch(packet.t, packet.d);
        break;
      case 1:
        this.sendHeartbeat();
        break;
      case 7:
        this.requestReconnect(true, "gateway_reconnect");
        break;
      case 9:
        if (!packet.d) this.clearSession();
        this.requestReconnect(Boolean(packet.d), "invalid_session");
        break;
      case 10:
        this.startHeartbeat(packet.d?.heartbeat_interval);
        this.sendIdentifyOrResume();
        break;
      case 11:
        this.awaitingHeartbeatAck = false;
        break;
      default:
        break;
    }
  }

  async handleDispatch(event, data) {
    if (event === "READY") {
      this.sessionId = data?.session_id;
      this.resumeGatewayUrl = data?.resume_gateway_url ?? this.baseGatewayUrl;
      this.userId = data?.user?.id;
      this.reconnectAttempt = 0;
      this.state = "connected";
      this.logger.info(
        JSON.stringify({
          event: "gateway_ready",
          guilds: Array.isArray(data?.guilds) ? data.guilds.length : undefined,
        }),
      );
      return;
    }

    if (event === "RESUMED") {
      this.reconnectAttempt = 0;
      this.state = "connected";
      this.logger.info(JSON.stringify({ event: "gateway_resumed" }));
      return;
    }

    if (event === "MESSAGE_CREATE" && data?.author?.id !== this.userId) {
      try {
        await this.onMessage(data);
      } catch (error) {
        this.logger.error(
          JSON.stringify({
            event: "message_handler_failed",
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    }
  }

  sendIdentifyOrResume() {
    if (this.connectMode === "resume" && this.sessionId) {
      this.send({
        op: 6,
        d: {
          token: this.config.token,
          session_id: this.sessionId,
          seq: this.sequence,
        },
      });
      return;
    }

    this.send({
      op: 2,
      d: {
          token: this.config.token,
          intents: this.config.intents,
          properties: {
            os: "linux",
            browser: "toscana",
            device: "toscana",
          },
      },
    });
  }

  sendHeartbeat() {
    if (!websocketIsOpen(this.socket)) return;
    if (this.awaitingHeartbeatAck) {
      this.logger.warn(JSON.stringify({ event: "gateway_heartbeat_timeout" }));
      closeSocket(this.socket, 4000, "heartbeat timeout");
      return;
    }
    this.awaitingHeartbeatAck = true;
    this.send({ op: 1, d: this.sequence });
  }

  startHeartbeat(interval) {
    const heartbeatInterval = Number(interval);
    if (!Number.isFinite(heartbeatInterval) || heartbeatInterval <= 0) {
      throw new Error("Gateway Hello did not include a valid heartbeat interval");
    }

    this.clearHeartbeat();
    this.heartbeatStartTimer = setTimeout(() => {
      this.sendHeartbeat();
      this.heartbeatTimer = setInterval(
        () => this.sendHeartbeat(),
        heartbeatInterval,
      );
    }, Math.floor(this.random() * heartbeatInterval));
  }

  clearHeartbeat() {
    if (this.heartbeatStartTimer !== null) {
      clearTimeout(this.heartbeatStartTimer);
      this.heartbeatStartTimer = null;
    }
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.awaitingHeartbeatAck = false;
  }

  send(payload) {
    if (!websocketIsOpen(this.socket)) return false;
    this.socket.send(JSON.stringify(payload));
    return true;
  }

  requestReconnect(resume, reason) {
    if (!this.running) return;
    this.nextResume = Boolean(resume && this.sessionId);
    this.scheduleReconnect(this.nextResume, reason);
    closeSocket(this.socket, 4000, "reconnect");
  }

  handleClose(socket, code, reason) {
    if (socket !== this.socket) return;
    this.socket = null;
    this.clearHeartbeat();

    if (!this.running) return;

    if (FATAL_CLOSE_CODES.has(code)) {
      this.state = "blocked";
      this.running = false;
      this.logger.error(
        JSON.stringify({
          event: "gateway_blocked",
          code,
          reason: messageText(reason),
        }),
      );
      return;
    }

    if (RESET_SESSION_CLOSE_CODES.has(code)) this.clearSession();
    this.scheduleReconnect(Boolean(this.sessionId), `close_${code}`);
  }

  clearSession() {
    this.sessionId = undefined;
    this.resumeGatewayUrl = undefined;
    this.sequence = null;
    this.userId = undefined;
    this.nextResume = false;
  }

  scheduleReconnect(resume, reason) {
    if (!this.running || this.reconnectTimer !== null) return;

    const attempt = this.reconnectAttempt;
    const delay = Math.min(
      MAX_RECONNECT_DELAY_MS,
      1000 * 2 ** Math.min(attempt, 5),
    );
    this.reconnectAttempt += 1;
    this.nextResume = Boolean(resume && this.sessionId);
    this.state = "backoff";
    this.logger.warn(
      JSON.stringify({
        event: "gateway_reconnect_scheduled",
        delay_ms: delay,
        resume: this.nextResume,
        reason,
      }),
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.openSocket(this.nextResume);
    }, delay);
  }
}
