# Dockerfile
FROM node:20-alpine AS base

# Crear usuario no root
RUN addgroup -S app && adduser -S app -G app
WORKDIR /app

# Instalar solo deps de producción
COPY package.json ./
RUN npm install --omit=dev
# ...


# Copiar código
COPY server ./server
COPY public ./public

# Variables y puerto
ENV NODE_ENV=production
EXPOSE 3000

# Ejecutar como usuario no root
USER app

# Arrancar servidor
CMD ["node", "server/index.js"]
