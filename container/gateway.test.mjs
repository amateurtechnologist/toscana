import assert from "node:assert/strict";
import test from "node:test";

import {
  createForwardPayload,
  createGatewayConfig,
  evaluateMessage,
  ForwardQueue,
  forwardMessage,
  parseSnowflakeList,
} from "./gateway.mjs";

const config = {
  token: "test-token",
  targetChannelId: "999",
  blacklistedChannelIds: new Set(["888"]),
  blacklistedGuildIds: new Set(["777"]),
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

test("parseSnowflakeList keeps only numeric IDs", () => {
  assert.deepEqual(
    [...parseSnowflakeList("100, 200\ninvalid 300")],
    ["100", "200", "300"],
  );
});

test("createGatewayConfig requires the token and target channel", () => {
  assert.throws(
    () => createGatewayConfig({ DISCORD_TOKEN: "token" }),
    /TOSCANA_FORWARD_CHANNEL_ID/,
  );
  const result = createGatewayConfig({
    DISCORD_TOKEN: "token",
    TOSCANA_FORWARD_CHANNEL_ID: "123",
    TOSCANA_BLACKLIST_CHANNEL_IDS: "456,789",
  });
  assert.equal(result.targetChannelId, "123");
  assert.deepEqual([...result.blacklistedChannelIds], ["456", "789"]);
});

test("only non-blacklisted thread messages are candidates", () => {
  assert.deepEqual(evaluateMessage(message(), config), {
    forward: true,
    reason: "thread_message",
  });
  assert.equal(evaluateMessage(message({ channel_type: 0 }), config).forward, false);
  assert.equal(evaluateMessage(message({ channel_id: "888" }), config).reason, "blacklisted_channel");
  assert.equal(evaluateMessage(message({ guild_id: "777" }), config).reason, "blacklisted_guild");
  assert.equal(evaluateMessage(message({ author: { id: "321", bot: true } }), config).reason, "bot_message");
  assert.equal(evaluateMessage(message({ channel_id: "999" }), config).reason, "target_channel");
  assert.equal(evaluateMessage(message({ type: 21 }), config).reason, "unsupported_message_type");
});

test("native Discord forward payload references the source message", () => {
  assert.deepEqual(createForwardPayload(message()), {
    allowed_mentions: { parse: [] },
    message_reference: {
      type: 1,
      channel_id: "456",
      message_id: "123",
      fail_if_not_exists: true,
    },
  });
});

test("forwardMessage sends a single native forward request", async () => {
  const requests = [];
  const result = await forwardMessage(message(), config, {
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return Response.json({ id: "forwarded" });
    },
  });

  assert.deepEqual(result, { id: "forwarded" });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://discord.com/api/v10/channels/999/messages");
  assert.equal(requests[0].init.headers.authorization, "Bot test-token");
  assert.deepEqual(JSON.parse(requests[0].init.body), createForwardPayload(message()));
});

test("forwardMessage retries Discord rate limits", async () => {
  let attempts = 0;
  const delays = [];
  const result = await forwardMessage(message(), config, {
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
