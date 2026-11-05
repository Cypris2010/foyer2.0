# Foyer live gateway: MediaMTX + ffmpeg (+ optional NDI) for live slides (KONZEPT 6.5).
# Build from the repository root:
#
#   docker build -f apps/live-gateway/Dockerfile -t foyer-live-gateway .
#
# With NDI live input (separate, self-built ffmpeg; see deploy/ffmpeg-ndi/build.sh):
#
#   docker build -f apps/live-gateway/Dockerfile --build-arg FOYER_NDI=1 --build-arg NDI_LICENSE=accept -t foyer-live-gateway .
#
# An image built with FOYER_NDI=1 contains the proprietary NDI SDK and a nonfree ffmpeg:
# use it on your own server, never push it to a public registry.

ARG FOYER_NDI=0

# --- optional ffmpeg with NDI ----------------------------------------------------
FROM debian:bookworm-slim AS ndi-1
ARG NDI_LICENSE
COPY deploy/ffmpeg-ndi/build.sh /tmp/build.sh
RUN NDI_LICENSE="$NDI_LICENSE" /tmp/build.sh

FROM debian:bookworm-slim AS ndi-0
RUN mkdir -p /opt/ffmpeg-ndi

FROM ndi-${FOYER_NDI} AS ndi

# --- MediaMTX (MIT licence) ------------------------------------------------------------
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
# No npm install: the gateway has no runtime dependencies (type imports are erased).
FROM node:24-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg libavahi-client3 \
  && rm -rf /var/lib/apt/lists/*
COPY --from=mediamtx /opt/mediamtx /opt/mediamtx
COPY --from=ndi /opt/ffmpeg-ndi /opt/ffmpeg-ndi
COPY apps/live-gateway/package.json /app/package.json
COPY apps/live-gateway/src /app/src
WORKDIR /app
ENV FOYER_GATEWAY_HOST=0.0.0.0 \
    FOYER_GATEWAY_PORT=8190 \
    FOYER_GATEWAY_DIR=/tmp/foyer-live-gateway
USER node
# 8190 TCP: API for the Foyer server (shared key). 8189 UDP/TCP: WebRTC media, must be reachable from the displays.
EXPOSE 8190 8189/udp 8189/tcp
CMD ["node", "src/index.ts"]
