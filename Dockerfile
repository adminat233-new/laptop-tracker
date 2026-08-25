FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
COPY prisma ./prisma/
RUN npm ci --only=production
COPY . .
EXPOSE 9999
CMD ["node", "cloud-server.js"]
