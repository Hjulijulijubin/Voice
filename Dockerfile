# Standalone Voice signaling server (no audio/chat/files pass through it).
#   docker build -t voice-server .
#   docker run -p 9987:9987 -e VOICE_PASSWORD=secret -v voice-data:/data voice-server
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --omit=optional --ignore-scripts && npm cache clean --force
COPY src/server ./src/server
COPY server ./server
RUN mkdir -p /data && chown node:node /data
ENV VOICE_STATE_FILE=/data/voice-server.json
VOLUME /data
EXPOSE 9987
USER node
CMD ["node", "server/index.js"]
