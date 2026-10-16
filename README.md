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
Discord Gateway → MESSAGE_CREATE → native Message Forwarding API
```

`GatewayMiddleware` deliberately does not call `next()`. Gateway's
continuation preserves the original upstream destination, so this Worker
routes the request directly to the Container Durable Object instead.

The Container keeps one Discord Gateway session open. It checks the
`channel_type` included in each `MESSAGE_CREATE` event, forwards only thread
messages, and checks the source channel/guild against the blacklist. It never
builds or stores a list of active thread IDs. Forwarding uses Discord's native
Message Forwarding API (`message_reference.type = 1`), so the original content
and attachments are represented by Discord without a second fetch.

The default `fetch` handler is available for local development and health
checks. Production access is expected to come through a Cloudflare One
Forward policy; `workersDev` and preview URLs are disabled.

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

## Deploy

Enable the Message Content privileged intent in the Discord Developer Portal.
The bot also needs `View Channel` in source threads and `View Channel` plus
`Send Messages` in the target channel.

Set the token and target channel as Worker secrets:

```sh
npx wrangler secret put DISCORD_TOKEN
npx wrangler secret put TOSCANA_FORWARD_CHANNEL_ID
```

Set optional blacklist IDs as comma- or whitespace-separated Worker vars in
`wrangler.jsonc` (or in the dashboard):

```jsonc
{
  "vars": {
    "TOSCANA_BLACKLIST_CHANNEL_IDS": "thread-id-to-ignore",
    "TOSCANA_BLACKLIST_GUILD_IDS": "guild-id-to-ignore"
  }
}
```

These are exception lists only; they are not an inventory of threads.

Authenticate with Wrangler, then deploy the Worker and Container:

```sh
npx wrangler login
npm run deploy
```

The first deployment builds the Docker image and provisions the Container
Durable Object. Container startup can take several minutes after the first
deployment.

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

Forward policies apply to decrypted HTTP traffic. WebSockets, CONNECT
tunnels, and traffic excluded from inspection bypass the Gateway Worker.

## Container persistence

Container filesystems are not durable across instance replacement. Put durable
state in a Cloudflare binding such as D1, R2, KV, or Durable Object storage
when the application is added.
