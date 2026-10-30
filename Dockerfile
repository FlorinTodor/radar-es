FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server ./server
COPY public ./public

# data/ (cachés de GTFS e histórico JSONL) se monta como volumen desde el host.
RUN mkdir data && chown node:node data
USER node

# Dentro del contenedor escucha en todas las interfaces; quien decide qué se expone es compose.yaml.
ENV HOST=0.0.0.0 PORT=8080
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s \
  CMD wget -qO /dev/null http://127.0.0.1:8080/api/health || exit 1

CMD ["node", "server/main.js"]
