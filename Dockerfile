# Build stage: install everything and compile the React app.
FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

# Runtime stage: only what the Express server needs.
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json server.ts ./
COPY server ./server
COPY src/shared ./src/shared
USER node
# Cloud Run provides PORT; server.ts listens on it.
CMD ["npm", "start"]
