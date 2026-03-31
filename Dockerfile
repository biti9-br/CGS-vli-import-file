# Stage 1: Build the frontend
FROM node:20-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

# Stage 2: Serve with Express
FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/server.ts ./
COPY --from=builder /app/template ./template
# Se houver outros arquivos necessários no runtime, copie-os aqui
# Exemplo: config.json (se não for usar o template)

# Instala o tsx para rodar o server.ts diretamente
RUN npm install -g tsx

EXPOSE 8080
ENV PORT=8080
ENV NODE_ENV=production

CMD ["tsx", "server.ts"]
