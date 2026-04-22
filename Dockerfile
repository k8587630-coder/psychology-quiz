FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY prisma ./prisma
RUN npx prisma generate
COPY . .
EXPOSE 4056
CMD ["sh", "-c", "npx prisma migrate deploy && node server.js"]
