# Web app (public menu + admin + kitchen). Can also deploy to Vercel;
# this Dockerfile is for parity with the voice service host.
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.18.3 --activate
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/core/package.json packages/core/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter @meatbox/web... --prod=false
COPY tsconfig.base.json ./
COPY packages/core packages/core
COPY apps/web apps/web
# DATABASE_URL is needed at runtime only; pages are dynamic.
RUN cd apps/web && pnpm build

FROM node:22-alpine
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.18.3 --activate
COPY --from=build /app ./
ENV NODE_ENV=production WEB_PORT=3000 HOSTNAME=0.0.0.0
EXPOSE 3000
CMD ["sh", "-c", "cd apps/web && ./node_modules/.bin/next start -H 0.0.0.0 -p 3000"]
