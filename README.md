# toscana

Cloudflare Container + Cloudflare One Gateway Forward scaffold.

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
```

`GatewayMiddleware` deliberately does not call `next()`. Gateway's
continuation preserves the original upstream destination, so this Worker
routes the request directly to the Container Durable Object instead.

The default `fetch` handler is available for local development and health
checks. Production access is expected to come through a Cloudflare One
Forward policy; `workersDev` and preview URLs are disabled.

## Local development

Requirements: Node.js 22+, Docker, and a Cloudflare account with Containers
and Workers enabled.

```sh
npm install
npm run typecheck
npm run dev
```

The local Worker is normally available at `http://localhost:8787`. Request
`/healthz` to check the Worker and Container path.

## Deploy

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
