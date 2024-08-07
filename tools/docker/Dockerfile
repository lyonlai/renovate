# syntax=docker/dockerfile:1.9.0@sha256:fe40cf4e92cd0c467be2cfc30657a680ae2398318afd50b0c80585784c604f28

ARG BASE_IMAGE_TYPE=slim

# --------------------------------------
# slim image
# --------------------------------------
FROM ghcr.io/renovatebot/base-image:2.28.1@sha256:c87903de86aa290a22ea0a0e068398117c9d5b54fc3353bd1599d4ea5b9ab583 AS slim-base

# --------------------------------------
# full image
# --------------------------------------
FROM ghcr.io/renovatebot/base-image:2.28.1-full@sha256:80f23a28005b54c676e40b21548146c91e670ed6c65f1842af2c63be41667b91 AS full-base

# --------------------------------------
# build image
# --------------------------------------
FROM --platform=$BUILDPLATFORM ghcr.io/renovatebot/base-image:2.28.1@sha256:c87903de86aa290a22ea0a0e068398117c9d5b54fc3353bd1599d4ea5b9ab583 AS build

# We want a specific node version here
# renovate: datasource=node-version
RUN install-tool node 20.15.1

WORKDIR /usr/local/renovate

ARG TARGETPLATFORM
ARG TARGETARCH
ARG BUILDPLATFORM

RUN set -ex; \
  echo "I am running on $BUILDPLATFORM, building for $TARGETPLATFORM"; \
  uname -a; \
  true

# replace `amd64` with `x86_64` for `node`
ENV ARCH=${TARGETARCH/amd64/x86_64}
ENV ARCH=${ARCH/arm64/aarch64}

# fetch static node binary
RUN set -ex; \
  ver=$(node --version); ver=${ver:1} \
  temp_dir="$(mktemp -d)"; \
  curl -fsSL "https://github.com/containerbase/node-prebuild/releases/download/${ver}/node-${ver}-${ARCH}.tar.xz" -o ${temp_dir}/node.tar.xz; \
  bsdtar --strip 1 -C ${temp_dir} -xf ${temp_dir}/node.tar.xz; \
  cp ${temp_dir}/bin/node ./node; \
  true

# fetch npm packages
ENV CI=1 npm_config_modules_cache_max_age=0 \
  npm_config_loglevel=info


# replace `amd64` with `x64` for `node`
ENV ARCH=${TARGETARCH/amd64/x64}

COPY --link pnpm-lock.yaml ./

# set `npm_config_arch` for `prebuild-install`
# set `npm_config_platform_arch` for `install-artifact-from-github`
# only fetch deps from lockfile https://pnpm.io/cli/fetch
RUN set -ex; \
  export npm_config_arch=${ARCH} npm_config_platform_arch=${ARCH}; \
  corepack pnpm fetch --prod; \
  true

COPY --link . ./

# install npm packages
RUN set -ex; \
  corepack pnpm install --prod --offline --ignore-scripts; \
  true

# --------------------------------------
# final image
# --------------------------------------
FROM ${BASE_IMAGE_TYPE}-base

LABEL name="renovate"
LABEL org.opencontainers.image.source="https://github.com/renovatebot/renovate" \
  org.opencontainers.image.url="https://renovatebot.com" \
  org.opencontainers.image.licenses="AGPL-3.0-only"

WORKDIR /usr/src/app

COPY tools/docker/bin/ /usr/local/bin/
CMD ["renovate"]

ARG RENOVATE_VERSION

COPY --link --from=build --chown=root:root /usr/local/renovate/ /usr/local/renovate/

# Compabillity, so `config.js` can access renovate and deps
RUN set -ex; \
  mkdir /opt/containerbase/tools/renovate; \
  echo "${RENOVATE_VERSION}" > /opt/containerbase/versions/renovate; \
  ln -sf /usr/local/renovate /opt/containerbase/tools/renovate/${RENOVATE_VERSION}; \
  ln -sf /usr/local/renovate/node_modules ./node_modules; \
  true

RUN set -ex; \
  renovate --version; \
  /usr/local/renovate/node -e "new require('re2')('.*').exec('test');new require('better-sqlite3')(':memory:')"; \
  true

LABEL \
  org.opencontainers.image.version="${RENOVATE_VERSION}" \
  org.label-schema.version="${RENOVATE_VERSION}"

# Numeric user ID for the ubuntu user. Used to indicate a non-root user to OpenShift
USER 1000
