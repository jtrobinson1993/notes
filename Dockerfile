# syntax=docker/dockerfile:1
# The v8 relay image: a zero-knowledge message relay (spec/relay.md). It serves
# only /api/relay/* + /api/health — no web app is built or shipped here; the
# client is the native Tauri desktop app.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/shared/package.json ./shared/
COPY --from=build /app/shared/dist ./shared/dist
COPY --from=build /app/server/package.json ./server/
COPY --from=build /app/server/dist ./server/dist
# The operator CLI launcher, so `docker run --rm <image> npm run relay -- …`
# works without a checkout — that is how an operator mints the relay identity
# bundle when they deploy from the image (README "The relay identity").
COPY --from=build /app/server/bin ./server/bin
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3000
# v6 voice: mediasoup RTC media ports (UDP/TCP). Keep in sync with
# VOICE_RTC_MIN_PORT/VOICE_RTC_MAX_PORT; publish + forward this range to use voice.
EXPOSE 40000-40100/udp
EXPOSE 40000-40100/tcp
CMD ["node", "server/dist/relay-index.js"]
