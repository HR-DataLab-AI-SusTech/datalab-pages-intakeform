# Intake bridge — multi-stage build.
#
# Unlike compass-board's zero-dependency bridge, this one has a real dependency (`pg`, to speak
# the Postgres wire protocol) — see bridge/package.json's description and the PR that added this
# directory for why that deviation from the zero-dep pattern is accepted.
#
# Digest pinned below to the multi-arch index digest for node:22-alpine, resolved 2026-08-27 via
# `docker buildx imagetools inspect node:22-alpine` (linux/amd64 manifest digest:
# sha256:76789712cd1ae89a1225eac9077010d68987a423588042dac30446f502f1858c). Bump deliberately;
# `docker compose pull` cannot surprise-upgrade this.

FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY server.js schema.sql package.json ./

# 🔺 NORMALISE PERMISSIONS, because COPY preserves the BUILDER's file modes and this image runs as
# an unprivileged user. A checkout made under a restrictive umask (umask 077 is normal on a host
# that also renders a mode-600 .env next to it) produces mode-600 sources; COPY carries that into
# the image; `USER node` below then cannot read its own entrypoint and the container crash-loops
# with `Error: Cannot find module /app/server.js` — which reads like a missing file, not a
# permission problem. Cost one debug cycle on 2026-08-27.
RUN chmod -R a+rX /app

EXPOSE 3458
USER node
CMD ["node", "server.js"]
