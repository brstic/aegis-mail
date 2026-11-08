# Built and run under Colima on arm64, and on amd64 Linux: see docs/STATUS.md. Sources are TypeScript at runtime, so images carry tsx.
FROM node:24-slim AS deps
RUN npm install -g pnpm@9.15.9
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY apps/extension/package.json apps/extension/
COPY packages/ packages/
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm --filter @aegis/web build

FROM build AS web
ENV NODE_ENV=production
RUN chown -R node:node apps/web/.next
USER node
EXPOSE 3000
CMD ["pnpm", "--filter", "@aegis/web", "start"]

# Also runs migrations and the demo seed: it has every package and the database CLI.
FROM deps AS worker
ENV NODE_ENV=production
COPY packages/ packages/
COPY apps/worker apps/worker
USER node
CMD ["pnpm", "--filter", "@aegis/worker", "exec", "tsx", "src/main.ts"]

# The image's clamd.conf answers OK for what it didn't read; this one doesn't. clamav/clamav has no arm64 build; this does.
FROM clamav/clamav-debian:stable AS clamd
COPY infra/docker/clamd.conf /etc/clamav/clamd.conf
