FROM node:22-alpine

WORKDIR /app

COPY container/gateway.mjs container/server.mjs ./

EXPOSE 8080

CMD ["node", "server.mjs"]
