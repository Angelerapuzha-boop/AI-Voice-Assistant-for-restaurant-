# Voice WebSocket service — needs a host with persistent WebSocket support
# (Fly.io / Render / Railway), NOT a serverless platform.
FROM node:22-alpine
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.18.3 --activate
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/core/package.json packages/core/
COPY apps/voice/package.json apps/voice/
RUN pnpm install --frozen-lockfile --filter @meatbox/voice... --prod=false
COPY tsconfig.base.json ./
COPY packages/core packages/core
COPY apps/voice apps/voice
ENV NODE_ENV=production HOST=0.0.0.0 VOICE_PORT=8080
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s CMD wget -qO- http://127.0.0.1:8080/health | grep -q '"ok":true' || exit 1
CMD ["pnpm", "--filter", "@meatbox/voice", "start"]
