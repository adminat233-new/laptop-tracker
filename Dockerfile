FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
COPY prisma ./prisma/
RUN npm ci --only=production
RUN npx prisma generate
COPY . .
EXPOSE 9999
CMD ["sh", "-c", "npx prisma db push --skip-generate --accept-data-loss && node cloud-server.js"]
