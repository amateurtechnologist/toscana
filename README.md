# toscana

Cloudflare Container + Cloudflare One Gateway Forward のHTTP転送用Workerです。

Discord投稿の自動転送は終了しました。送信元の投稿に対するメッセージコマンド `BUMP` の実行系は [agitat.ing](https://github.com/amateurtechnologist/agitat.ing) に移しています。カテゴリA・Bそれぞれの送信先は従来と同じです。送信先ID、指定絵文字のリアクションによる重複判定、コマンド登録はagitat.ingで管理します。

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
HTTP server on port 8080
```

`GatewayMiddleware` は `next()` を呼ばず、Container Durable ObjectへHTTPリクエストを渡します。このCloudflare OneのHTTP転送機能は維持しています。

ContainerはDiscord Gatewayに接続せず、`MESSAGE_CREATE` の監視・Discord APIへの転送・BUMPの実行を行いません。Dockerイメージにも旧Gatewayモジュールを含めません。Discordのトークンやカテゴリ・送信先の設定は不要です。

`/healthz` は `automatic_forwarding: false` と `gateway.state: "disabled"` を返します。Gatewayを常駐させるための5分間隔Cronも終了し、ContainerはHTTPリクエストで起動します。

## Local development

Node.js 22以上と、Containerを実行する場合はDockerが必要です。

```sh
npm ci
npm test
npm run typecheck
npm run dev
```

通常のローカルWorker URLは `http://localhost:8787` です。`/healthz` でWorkerからContainerへの経路を確認できます。

## Deploy

Wranglerで認証してデプロイします。

```sh
npx wrangler login
npm run deploy
```

WorkerとContainerの両方を反映してください。旧Containerが動作中の間は以前の自動転送処理が残るため、Containerのロールアウト完了を確認してください。BUMPコマンドの公開はagitat.ing側のデプロイ・登録で行います。

## Configure Gateway Forward

1. Cloudflare OneのGateway HTTP filteringとTLS decryptionを設定します。
2. 対象ホスト・パス・ユーザーまたはデバイスを限定したHTTP Forward policyを作成します。
3. Forward先にデプロイ済みの `toscana` Workerを指定します。
4. 応答の `x-toscana-gateway: container` ヘッダーを確認します。

APIの設定例は [gateway-policy.example.json](./gateway-policy.example.json) にあります。Worker IDを実際の32文字のIDに置き換えてください。APIトークンはリポジトリに保存しません。

Forward policyは復号済みHTTP通信に適用されます。WebSocket、CONNECTトンネル、検査対象外の通信はGateway Workerを経由しません。

## Container persistence

Containerのファイルシステムはインスタンスの置き換えで失われます。永続データにはD1、R2、KV、Durable Object storageなどを使用してください。

