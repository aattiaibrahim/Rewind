# Rewind Server: Node (no npm dependencies) + ffmpeg on Alpine.
FROM node:22-alpine

# ffmpeg: thumbnails, probing and the H.264 phone version (libx264, AV1/HEVC decoders).
# tzdata: clip times from file names are local; set TZ so fallbacks match.
RUN apk add --no-cache ffmpeg tzdata

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts

ENV NODE_ENV=production \
    CLIPS_DIR=/clips \
    CACHE_DIR=/cache \
    PORT=8420

# Run as the unprivileged "node" user (uid 1000). Override with `user:` in compose
# to match the owner of your dataset (TrueNAS "apps" user is 568).
# World-writable so a new named volume works whatever `user:` the app runs as.
RUN mkdir -p /cache && chown node:node /cache && chmod 1777 /cache
USER node

EXPOSE 8420
VOLUME ["/cache"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" >/dev/null || exit 1

CMD ["node", "src/main.js"]
