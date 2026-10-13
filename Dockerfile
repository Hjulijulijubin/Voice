# Optional private rendezvous relay for Voice (stores nothing, sees only ciphertext).
#   docker build -t voice-relay .
#   docker run -d -p 7777:7777 voice-relay
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --omit=optional --ignore-scripts && npm cache clean --force
COPY src/server ./src/server
COPY server ./server
EXPOSE 7777
USER node
CMD ["node", "server/index.js"]
