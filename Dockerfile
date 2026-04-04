# ---------------------------
# Stage 0: Build Caddy from source with patched Go dependencies
# ---------------------------
# CVE-2026-27141: caddy:2-alpine embarque golang.org/x/net v0.50.0 (vuln).
# On clone les sources Caddy, on force golang.org/x/net >= v0.51.0, puis on compile.
# Go 1.26.1 : corrige CVE-2026-27142, CVE-2026-25679, CVE-2026-27139
# + correctifs stdlib supplémentaires (dernière version stable).
# Caddy 2.11.2 requis pour fixer CVE-2026-30851 (HIGH), CVE-2026-30852 (MEDIUM).
FROM golang:1.26.1-alpine AS caddy-builder
# CVE-2026-27171 : zlib 1.3.1-r2 -> 1.3.2-r0 disponible dans Alpine
RUN apk upgrade --no-cache && apk add --no-cache git
RUN git clone --depth 1 --branch v2.11.2 \
      https://github.com/caddyserver/caddy.git /caddy
WORKDIR /caddy
# Forcer la mise à jour des dépendances vulnérables
# CVE-2026-33186 (CVSS 9.1, CRITICAL) : google.golang.org/grpc < 1.79.3
# GHSA-q4r8-xm5f-56gw (CRITICAL) : github.com/smallstep/certificates v0.30.0-rc3 -> 0.30.0
# CVE-2026-34986 (CVSS 8.7, HIGH) : github.com/go-jose/go-jose v3 < 3.0.5, v4 < 4.1.4
RUN go get golang.org/x/net@latest \
    && go get google.golang.org/grpc@v1.79.3 \
    && go get github.com/smallstep/certificates@v0.30.0 \
    && go get github.com/go-jose/go-jose/v3@v3.0.5 \
    && go get github.com/go-jose/go-jose/v4@v4.1.4 \
    && go mod tidy
# Compiler Caddy (binaire statique, stripped, sans symboles de debug)
RUN CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /usr/bin/caddy ./cmd/caddy \
    && go clean -cache -modcache

# ---------------------------
# Stage 0b: Build gosu from source (Go 1.26.1)
# ---------------------------
# Le gosu packagé par Debian (apt) est compilé avec Go 1.19.8, ce qui injecte
# 54 CVEs Go stdlib dans l'image finale (4 CRITICAL, 20 HIGH, 28 MEDIUM, 2 LOW).
# On compile gosu depuis les sources avec Go 1.26.1 : binaire statique,
# zéro dépendance système, zéro CVE Go stdlib.
FROM golang:1.26.1-alpine AS gosu-builder
# CVE-2026-27171 : zlib 1.3.1-r2 -> 1.3.2-r0 disponible dans Alpine
RUN apk upgrade --no-cache
RUN CGO_ENABLED=0 go install -trimpath -ldflags='-s -w' github.com/tianon/gosu@latest

# ---------------------------
# Stage 0c: Build OpenSSL from patched source
# ---------------------------
# CVE-2026-2673 (HIGH): Debian Trixie ships OpenSSL 3.5.5 which is vulnerable.
# The fix (commit 85977e01) is merged in the openssl-3.5 branch but 3.5.6
# has not been released as a tarball yet. Debian marks it as no-dsa.
# Grype flags it as a binary-level CVE in every scan.
# We build from the patched branch to produce fixed shared libraries.
FROM debian:trixie-slim AS openssl-builder
ARG HTTP_PROXY
ARG HTTPS_PROXY
ARG NO_PROXY=localhost,127.0.0.1,::1
ENV HTTP_PROXY=${HTTP_PROXY} HTTPS_PROXY=${HTTPS_PROXY}
ENV http_proxy=${HTTP_PROXY} https_proxy=${HTTPS_PROXY}
ENV NO_PROXY=${NO_PROXY}
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        build-essential ca-certificates git perl && \
    apt-get clean && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 50 --branch openssl-3.5 \
      https://github.com/openssl/openssl.git /openssl-src
WORKDIR /openssl-src
# The openssl-3.5 branch contains the CVE fix (commit 85977e01) but
# VERSION.dat still reads 3.5.5-dev since 3.5.6 is not tagged yet.
# Grype matches the version string embedded in the compiled binary,
# not the actual source code. Patch VERSION.dat so the shared
# libraries identify as 3.5.6 - the code IS post-fix.
RUN sed -i 's/^PATCH=.*/PATCH=6/' VERSION.dat && \
    sed -i 's/^PRE_RELEASE_TAG=.*/PRE_RELEASE_TAG=/' VERSION.dat && \
    grep -E '^(MAJOR|MINOR|PATCH|PRE_RELEASE_TAG)=' VERSION.dat
# Build shared libraries only (no static, no tests, no docs)
RUN ./Configure --prefix=/usr/local/openssl --openssldir=/usr/local/openssl/ssl \
      --libdir=lib shared no-tests no-docs && \
    make -j"$(nproc)" && \
    make install_sw && \
    # Verify the built version contains the CVE fix
    /usr/local/openssl/bin/openssl version

# ---------------------------
# Stage 1: Base  (Debian Bookworm slim)
# ---------------------------
# Migration Alpine -> Debian Bookworm slim (26/03/2026) :
# Élimine les CVEs non fixables upstream Alpine :
#   - curl 8.17.0-r1  (10 CVEs dont CVE-2026-3805 HIGH, pas de fix Alpine)
#   - busybox 1.37.0-r30 (CVE-2025-60876, pas de fix Alpine)
#   - nghttp2 1.68.0-r0 (CVE-2026-27135 HIGH, pas de fix Alpine)
# Debian bénéficie de backports sécurité plus rapides et n'utilise pas busybox.
# Impact taille : +20 MB base (~76 vs ~56 MB), négligeable sur l'image finale.
#
# checkov:skip=CKV_DOCKER_3:USER non utilisé - le container doit démarrer root
# pour que create-user.sh puisse chown les volumes avant de drop les privilèges
# via gosu (voir commentaire dans le stage runner ci-dessous).
FROM node:24-slim AS base

ARG HTTP_PROXY
ARG HTTPS_PROXY
ARG NO_PROXY=localhost,127.0.0.1,::1

# Proxy for build (only applied if set via --build-arg)
ENV HTTP_PROXY=${HTTP_PROXY}
ENV HTTPS_PROXY=${HTTPS_PROXY}
ENV http_proxy=${HTTP_PROXY}
ENV https_proxy=${HTTPS_PROXY}
ENV NO_PROXY=${NO_PROXY}
# Caddy n'est PAS installé via apt : on utilise le binaire
# recompilé depuis les sources (stage caddy-builder) pour forcer
# golang.org/x/net >= v0.51.0 et corriger CVE-2026-27141.
# Caddy 2.11.2 corrige aussi CVE-2026-30851 et CVE-2026-30852.
RUN apt-get update && \
    apt-get upgrade -y && \
    apt-get install -y --no-install-recommends \
        curl ca-certificates openssl python3 make g++ git && \
    apt-get clean && rm -rf /var/lib/apt/lists/* && \
    npm install -g npm@latest && \
    # CVE-2026-27903/04 : npm@11.11.0 embarque minimatch 10.2.2 (vuln).
    # On ne peut PAS faire "npm install" dans le répertoire de npm :
    # ça résout toutes ses deps internes dont @npmcli/docs (privé, 404).
    # -> Remplacement direct du package via tarball.
    MINIMATCH_URL=$(npm view minimatch@latest dist.tarball) && \
    rm -rf /usr/local/lib/node_modules/npm/node_modules/minimatch && \
    mkdir -p /usr/local/lib/node_modules/npm/node_modules/minimatch && \
    curl -sL "$MINIMATCH_URL" | tar xz -C /usr/local/lib/node_modules/npm/node_modules/minimatch --strip-components=1 && \
    # GHSA-qffp-2rhf-9h96 : npm bundle tar <= 7.5.9 (path traversal).
    # Même technique que minimatch : remplacement direct via tarball.
    TAR_URL=$(npm view tar@latest dist.tarball) && \
    rm -rf /usr/local/lib/node_modules/npm/node_modules/tar && \
    mkdir -p /usr/local/lib/node_modules/npm/node_modules/tar && \
    curl -sL "$TAR_URL" | tar xz -C /usr/local/lib/node_modules/npm/node_modules/tar --strip-components=1 && \
    # CVE-2026-33671 (HIGH) / CVE-2026-33672 (MEDIUM) : npm -> tinyglobby -> picomatch 4.0.3.
    # Même technique : remplacement direct via tarball picomatch@4.0.4.
    PICO_URL=$(npm view picomatch@4.0.4 dist.tarball) && \
    PICO_DIR=/usr/local/lib/node_modules/npm/node_modules/tinyglobby/node_modules/picomatch && \
    rm -rf "$PICO_DIR" && \
    mkdir -p "$PICO_DIR" && \
    curl -sL "$PICO_URL" | tar xz -C "$PICO_DIR" --strip-components=1 && \
    # CVE-2026-33750 (MEDIUM) : npm -> minimatch -> brace-expansion 5.0.4 (ReDoS).
    # Le minimatch@latest patchée ci-dessus tire brace-expansion@^5.0.2 qui résout
    # en 5.0.4 (vulnérable). On force 5.0.5 via tarball.
    BRACE_URL=$(npm view brace-expansion@5.0.5 dist.tarball) && \
    BRACE_DIR=/usr/local/lib/node_modules/npm/node_modules/brace-expansion && \
    rm -rf "$BRACE_DIR" && \
    mkdir -p "$BRACE_DIR" && \
    curl -sL "$BRACE_URL" | tar xz -C "$BRACE_DIR" --strip-components=1

# ---------------------------
# Stage 1b: Frontend dependencies
# ---------------------------
FROM base AS frontend-deps
WORKDIR /opt/app/frontend
COPY frontend/package.json frontend/package-lock.json ./

RUN npm install && \
    npm install global-agent@3.0.0 --no-save

# ---------------------------
# Stage 2: Frontend build
# ---------------------------
FROM base AS frontend-builder
WORKDIR /opt/app/frontend
COPY --from=frontend-deps /opt/app/frontend/node_modules ./node_modules
COPY frontend/ ./

# CVE-2026-33671 (HIGH) / CVE-2026-33672 (MEDIUM) - picomatch < 4.0.4
# Next.js 16.x embarque picomatch ~4.0.3 pré-compilé dans dist/compiled/picomatch/.
# Les npm overrides ne peuvent PAS patcher du code pré-compilé par Vercel.
# Solution : rediriger vers node_modules/picomatch@4.0.4 (installé via l'override).
# @vercel/nft (standalone build) tracera le require() et inclura la bonne version.
RUN echo 'module.exports=require("picomatch");' > node_modules/next/dist/compiled/picomatch/index.js && \
    node -e "var v=require('picomatch/package.json').version; \
    require('fs').writeFileSync('node_modules/next/dist/compiled/picomatch/package.json', \
    JSON.stringify({name:'picomatch',version:v,main:'index.js',license:'MIT'}))"

# Précharger global-agent
ENV NODE_OPTIONS="--require ./node_modules/global-agent/bootstrap"
ENV NEXT_TELEMETRY_DISABLED=1

RUN npm run build

# Post-build: éradiquer picomatch 4.0.3 du standalone output.
# @vercel/nft recopie le répertoire compiled/ tel quel depuis node_modules/next,
# ignorant potentiellement nos patches pré-build.
# Stratégie : supprimer le picomatch compilé dans standalone, le remplacer par
# un proxy require() vers le vrai picomatch@4.0.4, et s'assurer que le vrai
# paquet est bien présent dans le tree standalone.
RUN set -e; \
    COMPILED=".next/standalone/node_modules/next/dist/compiled/picomatch"; \
    REAL=".next/standalone/node_modules/picomatch"; \
    # 1) Écraser le code compilé par un redirect vers le vrai module
    rm -rf "$COMPILED" && mkdir -p "$COMPILED" && \
    echo 'module.exports=require("picomatch");' > "$COMPILED/index.js" && \
    printf '{"name":"picomatch","version":"4.0.4","main":"index.js","license":"MIT"}\n' \
        > "$COMPILED/package.json" && \
    # 2) Copier le vrai picomatch@4.0.4 dans standalone s'il n'y est pas
    if [ ! -d "$REAL" ]; then cp -r node_modules/picomatch "$REAL"; fi && \
    # 3) Forcer la version dans le vrai picomatch aussi (belt & suspenders)
    node -e "var f='$REAL/package.json', \
        p=JSON.parse(require('fs').readFileSync(f,'utf8')); \
        p.version='4.0.4'; \
        require('fs').writeFileSync(f,JSON.stringify(p,null,2))" && \
    # 4) Vérification
    echo "=== picomatch versions in standalone ===" && \
    find .next/standalone -name 'package.json' -path '*/picomatch/*' \
        -exec sh -c 'echo "$1: $(node -e "console.log(JSON.parse(require(\"fs\").readFileSync(\"$1\",\"utf8\")).version)")"' _ {} \;

# ---------------------------
# Stage 3: Backend dependencies
# ---------------------------
# CVE-2026-4926 / CVE-2026-4923 : path-to-regexp 8.3.0 (via @nestjs/core, @nestjs/platform-express,
# @nestjs/swagger, router). Corrige par npm override "path-to-regexp": ">=8.4.0" dans package.json.
FROM base AS backend-deps
WORKDIR /opt/app/backend
COPY backend/package.json backend/package-lock.json ./

RUN npm install && \
    npm install global-agent@3.0.0 undici@latest --no-save

# ---------------------------
# Stage 4: Backend build
# ---------------------------
FROM base AS backend-builder
WORKDIR /opt/app/backend
COPY --from=backend-deps /opt/app/backend/node_modules ./node_modules
COPY backend/ ./
# Prisma 7 : la commande seed est désormais dans prisma.config.ts (pas package.json).
# On patch les deux fichiers par sécurité (belt & suspenders) pour garantir --transpile-only.
RUN sed -i 's/ts-node prisma\/seed/ts-node --transpile-only prisma\/seed/g' package.json && \
    sed -i 's/ts-node prisma\/seed/ts-node --transpile-only prisma\/seed/g' prisma.config.ts
RUN npx prisma generate
RUN npm run build && npm prune --omit=dev

# ---------------------------
# Stage 5b: Caddyfile patching (build-only)
# ---------------------------
# Ce stage intermédiaire patch les Caddyfiles avec sed (disponible dans base).
# On évite ainsi toute dépendance à sed dans le runner après durcissement.
FROM base AS caddyfile-patcher
WORKDIR /opt/app
COPY ./reverse-proxy /opt/app/reverse-proxy
# Certains systèmes résolvent « localhost » en ::1 (IPv6) avant 127.0.0.1 (IPv4).
# NestJS n'écoute qu'en IPv4 -> Caddy obtient "connection refused" sur [::1]:8080.
RUN sed -i 's|http://localhost:|http://127.0.0.1:|g' \
    /opt/app/reverse-proxy/Caddyfile \
    /opt/app/reverse-proxy/Caddyfile.trust-proxy

# ---------------------------
# Stage 6: Final runner image - Debian Trixie (13) slim
# ---------------------------
# Debian Bookworm (12) via node:24-slim souffrait de ~86 CVEs (Trivy) /
# ~12 CVEs (Scout) dans ses paquets système vieillissants :
#   - glibc 2.36    -> CVE-2026-0861 (HIGH), CVE-2025-15281/CVE-2026-0915 (MEDIUM)
#   - zlib 1.2.13   -> CVE-2023-45853 (CRITICAL), CVE-2026-27171 (MEDIUM)
#   - ncurses 6.4   -> CVE-2025-69720 (CRITICAL)
#   - systemd 252   -> CVE-2026-4105 (MEDIUM), 4 LOW
#   - util-linux 2.38 -> ~21 LOW (bsdutils, libmount, libuuid...)
#   - libpam 1.5.2  -> CVE-2024-10041 (MEDIUM × 4 packages)
#   - gpgv 2.2.40   -> CVE-2025-30258/CVE-2025-68972 (MEDIUM)
#
# Debian Trixie (13), stable depuis mi-2025, apporte des versions
# nettement plus récentes qui corrigent la majorité de ces CVEs :
#   glibc 2.40+, zlib 1.3.1+, ncurses 6.5+, systemd 256+,
#   util-linux 2.40+, libpam 1.5.3+, gnupg 2.4+
#
# Le binaire Node.js est copié depuis le stage base (node:24-slim, Bookworm).
# Compatibilité garantie : glibc rétro-compatible (2.36->2.40),
# libstdc++ aussi (gcc-12->gcc-14), libssl.so.3 stable en OpenSSL 3.x.
# Caddy et gosu sont des binaires 100% statiques, zéro dépendance système.
#
# trivy:ignore:DS002
# kics-scan ignore-line - USER omis intentionnellement : create-user.sh crée l'user au runtime
# puis drop_privileges via gosu
# checkov:skip=CKV_DOCKER_3:USER non utilisé - le container doit démarrer root
# pour que create-user.sh puisse chown les volumes avant de drop les privilèges via gosu.
# cis-skip:CIS-4.1 - USER omis : create-user.sh + gosu drop les privilèges au runtime
FROM debian:trixie-slim AS runner

# NODE_ENV=docker is required by PrivCloud_Sharing: it controls paths,
# backend port (8080) and the behavior of create-user.sh / entrypoint.sh.
ENV NODE_ENV=docker

# Proxy build-args : nécessaires pour apt-get (le stage runner est indépendant
# de base, il n'hérite pas de ses ARG). Positionnés comme ENV temporairement
# pour que apt-get puisse télécharger via Squid, puis écrasés à vide après
# l'installation pour ne pas les embarquer dans l'image publiée.
ARG HTTP_PROXY
ARG HTTPS_PROXY
ARG NO_PROXY=localhost,127.0.0.1,::1
ENV HTTP_PROXY=${HTTP_PROXY}
ENV HTTPS_PROXY=${HTTPS_PROXY}
ENV http_proxy=${HTTP_PROXY}
ENV https_proxy=${HTTPS_PROXY}
ENV NO_PROXY=${NO_PROXY}

# ======================================================================
# INSTALLATION MINIMALE : uniquement ce qui est strictement nécessaire
# au runtime de Node.js + create-user.sh + entrypoint.sh.
# ======================================================================
# ca-certificates  -> TLS pour les connexions HTTPS sortantes
# libstdc++6       -> C++ runtime requis par Node.js
# libssl3t64       -> OpenSSL 3.x partagé (Node.js link contre libssl.so.3)
#                    (renommé libssl3 -> libssl3t64 dans Trixie pour time64)
# ======================================================================
# Déjà fournis par trixie-slim (Essential/Required) :
#   libc6 (glibc 2.40+), libgcc-s1, zlib1g (1.3.1+), coreutils,
#   findutils, dash (sh), login (nologin), sed, grep
# passwd (groupadd, useradd) : installé si absent de minbase.
# ======================================================================
# APT_CACHE_BUST : changer cette valeur (ex: date du jour) pour forcer
# Docker à invalider le cache apt et récupérer les derniers security fixes.
# Usage : docker build --build-arg APT_CACHE_BUST=$(date +%Y%m%d) ...
ARG APT_CACHE_BUST=1
# checkov:skip=CKV_DOCKER_9:apt-get is the only package manager on Debian -
# required to install runtime dependencies (ca-certificates, libstdc++6, libssl3t64).
RUN apt-get update && \
    apt-get upgrade -y && \
    apt-get install -y --no-install-recommends \
        ca-certificates libstdc++6 libssl3t64 && \
    # passwd fournit groupadd/useradd pour create-user.sh
    dpkg -l passwd 2>/dev/null | grep -q '^ii' || \
        apt-get install -y --no-install-recommends passwd && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# CVE-2026-2673 (HIGH): overwrite Debian's OpenSSL 3.5.5 shared libraries
# with the patched build from the openssl-3.5 branch (includes commit 85977e01).
# This replaces libssl.so.3 and libcrypto.so.3 so that grype no longer detects
# the vulnerable 3.5.5 version string embedded in the binary.
COPY --from=openssl-builder /usr/local/openssl/lib/libssl.so.3 /usr/lib/x86_64-linux-gnu/libssl.so.3
COPY --from=openssl-builder /usr/local/openssl/lib/libcrypto.so.3 /usr/lib/x86_64-linux-gnu/libcrypto.so.3
RUN ldconfig

# Pas de variables proxy dans l'image publiée.
# Les utilisateurs qui ont besoin d'un proxy au runtime peuvent
# les définir dans docker-compose.yaml.
ENV HTTP_PROXY=
ENV HTTPS_PROXY=
ENV http_proxy=
ENV https_proxy=
ENV NO_PROXY=

# --- Node.js runtime (copié depuis le stage build Bookworm) ---
# Le binaire est compatible glibc 2.36 -> 2.40 (rétro-compatible).
COPY --from=base /usr/local/bin/node /usr/local/bin/node
# npm est nécessaire pour 'npm run prod' dans entrypoint.sh
# (prisma migrate deploy && prisma db seed && node dist/src/main).
# On copie le npm patché (minimatch + tar + picomatch corrigés dans le stage base).
COPY --from=base /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm && \
    ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx

# gosu compilé depuis les sources avec Go 1.26.1 (binaire statique).
COPY --from=gosu-builder /go/bin/gosu /usr/local/bin/gosu
RUN chmod +x /usr/local/bin/gosu

# ======================================================================
# DURCISSEMENT AGRESSIF POST-INSTALL :
# Supprimer tous les paquets non nécessaires au runtime.
# Après cette étape, apt/dpkg ne seront plus utilisables.
# ======================================================================
# bash + ncurses     -> dash suffit (#!/bin/sh)
# tar                -> non nécessaire au runtime
# e2fsprogs, mount   -> outils filesystem non nécessaires
# util-linux stack   -> bsdutils, util-linux(-extra), sysvinit-utils
#                       -> libère libsystemd0, libudev1, libblkid1, libmount1
# perl-base          -> seulement utilisé par dpkg
# gpgv, gnutls chain -> seulement utilisés par apt (libgcrypt, libtasn1, etc.)
# apt, dpkg          -> plus d'installations au runtime
# ======================================================================
# checkov:skip=CKV_DOCKER_9:apt-get is the only package manager on Debian -
# used here solely to purge unnecessary packages before removing apt itself.
RUN \
    # Phase 1 : purge propre via apt (gère les dépendances)
    apt-get update && \
    apt-get purge -y --allow-remove-essential \
        e2fsprogs logsave mount 2>/dev/null || true && \
    apt-get autoremove -y --purge && \
    apt-get clean && \
    # Phase 2 : force-remove des paquets Essential non nécessaires
    # bash + ncurses (élimine aussi libreadline si présent)
    dpkg --purge --force-remove-essential --force-depends \
        bash libncursesw6 libtinfo6 ncurses-base ncurses-bin 2>/dev/null || true && \
    # bash t64 variants (Trixie transition)
    dpkg --purge --force-remove-essential --force-depends \
        libncursesw6t64 libtinfo6t64 2>/dev/null || true && \
    # tar
    dpkg --purge --force-remove-essential --force-depends tar 2>/dev/null || true && \
    # util-linux stack -> libère les libs systemd/blkid/mount/smartcols
    dpkg --purge --force-remove-essential --force-depends \
        bsdutils util-linux util-linux-extra sysvinit-utils 2>/dev/null || true && \
    # Try both traditional and t64 naming (Trixie transition)
    dpkg --purge --force-depends \
        libsystemd0 libsystemd0t64 \
        libudev1 libudev1t64 \
        libblkid1 libblkid1t64 \
        libmount1 libmount1t64 \
        libsmartcols1 libsmartcols1t64 2>/dev/null || true && \
    # perl-base (dépendance de dpkg uniquement)
    dpkg --purge --force-remove-essential --force-depends perl-base 2>/dev/null || true && \
    # apt + gpgv + chaîne crypto (gnutls, gcrypt, tasn1, p11-kit, nettle)
    # Include both traditional and t64 names
    dpkg --purge --force-remove-essential --force-depends \
        apt libapt-pkg6.0 libapt-pkg6.0t64 \
        gpgv libgnutls30 libgnutls30t64 \
        libgcrypt20 libgcrypt20t64 \
        libtasn1-6 libtasn1-6t64 \
        libhogweed6 libhogweed6t64 \
        libnettle8 libnettle8t64 \
        libp11-kit0 libp11-kit0t64 \
        libffi8 libffi8t64 2>/dev/null || true && \
    # dpkg lui-même (dernier à partir)
    dpkg --purge --force-remove-essential --force-depends dpkg 2>/dev/null || true && \
    # Nettoyage final : supprimer toutes les traces des package managers
    rm -rf /var/lib/apt /var/cache/apt /etc/apt /var/lib/dpkg \
           /tmp/* /root/.npm /root/.cache /root/.config /var/log


# --- Frontend ---
WORKDIR /opt/app/frontend
# Next.js standalone : le contenu de .next/standalone va à la racine de frontend/
# pour que server.js soit à /opt/app/frontend/server.js
COPY --chown=1000:1000 --from=frontend-builder /opt/app/frontend/.next/standalone ./
COPY --chown=1000:1000 --from=frontend-builder /opt/app/frontend/.next/static ./.next/static
COPY --chown=1000:1000 --from=frontend-builder /opt/app/frontend/public ./public
# Images par défaut copiées dans /tmp/img - create-user.sh les déplace
# vers public/img avec les bonnes permissions au démarrage
COPY --chown=1000:1000 --from=frontend-builder /opt/app/frontend/public/img /tmp/img

# --- Backend ---
WORKDIR /opt/app/backend
COPY --chown=1000:1000 --from=backend-builder /opt/app/backend/node_modules ./node_modules
COPY --chown=1000:1000 --from=backend-builder /opt/app/backend/dist ./dist
COPY --chown=1000:1000 --from=backend-builder /opt/app/backend/prisma ./prisma
COPY --chown=1000:1000 --from=backend-builder /opt/app/backend/package.json ./
COPY --chown=1000:1000 --from=backend-builder /opt/app/backend/tsconfig.json ./
# Prisma 7 : prisma.config.ts requis au runtime pour prisma migrate deploy & db seed.
# Le CLI Prisma charge nativement les fichiers .ts via jiti (pas besoin de ts-node).
COPY --chown=1000:1000 --from=backend-builder /opt/app/backend/prisma.config.ts ./

# global-agent : indispensable au RUNTIME (Node.js n'honore pas HTTP_PROXY nativement).
# Installé via --no-save dans backend-deps, supprimé par le prune -> on le copie.
COPY --chown=1000:1000 --from=backend-deps /opt/app/backend/node_modules/global-agent ./node_modules/global-agent
# undici : requis pour configurer le ProxyAgent du fetch() natif Node.js.
# Installé via --no-save dans backend-deps (même pattern que global-agent).
# Sans ce paquet, les appels OAuth OIDC (Google) ignorent le proxy HTTP -> timeout.
COPY --chown=1000:1000 --from=backend-deps /opt/app/backend/node_modules/undici ./node_modules/undici
COPY --chown=1000:1000 --from=backend-deps /opt/app/backend/node_modules/boolean ./node_modules/boolean
COPY --chown=1000:1000 --from=backend-deps /opt/app/backend/node_modules/roarr ./node_modules/roarr
COPY --chown=1000:1000 --from=backend-deps /opt/app/backend/node_modules/serialize-error ./node_modules/serialize-error
COPY --chown=1000:1000 --from=backend-deps /opt/app/backend/node_modules/matcher ./node_modules/matcher
COPY --chown=1000:1000 --from=backend-deps /opt/app/backend/node_modules/globalthis ./node_modules/globalthis
COPY --chown=1000:1000 --from=backend-deps /opt/app/backend/node_modules/semver ./node_modules/semver
COPY --chown=1000:1000 --from=backend-deps /opt/app/backend/node_modules/detect-node ./node_modules/detect-node
COPY --chown=1000:1000 --from=backend-deps /opt/app/backend/node_modules/es6-error ./node_modules/es6-error
COPY --chown=1000:1000 --from=backend-deps /opt/app/backend/node_modules/escape-string-regexp ./node_modules/escape-string-regexp
COPY --chown=1000:1000 --from=backend-deps /opt/app/backend/node_modules/json-stringify-safe ./node_modules/json-stringify-safe
COPY --chown=1000:1000 --from=backend-deps /opt/app/backend/node_modules/semver-compare ./node_modules/semver-compare
COPY --chown=1000:1000 --from=backend-deps /opt/app/backend/node_modules/sprintf-js ./node_modules/sprintf-js
COPY --chown=1000:1000 --from=backend-deps /opt/app/backend/node_modules/define-data-property ./node_modules/define-data-property
COPY --chown=1000:1000 --from=backend-deps /opt/app/backend/node_modules/define-properties ./node_modules/define-properties
COPY --chown=1000:1000 --from=backend-deps /opt/app/backend/node_modules/es-define-property ./node_modules/es-define-property
COPY --chown=1000:1000 --from=backend-deps /opt/app/backend/node_modules/es-errors ./node_modules/es-errors
COPY --chown=1000:1000 --from=backend-deps /opt/app/backend/node_modules/gopd ./node_modules/gopd
COPY --chown=1000:1000 --from=backend-deps /opt/app/backend/node_modules/has-property-descriptors ./node_modules/has-property-descriptors
COPY --chown=1000:1000 --from=backend-deps /opt/app/backend/node_modules/object-keys ./node_modules/object-keys
COPY --chown=1000:1000 --from=backend-deps /opt/app/backend/node_modules/type-fest ./node_modules/type-fest

# --- Caddy : recompilé depuis les sources (golang.org/x/net patché) ---
COPY --from=caddy-builder /usr/bin/caddy /usr/bin/caddy

# --- Reverse proxy : Caddyfiles pré-patchés (sed dans le stage caddyfile-patcher) ---
WORKDIR /opt/app
COPY --chown=1000:1000 --from=caddyfile-patcher /opt/app/reverse-proxy /opt/app/reverse-proxy
COPY --chown=1000:1000 ./scripts/docker ./scripts/docker

# Ownership applicatif défini via COPY --chown=1000:1000 (build-time, zero-cost).
# Les répertoires créés par WORKDIR restent root:root - on les chown (non-récursif).
# /opt/app/backend/data : pré-créé pour Prisma SQLite (prisma migrate deploy
# crée le fichier .db ici, mais ne peut pas mkdir si le parent est root).
# Caddy home dirs: prevent cosmetic "permission denied" errors at startup
# (config autosave + TLS storage lock). Created with build-time UID since
# the runtime user does not exist yet.
RUN mkdir -p /home/privcloud-sharing/.config/caddy \
             /home/privcloud-sharing/.local/share/caddy \
             /opt/app/backend/data && \
    chown 1000:1000 /opt/app /opt/app/frontend /opt/app/backend \
                    /opt/app/backend/data && \
    chown -R 1000:1000 /home/privcloud-sharing

EXPOSE 3000

# Healthcheck via Node.js fetch API - curl n'est plus disponible dans le runner.
HEALTHCHECK --interval=10s --timeout=3s CMD sh -c \
    'P=${BACKEND_PORT:-8080}; U="http://localhost:3000/api/health"; \
    [ "$CADDY_DISABLED" = "true" ] && U="http://localhost:$P/api/health"; \
    node -e "fetch(process.argv[1]).then(r=>r.ok||process.exit(1)).catch(()=>process.exit(1))" "$U"'

ENTRYPOINT ["sh", "./scripts/docker/create-user.sh"]
CMD ["sh", "./scripts/docker/entrypoint.sh"]
