FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
COPY prisma ./prisma/
RUN npm ci --only=production
RUN npx prisma generate
COPY . .
EXPOSE 9999
# Prisma Client is generated at build time. Database/schema provisioning is an
# operator step; a bad DATABASE_URL must not stop the web process from booting
# and reporting its status through /api/health.
CMD ["node", "cloud-server.js"]
