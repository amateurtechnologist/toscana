# toscana

Cloudflare Container + Cloudflare One Gateway Forward + Discord Gateway.

## Architecture

```text
Gateway HTTP Forward policy
          │
          ▼
GatewayMiddleware.handle()
          │
          ▼
TOSCANA_CONTAINER → ToscanaContainer Durable Object
          │
          ▼
Docker image on port 8080
          │
          ▼
Discord Gateway → MESSAGE_CREATE → category route → Expand-shaped message
```

`GatewayMiddleware` deliberately does not call `next()`. Gateway's
continuation preserves the original upstream destination, so this Worker routes
the request directly to the Container Durable Object instead.

The Container keeps one Discord Gateway session open. For each guild message it
resolves the source channel's category through the Discord API and routes
category A to its A' channel and category B to its B' channel. A' and B' are
excluded from forwarding to prevent loops. It never builds or stores a list of
active thread IDs; the blacklist remains an exception list.

Forwarding recreates the same visual shape as `/expand`: messages without
links use a quote embed, link messages use normal content, attachments are
uploaded when possible, and every copy has a `元のメッセージを開く` button.
The button points to the original message so `/expand` can resolve the source.

The default `fetch` handler is available for local development and health
checks. `/healthz` wakes the Container and returns its actual Gateway state.
Production access is expected to come through a Cloudflare One Forward policy;
`workersDev` and preview URLs are disabled.

## Local development

Requirements: Node.js 22+, Docker, and a Cloudflare account with Containers
and Workers enabled.

```sh
npm install
npm test
npm run typecheck
npm run dev
```

The local Worker is normally available at `http://localhost:8787`. Request
`/healthz` to check the Worker and Container path.

## Standalone deployment

The Gateway process does not require Cloudflare at runtime. It can run as a
long-lived Node.js container on an always-on PC, NAS, Raspberry Pi, or Oracle
Cloud Always Free VM. The host only needs outbound HTTPS/WebSocket access; no
public inbound port is required.

Create `.env` from `.env.example`, set the real bot token and the category
values, then run:

```sh
docker compose up -d --build
docker compose logs -f toscana
curl http://127.0.0.1:8080/healthz
```

The container uses `restart: unless-stopped`, so the Gateway reconnects after
process or VM restarts. Do not run this instance and the Cloudflare Container
with the same bot token at the same time; wait for `gateway_ready` here, then
disable the Cloudflare wake-up/deployment to avoid duplicate Gateway sessions.

## Deploy

Enable the Message Content privileged intent in the Discord Developer Portal.
The bot also needs `View Channel` and `Read Message History` in source
channels, `View Channel` in their parent channels, and `View Channel` plus
`Send Messages` in both target channels.

Set only the bot token as a Worker secret:

```sh
npx wrangler secret put DISCORD_TOKEN
```

Set category and target channel IDs as ordinary Worker vars in
`wrangler.jsonc` (or in the dashboard). IDs are configuration, not secrets:

```jsonc
{
  "vars": {
    "CATEGORY_A_ID": "category-id-a",
    "CATEGORY_A_FORWARD_CHANNEL_ID": "channel-id-a-prime",
    "CATEGORY_B_ID": "category-id-b",
    "CATEGORY_B_FORWARD_CHANNEL_ID": "channel-id-b-prime",
    "TOSCANA_BLACKLIST_CHANNEL_IDS": "thread-id-to-ignore",
    "TOSCANA_BLACKLIST_GUILD_IDS": "guild-id-to-ignore"
  }
}
```

The A' target must be inside category A and B' inside category B. The
blacklist values are exception lists only; they are not an inventory of
threads.

Authenticate with Wrangler, then deploy the Worker and Container:

```sh
npx wrangler login
npm run deploy
```

The first deployment builds the Docker image and provisions the Container
Durable Object. Container startup can take several minutes after the first
deployment.

The Worker has a five-minute Cron trigger that requests the Container health
endpoint. This is intentional: a Durable Object binding does not start its
Container until the object receives a request. The scheduled wake-up starts
the Gateway after deployment and reactivates it before the one-hour idle
timeout. `container_wakeup`, `container_started`, `gateway_socket_open`, and
`gateway_ready` are the relevant log events.

## Configure Gateway Forward

In the same Cloudflare account:

1. Configure Gateway HTTP filtering and TLS decryption for the test device.
2. Create a narrow HTTP Forward policy for one test host, path, and user or
   device group.
3. Select the deployed `toscana` Worker as the Forward target.
4. Verify the response contains `x-toscana-gateway: container`.

The API payload shape is in [`gateway-policy.example.json`](./gateway-policy.example.json).
Replace the worker ID with the deployed Worker's 32-character ID; do not put
an API token in this repository.

Forward policies apply to decrypted HTTP traffic. WebSockets, CONNECT tunnels,
and traffic excluded from inspection bypass the Gateway Worker.

## Container persistence

Container filesystems are not durable across instance replacement. Put durable
state in a Cloudflare binding such as D1, R2, KV, or Durable Object storage
when the application is added.
