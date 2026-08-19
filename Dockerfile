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

# Datos persistentes (SQLite + casos canalizados). Montar un volumen aquí.
RUN mkdir -p /var/data
ENV DATABASE_URL=file:/var/data/app.db
VOLUME ["/var/data"]

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/src/server.js"]
