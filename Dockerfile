# syntax=docker/dockerfile:1
FROM node:20-bookworm-slim AS client
WORKDIR /app/client
COPY client/package.json ./
RUN npm install
COPY client/ ./
RUN npm run build

FROM node:20-bookworm-slim AS runtime
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip ffmpeg aria2 ca-certificates curl tini \
 && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
 && chmod a+rx /usr/local/bin/yt-dlp \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY server/package.json server/
RUN cd server && npm install --omit=dev
COPY server/ server/
COPY --from=client /app/client/dist /app/client/dist

ENV NODE_ENV=production
ENV PORT=5050
ENV TMP_DIR=/tmp/neon-ytdl
EXPOSE 5050
ENTRYPOINT ["/usr/bin/tini","--"]
CMD ["node","server/index.js"]
