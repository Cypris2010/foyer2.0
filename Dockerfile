# Foyer: server + admin + player in one image (KONZEPT 4).
#
#   docker build -t foyer .
#
# With NDI live input (separate, self-built ffmpeg; see deploy/ffmpeg-ndi/build.sh):
#
#   docker build --build-arg FOYER_NDI=1 --build-arg NDI_LICENSE=accept -t foyer .
#
# An image built with FOYER_NDI=1 contains the proprietary NDI SDK and a nonfree ffmpeg:
# use it on your own server, never push it to a public registry.

ARG FOYER_NDI=0

# --- app ---------------------------------------------------------------------
FROM node:24-bookworm-slim AS app
WORKDIR /app
COPY . .
RUN npm ci && npm run build && npm prune --omit=dev

# --- optional ffmpeg with NDI ----------------------------------------------------
FROM debian:bookworm-slim AS ndi-1
ARG NDI_LICENSE
COPY deploy/ffmpeg-ndi/build.sh /tmp/build.sh
RUN NDI_LICENSE="$NDI_LICENSE" /tmp/build.sh

FROM debian:bookworm-slim AS ndi-0
RUN mkdir -p /opt/ffmpeg-ndi

FROM ndi-${FOYER_NDI} AS ndi

# --- live gateway (MediaMTX, MIT licence) --------------------------------------------
FROM debian:bookworm-slim AS mediamtx
ARG TARGETARCH
ARG MEDIAMTX_VERSION=1.21.2
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/*
RUN set -eu; \
  case "$TARGETARCH" in \
    amd64) arch=linux_amd64; sum=121be6e00397e473a95d83c75f4fcd3819a6af3b0e1a50889cba43ab4fab6a27 ;; \
    arm64) arch=linux_arm64; sum=180a235374a548d9133cdd5e20f5dbd8b01317be1c86e0d7e66df585dc42ed6f ;; \
    *) echo "MediaMTX: Architektur $TARGETARCH nicht vorgesehen" >&2; exit 1 ;; \
  esac; \
  curl -fsSL -o /tmp/mediamtx.tgz "https://github.com/bluenviron/mediamtx/releases/download/v${MEDIAMTX_VERSION}/mediamtx_v${MEDIAMTX_VERSION}_${arch}.tar.gz"; \
  echo "$sum  /tmp/mediamtx.tgz" | sha256sum -c -; \
  mkdir -p /opt/mediamtx; tar -xzf /tmp/mediamtx.tgz -C /opt/mediamtx mediamtx LICENSE

# --- runtime -----------------------------------------------------------------------
FROM node:24-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg libavahi-client3 \
  && rm -rf /var/lib/apt/lists/*
COPY --from=mediamtx /opt/mediamtx /opt/mediamtx
COPY --from=ndi /opt/ffmpeg-ndi /opt/ffmpeg-ndi
COPY --from=app --chown=node:node /app /app
WORKDIR /app
ENV FOYER_HOST=0.0.0.0 \
    FOYER_PORT=8080 \
    FOYER_DATA_DIR=/data
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
# 8189 UDP/TCP: WebRTC media of live slides, must be reachable from the displays.
EXPOSE 8080 8189/udp 8189/tcp
CMD ["node", "apps/server/src/index.ts"]
