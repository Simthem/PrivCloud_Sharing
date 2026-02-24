# ---------------------------
# Stage 0: Caddy binary (official image = latest Go deps, fixes Go CVEs)
# ---------------------------
FROM caddy:2-alpine AS caddy-binary

# ---------------------------
# Stage 1: Base
# ---------------------------
# checkov:skip=CKV_DOCKER_3:USER non utilisé - le container doit démarrer root
# pour que create-user.sh puisse chown les volumes avant de drop les privilèges
# via su-exec (voir commentaire dans le stage runner ci-dessous).
FROM node:24-alpine AS base

ARG HTTP_PROXY
ARG HTTPS_PROXY
ARG NO_PROXY=localhost,127.0.0.1,::1

# Proxy for build (only applied if set via --build-arg)
ENV HTTP_PROXY=${HTTP_PROXY}
ENV HTTPS_PROXY=${HTTPS_PROXY}
ENV http_proxy=${HTTP_PROXY}
ENV https_proxy=${HTTPS_PROXY}
ENV NO_PROXY=${NO_PROXY}
# Caddy n'est PAS installé via apk : on utilise le binaire officiel
# copié depuis caddy:2-alpine (stage caddy-binary) pour avoir les
# dernières corrections de sécurité Go (x/crypto, x/net, quic-go, etc.)
RUN apk update && \
    apk add --no-cache curl su-exec openssl python3 bash git && \
    npm install -g npm@latest

# ---------------------------
# Stage 1: Frontend dependencies
# ---------------------------
FROM base AS frontend-deps
WORKDIR /opt/app/frontend
COPY frontend/package.json frontend/package-lock.json ./

# Installer global-agent localement (v3 : v4 ship du TS non compilé, bootstrap cassé)
RUN npm install global-agent@3.0.0
RUN npm install

# ---------------------------
# Stage 2: Frontend build
# ---------------------------
FROM base AS frontend-builder
WORKDIR /opt/app/frontend
COPY --from=frontend-deps /opt/app/frontend/node_modules ./node_modules
COPY frontend/ ./

# Précharger global-agent
ENV NODE_OPTIONS="--require ./node_modules/global-agent/bootstrap"
ENV NEXT_TELEMETRY_DISABLED=1

RUN npm run build

# ---------------------------
# Stage 3: Backend dependencies
# ---------------------------
FROM base AS backend-deps
WORKDIR /opt/app/backend
COPY backend/package.json backend/package-lock.json ./

# Installer global-agent localement (v3 : v4 ship du TS non compilé, bootstrap cassé)
RUN npm install global-agent@3.0.0
RUN npm install

# ---------------------------
# Stage 4: Backend build
# ---------------------------
FROM base AS backend-builder
WORKDIR /opt/app/backend
COPY --from=backend-deps /opt/app/backend/node_modules ./node_modules
COPY backend/ ./
# Fix upstream TS7053 bug in seed: ts-node type-checks fail on dynamic key access.
# --transpile-only skips type checking at seed runtime without altering the compiled output.
RUN sed -i 's/ts-node prisma\/seed/ts-node --transpile-only prisma\/seed/g' package.json
RUN npx prisma generate
RUN npm run build && npm prune --omit=dev

# ---------------------------
# Stage 5: Final runner image
# ---------------------------
# trivy:ignore:DS002
FROM base AS runner

# NODE_ENV=docker is required by PrivCloud_Sharing: it controls paths,
# backend port (8080) and the behavior of create-user.sh / entrypoint.sh.
ENV NODE_ENV=docker

# Clear build-time proxy env vars so they do not leak into the published image.
# Users who need a proxy at runtime can set these in docker-compose.yaml.
ENV HTTP_PROXY=
ENV HTTPS_PROXY=
ENV http_proxy=
ENV https_proxy=
ENV NO_PROXY=

# Supprimer l'utilisateur node par défaut (l'original le fait).
# create-user.sh crée le bon utilisateur au RUNTIME avec su-exec,
# ce qui permet d'adapter UID/GID aux volumes montés depuis l'hôte.
# NE PAS mettre USER ici - le container doit démarrer root pour que
# create-user.sh puisse chown les volumes (data/, images/) avant de
# drop les privilèges via su-exec.
RUN deluser --remove-home node

# --- Frontend ---
WORKDIR /opt/app/frontend
# Next.js standalone : le contenu de .next/standalone va à la racine de frontend/
# pour que server.js soit à /opt/app/frontend/server.js
COPY --from=frontend-builder /opt/app/frontend/.next/standalone ./
COPY --from=frontend-builder /opt/app/frontend/.next/static ./.next/static
COPY --from=frontend-builder /opt/app/frontend/public ./public
# Images par défaut copiées dans /tmp/img - create-user.sh les déplace
# vers public/img avec les bonnes permissions au démarrage
COPY --from=frontend-builder /opt/app/frontend/public/img /tmp/img

# --- Backend ---
WORKDIR /opt/app/backend
COPY --from=backend-builder /opt/app/backend/node_modules ./node_modules
COPY --from=backend-builder /opt/app/backend/dist ./dist
COPY --from=backend-builder /opt/app/backend/prisma ./prisma
COPY --from=backend-builder /opt/app/backend/package.json ./
COPY --from=backend-builder /opt/app/backend/tsconfig.json ./
# ts-node + typescript sont des devDependencies prunées dans backend-builder.
# Elles sont néanmoins indispensables au runtime pour `prisma db seed`
# (le seed s'exécute au démarrage du container, pas au build).
COPY --from=backend-deps /opt/app/backend/node_modules/ts-node ./node_modules/ts-node
COPY --from=backend-deps /opt/app/backend/node_modules/typescript ./node_modules/typescript
COPY --from=backend-deps /opt/app/backend/node_modules/@tsconfig ./node_modules/@tsconfig

# --- global-agent : indispensable au RUNTIME ---
# Node.js n'honore PAS nativement HTTP_PROXY / HTTPS_PROXY.
# global-agent patche http.globalAgent / https.globalAgent pour router
# les requêtes sortantes (S3, API externes) via Squid.
# Sans ça, les uploads S3 contournent le proxy -> bloqués par le firewall -> timeout.
COPY --from=backend-deps /opt/app/backend/node_modules/global-agent ./node_modules/global-agent
COPY --from=backend-deps /opt/app/backend/node_modules/boolean ./node_modules/boolean
COPY --from=backend-deps /opt/app/backend/node_modules/roarr ./node_modules/roarr
COPY --from=backend-deps /opt/app/backend/node_modules/serialize-error ./node_modules/serialize-error
COPY --from=backend-deps /opt/app/backend/node_modules/matcher ./node_modules/matcher
COPY --from=backend-deps /opt/app/backend/node_modules/globalthis ./node_modules/globalthis
COPY --from=backend-deps /opt/app/backend/node_modules/semver ./node_modules/semver
COPY --from=backend-deps /opt/app/backend/node_modules/detect-node ./node_modules/detect-node
COPY --from=backend-deps /opt/app/backend/node_modules/es6-error ./node_modules/es6-error
COPY --from=backend-deps /opt/app/backend/node_modules/escape-string-regexp ./node_modules/escape-string-regexp
COPY --from=backend-deps /opt/app/backend/node_modules/json-stringify-safe ./node_modules/json-stringify-safe
COPY --from=backend-deps /opt/app/backend/node_modules/semver-compare ./node_modules/semver-compare
COPY --from=backend-deps /opt/app/backend/node_modules/sprintf-js ./node_modules/sprintf-js
COPY --from=backend-deps /opt/app/backend/node_modules/define-data-property ./node_modules/define-data-property
COPY --from=backend-deps /opt/app/backend/node_modules/define-properties ./node_modules/define-properties
COPY --from=backend-deps /opt/app/backend/node_modules/es-define-property ./node_modules/es-define-property
COPY --from=backend-deps /opt/app/backend/node_modules/es-errors ./node_modules/es-errors
COPY --from=backend-deps /opt/app/backend/node_modules/gopd ./node_modules/gopd
COPY --from=backend-deps /opt/app/backend/node_modules/has-property-descriptors ./node_modules/has-property-descriptors
COPY --from=backend-deps /opt/app/backend/node_modules/object-keys ./node_modules/object-keys
COPY --from=backend-deps /opt/app/backend/node_modules/type-fest ./node_modules/type-fest

# --- Caddy : binaire officiel (Go deps à jour, pas de CVE) ---
COPY --from=caddy-binary /usr/bin/caddy /usr/bin/caddy

# --- Scripts & reverse proxy ---
WORKDIR /opt/app
COPY ./reverse-proxy  /opt/app/reverse-proxy
# Alpine résout « localhost » en ::1 (IPv6) avant 127.0.0.1 (IPv4).
# NestJS n'écoute qu'en IPv4 -> Caddy obtient "connection refused" sur [::1]:8080.
# Forcer 127.0.0.1 dans TOUS les Caddyfiles (normal + trust-proxy).
RUN sed -i 's|http://localhost:|http://127.0.0.1:|g' /opt/app/reverse-proxy/Caddyfile /opt/app/reverse-proxy/Caddyfile.trust-proxy
COPY ./scripts/docker ./scripts/docker

EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=3s CMD sh -c \
    '[ "$CADDY_DISABLED" = "true" ] && curl -fs http://localhost:$BACKEND_PORT/api/health || curl -fs http://localhost:3000/api/health || exit 1'

ENTRYPOINT ["sh", "./scripts/docker/create-user.sh"]
CMD ["sh", "./scripts/docker/entrypoint.sh"]
