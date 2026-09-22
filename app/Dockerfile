FROM node:20-bookworm-slim AS builder
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json ./
RUN npm install --omit=dev
COPY . .

FROM node:20-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
ENV DB_PATH=/app/data/dogwalk.db
COPY --from=builder /app /app
EXPOSE 3000
CMD ["node", "src/server.js"]
