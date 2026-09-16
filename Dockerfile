FROM node:22-alpine AS build
WORKDIR /app
COPY package.json tsconfig.json ./
COPY src ./src
RUN npm install && npm run build

FROM node:22-alpine
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/dist ./dist
ENV NODE_ENV=production
ENV SPENDLIGHT_HOST=0.0.0.0
ENV SPENDLIGHT_PORT=8787
ENV SPENDLIGHT_DB=/data/spendlight.db
VOLUME ["/data"]
EXPOSE 8787
USER node
CMD ["node", "dist/index.js"]
