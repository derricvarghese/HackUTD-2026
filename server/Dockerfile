# Build context is the repo root (the build copies ../openapi.yaml), see server/docker-compose.yml.
# Dashboard: web/ builds straight into /build/server/public (see web/vite.config.ts).
FROM node:22-alpine AS web
WORKDIR /build/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM node:22-alpine AS build
WORKDIR /build/server
COPY server/package.json server/package-lock.json ./
RUN npm ci
COPY openapi.yaml /build/openapi.yaml
COPY server/ ./
RUN npm run build

FROM node:22-alpine AS prod-deps
WORKDIR /app
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production PORT=3000
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /build/server/dist ./dist
COPY --from=web /build/server/public ./public
COPY server/package.json ./
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
