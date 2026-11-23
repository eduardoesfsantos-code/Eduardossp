# ObraPonto: servidor HTTP/API e dois PWAs no mesmo domínio.
FROM node:22-bookworm AS build
WORKDIR /app
COPY obraponto_android/ObraPonto_Servidor_Central/package.json ./
RUN npm install --no-audit --no-fund
COPY obraponto_android/ObraPonto_Servidor_Central/ ./
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3001
COPY --from=build /app /app
EXPOSE 3001
CMD ["node", "server.js"]
