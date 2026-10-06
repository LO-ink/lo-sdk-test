FROM golang:1.27.1-alpine@sha256:8a5910f31396cd4d89662f56c68b3ae31d374308270a1c3bd96672ee5ed43414 AS go-toolchain
FROM node:24.21.0-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS build
COPY --from=go-toolchain /usr/local/go /usr/local/go
ENV PATH="/usr/local/go/bin:${PATH}"
WORKDIR /app
COPY package*.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY . .
ARG BUILD_REVISION=local
RUN BUILD_REVISION="$BUILD_REVISION" npm run build
RUN npm prune --omit=dev --ignore-scripts --no-audit --no-fund
FROM node:24.21.0-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1
ARG BUILD_REVISION=local
LABEL org.opencontainers.image.source="https://github.com/LO-ink/lo-sdk-test" \
      org.opencontainers.image.revision="$BUILD_REVISION"
WORKDIR /app
ENV PORT=5407 BIND_ADDRESS=0.0.0.0
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/server ./server
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
RUN mkdir -p /var/lib/lo-sdk-test && chown node:node /var/lib/lo-sdk-test && chmod 700 /var/lib/lo-sdk-test
USER node
EXPOSE 5407
CMD ["node", "server/index.mjs"]
