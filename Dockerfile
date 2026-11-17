FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY web/package.json web/package-lock.json web/
RUN cd web && npm ci --no-audit --no-fund
COPY . .
RUN cd web && npm run build
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
CMD ["node", "server/index.ts"]
