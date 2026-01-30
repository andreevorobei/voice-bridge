FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY tsconfig.json ./
COPY index.ts ./
RUN npm run build

EXPOSE 8080

CMD ["npm", "start"]
