FROM node:22-alpine AS base

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server ./server
COPY public ./public

# Los tests se pasan al construir la imagen: si fallan no hay imagen nueva, y el despliegue
# se para sin tocar el contenedor que está funcionando. Los tests no acaban en la imagen final.
FROM base AS tests
COPY test ./test
RUN npm test && touch /app/.tests-ok

FROM base
COPY --from=tests /app/.tests-ok ./.tests-ok

# data/ (cachés de GTFS e histórico JSONL) se monta como volumen desde el host.
RUN mkdir data && chown node:node data
USER node

# Dentro del contenedor escucha en todas las interfaces; quien decide qué se expone es compose.yaml.
ENV HOST=0.0.0.0 PORT=8080
EXPOSE 8080

# Mientras arranca se comprueba cada 5 s (así un despliegue sabe pronto si ha ido bien); después, cada 30 s.
# 10 s de margen: con muchas visitas y el servidor cargando horarios, 5 s daban por caído un servidor vivo.
HEALTHCHECK --interval=30s --timeout=10s --start-period=90s --start-interval=5s \
  CMD wget -qO /dev/null http://127.0.0.1:8080/api/health || exit 1

CMD ["node", "server/main.js"]
