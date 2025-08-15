# Imagen mínima y segura para Node.js
FROM node:20-alpine AS base

# Crea usuario no root
RUN addgroup -S app && adduser -S app -G app

WORKDIR /app

# Instalar solo dependencias de producción
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# Copiar código
COPY server ./server
COPY public ./public

# Variables y puerto
ENV NODE_ENV=production
EXPOSE 3000

# Usar usuario no root
USER app

# Arrancar el server
CMD ["node", "server/index.js"]
