# getxmatch container image.
# Node 24 ships SQLite built in and enabled by default (no flag), so there is
# no native build step and no external database service to run.
FROM node:24-alpine

ENV NODE_ENV=production
WORKDIR /app

# Install production dependencies first (better layer caching).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# App source.
COPY . .

# Runtime data lives here and is mounted as volumes in docker-compose.
# Create the dirs and hand /app to the unprivileged "node" user that the
# base image already provides.
RUN mkdir -p data uploads && chown -R node:node /app
USER node

EXPOSE 3000

# Container-level health check hitting the app's /api/health endpoint.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server.js"]
