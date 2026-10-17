FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data PORT=3000 TRUST_PROXY=true
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
COPY assets ./assets
EXPOSE 3000
CMD ["node", "--disable-warning=ExperimentalWarning", "src/index.ts"]
