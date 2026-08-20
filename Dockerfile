# Imagen de producción. Sirve para Railway, Fly.io, Cloud Run o cualquier host
# que corra contenedores. Render puede usar el runtime Node nativo (render.yaml)
# o este Dockerfile indistintamente.

FROM node:22-slim AS build
WORKDIR /app

# better-sqlite3 es un módulo nativo: si no hay binario precompilado para esta
# plataforma, necesita toolchain para compilarlo.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build && npm prune --omit=dev


FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# schema.sql no lo emite tsc; el cargador lo busca junto al .js compilado y,
# si no está, cae a src/db/schema.sql. Se copian ambos para no depender del orden.
COPY src/db/schema.sql ./dist/src/db/schema.sql
COPY src/db/schema.sql ./src/db/schema.sql

COPY public ./public
COPY onboarding ./onboarding

# Conocimiento del tenant. La verificación de afirmaciones ("¿manejamos este
# producto?") lo lee de disco: sin él, esa comprobación se queda sin corpus y
# el asistente vuelve a aceptar productos fuera de catálogo.
COPY .cache/knowledge ./.cache/knowledge

# Datos persistentes (SQLite + casos canalizados).
#
# Aquí NO va una instrucción `VOLUME`: Railway la rechaza porque gestiona los
# volúmenes desde su panel (Settings → Volumes → mount path /var/data), y otros
# hosts hacen lo mismo. Basta con que el directorio exista; quien despliegue
# monta el almacenamiento encima.
#
# Sin un volumen montado en /var/data la base es efímera y se borra en cada
# redeploy: el asistente perdería todas las conversaciones.
RUN mkdir -p /var/data
ENV DATABASE_URL=file:/var/data/app.db

EXPOSE 3000

# El healthcheck lo hace la plataforma contra /health (ver railway.json o
# render.yaml). Un HEALTHCHECK propio de Docker se solaparía con el suyo y
# algunos hosts lo ignoran o lo rechazan.

CMD ["node", "dist/src/server.js"]
