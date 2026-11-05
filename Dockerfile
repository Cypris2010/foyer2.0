# Foyer: server + admin + player in one image (KONZEPT 4).
#
#   docker build -t foyer .
#
# Live slides need the live gateway (apps/live-gateway/Dockerfile) as a second
# container. This image contains no NDI parts and may be published.

# --- app ---------------------------------------------------------------------
FROM node:24-bookworm-slim AS app
WORKDIR /app
COPY . .
RUN npm ci && npm run build && npm prune --omit=dev

# --- runtime -----------------------------------------------------------------------
FROM node:24-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*
COPY --from=app --chown=node:node /app /app
WORKDIR /app
ENV FOYER_HOST=0.0.0.0 \
    FOYER_PORT=8080 \
    FOYER_DATA_DIR=/data
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8080
CMD ["node", "apps/server/src/index.ts"]
