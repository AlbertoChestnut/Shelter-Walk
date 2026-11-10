# Container build of the app. It still needs a reverse proxy in front that
# authenticates every request and sets X-Auth-Email / X-Auth-Staff (see
# deploy/Caddyfile and docker-compose.yml): the app trusts those headers and
# has no login of its own.
FROM node:22-bookworm-slim AS builder
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
ENV DB_PATH=/app/data/dogwalk.db
# Required, passed in at run time (never baked into the image): see
# deploy/env/dogwalk.env.example and the README's env table.
#   EMAIL_HASH_PEPPER   secret for the one-way email hash; never change or lose it
#   INTERNAL_API_TOKEN  bearer token your auth service uses to call the app
# Optional: VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT for push.
COPY --from=builder --chown=node:node /app /app
RUN mkdir -p /app/data && chown node:node /app/data
# Run as the image's unprivileged "node" user (uid 1000). A bind-mounted
# data folder must be writable by that uid.
USER node
EXPOSE 3000
CMD ["node", "src/server.js"]
