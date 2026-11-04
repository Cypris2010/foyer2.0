# Build from the repository root: docker build -f apps/probe/Dockerfile -t foyer-probe .
FROM node:24-alpine
WORKDIR /app
COPY apps/probe ./apps/probe
ENV PORT=8090 PROBE_REPORTS_DIR=/data
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8090
CMD ["node", "apps/probe/server.ts"]
