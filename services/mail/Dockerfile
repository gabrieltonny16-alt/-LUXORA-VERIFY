FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build --chown=node:node /app/package*.json ./
RUN npm install --omit=dev
COPY --from=build --chown=node:node /app/dist ./dist
USER node
EXPOSE 8788
CMD ["node", "dist/server.js"]
