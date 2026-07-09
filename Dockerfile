FROM node:20-alpine AS build
WORKDIR /app
# Build toolchain for native modules (better-sqlite3 compiles against musl here).
RUN apk add --no-cache python3 make g++
COPY package*.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY public ./public
# Writable directory for the optional SQLite database (mount a volume here and
# set DB_PATH=/app/data/<file>.db to persist sessions across restarts).
RUN mkdir -p /app/data && chown node:node /app/data
EXPOSE 3000
USER node
CMD ["node", "dist/server.js"]
