FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY api ./api
COPY scripts ./scripts
COPY db ./db
COPY web ./web
COPY .env.example ./

EXPOSE 3000

CMD ["node", "api/server.js"]