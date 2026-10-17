import assert from "node:assert/strict";
import test from "node:test";

import {
  createForwardPayload,
  createExpandedPayload,
  createGatewayConfig,
  DiscordGatewayClient,
  evaluateMessage,
  matchesNonForwardPattern,
  ForwardQueue,
  forwardMessage,
  resolveMessageRoute,
} from "./gateway.mjs";

const config = {
  token: "test-token",
  routes: [
    { name: "A", categoryId: "111", targetChannelId: "999" },
    { name: "B", categoryId: "222", targetChannelId: "998" },
  ],
  routesByCategory: new Map([
    ["111", { name: "A", categoryId: "111", targetChannelId: "999" }],
    ["222", { name: "B", categoryId: "222", targetChannelId: "998" }],
  ]),
  targetChannelIds: new Set(["999", "998"]),
  intents: 33281,
};

function message(overrides = {}) {
  return {
    id: "123",
    channel_id: "456",
    channel_type: 11,
    guild_id: "789",
    type: 0,
    author: { id: "321", bot: false },
    ...overrides,
  };
}

test("createGatewayConfig requires the token and target channel", () => {
  assert.throws(
    () => createGatewayConfig({ DISCORD_TOKEN: "token" }),
    /CATEGORY_A_ID/,
  );
  const result = createGatewayConfig({
    DISCORD_TOKEN: "token",
    CATEGORY_A_ID: "100",
    CATEGORY_A_FORWARD_CHANNEL_ID: "123",
    CATEGORY_B_ID: "200",
    CATEGORY_B_FORWARD_CHANNEL_ID: "456",
  });
  assert.deepEqual(result.routes, [
    { name: "A", categoryId: "100", targetChannelId: "123" },
    { name: "B", categoryId: "200", targetChannelId: "456" },
  ]);
});

test("guild messages pass routing filters", () => {
  assert.deepEqual(evaluateMessage(message(), config), {
    forward: true,
    reason: "message_candidate",
  });
  assert.equal(evaluateMessage(message({ channel_type: 0 }), config).forward, true);
  assert.equal(evaluateMessage(message({ author: { id: "321", bot: true } }), config).reason, "bot_message");
  assert.equal(evaluateMessage(message({ channel_id: "999" }), config).reason, "target_channel");
  assert.equal(evaluateMessage(message({ type: 21 }), config).reason, "unsupported_message_type");
});

test("provided non-forward patterns suppress messages", () => {
  assert.equal(matchesNonForwardPattern("hello"), true);
  assert.equal(matchesNonForwardPattern("https://example.com"), false);
  assert.equal(matchesNonForwardPattern("https://a.test https://b.test"), false);
  assert.equal(matchesNonForwardPattern("https://a.test hello"), true);
  assert.equal(
    evaluateMessage(message({ content: "hello" }), config).reason,
    "content_filter",
  );
});

test("route resolution maps thread messages to their category target", async () => {
  const reads = [];
  const route = await resolveMessageRoute(message(), config, {
    fetchImpl: async (url) => {
      const path = new URL(url).pathname;
      reads.push(path);
      if (path === "/api/v10/channels/456") {
        return Response.json({
          id: "456", guild_id: "789", type: 11, parent_id: "555", name: "thread",
        });
      }
      if (path === "/api/v10/channels/555") {
        return Response.json({
          id: "555", guild_id: "789", type: 0, parent_id: "111", name: "source",
        });
      }
      throw new Error(`Unexpected request: ${path}`);
    },
  });
  assert.deepEqual(route, {
    forward: true,
    reason: "category_message",
    categoryId: "111",
    targetChannelId: "999",
    sourceName: "#source> 🧵thread",
  });
  assert.deepEqual(reads, [
    "/api/v10/channels/456",
    "/api/v10/channels/555",
  ]);
});

test("forward payload matches the Expand rendering and links the source", () => {
  const payload = createExpandedPayload(message(), {
    targetChannelId: "999",
    sourceName: "#source> 🧵thread",
  });
  assert.equal(payload.embeds[0].description, undefined);
  assert.equal(payload.embeds[0].footer.text, "#source> 🧵thread");
  assert.equal(payload.embeds[0].url, "https://discord.com/channels/789/456/123");
  assert.equal(payload.components[0].components[0].label, "元のメッセージを開く");
  assert.equal(payload.components[0].components[0].url, "https://discord.com/channels/789/456/123");
  assert.deepEqual(payload.allowed_mentions, { parse: [] });
});

test("createForwardPayload is the Expand-shaped payload", () => {
  assert.deepEqual(createForwardPayload(message(), {
    targetChannelId: "999",
    sourceName: "#source",
  }), createExpandedPayload(message(), {
    targetChannelId: "999",
    sourceName: "#source",
  }));
});

test("forwardMessage sends a single native forward request", async () => {
  const requests = [];
  const result = await forwardMessage(message(), config, {
    route: { targetChannelId: "999", sourceName: "#source" },
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return Response.json({ id: "forwarded" });
    },
  });

  assert.deepEqual(result, { id: "forwarded" });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://discord.com/api/v10/channels/999/messages");
  assert.equal(requests[0].init.headers.authorization, "Bot test-token");
  assert.deepEqual(JSON.parse(requests[0].init.body), createForwardPayload(message(), {
    targetChannelId: "999", sourceName: "#source",
  }));
});

test("forwardMessage retries Discord rate limits", async () => {
  let attempts = 0;
  const delays = [];
  const result = await forwardMessage(message(), config, {
    route: { targetChannelId: "999", sourceName: "#source" },
    sleep: async (delay) => delays.push(delay),
    fetchImpl: async () => {
      attempts += 1;
      return attempts === 1
        ? Response.json({ retry_after: 0.25 }, { status: 429 })
        : Response.json({ id: "forwarded" });
    },
  });
  assert.deepEqual(result, { id: "forwarded" });
  assert.equal(attempts, 2);
  assert.deepEqual(delays, [250]);
});

test("ForwardQueue preserves send order without storing thread state", async () => {
  const sent = [];
  const queue = new ForwardQueue(async (item) => {
    sent.push(item.id);
    return item.id;
  });
  const results = await Promise.all([
    queue.enqueue({ id: "1" }),
    queue.enqueue({ id: "2" }),
    queue.enqueue({ id: "3" }),
  ]);
  assert.deepEqual(sent, ["1", "2", "3"]);
  assert.deepEqual(results, ["1", "2", "3"]);
});

test("Gateway reports a blocked state when WebSocket support is unavailable", () => {
  const client = new DiscordGatewayClient({
    config,
    onMessage: async () => {},
    WebSocketImpl: null,
    logger: { info() {}, warn() {}, error() {} },
  });

  client.start();

  assert.deepEqual(client.status(), {
    state: "blocked",
    session: false,
    sequence: null,
    reconnect_attempt: 0,
    last_event_at: null,
    last_error: "Node WebSocket is unavailable",
    last_close: null,
  });
});
