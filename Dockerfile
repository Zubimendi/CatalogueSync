# Multi-stage build for CatalogSync's API, projector, and sweep
# processes. Not required for local dev (see Makefile's `dev`/
# `projector`/`sweep` targets, which run against the host Node toolchain
# against Dockerized Postgres/Redis) — present for deploying the built
# app as containers once src/main.ts (and its sibling entrypoints) exist.
#
# NOTE: this Dockerfile will not build successfully until those
# entrypoints exist — see docs/CURSOR_CONTEXT.md.

FROM node:20-slim AS build
WORKDIR /srv
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-slim AS runtime
WORKDIR /srv
COPY --from=build /srv/node_modules ./node_modules
COPY --from=build /srv/dist ./dist
COPY --from=build /srv/prisma ./prisma

FROM runtime AS api
CMD ["node", "dist/main.js"]

FROM runtime AS projector
CMD ["node", "dist/projector-main.js"]

FROM runtime AS sweep
CMD ["node", "dist/sweep-main.js"]
