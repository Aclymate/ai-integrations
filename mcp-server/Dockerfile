FROM node:20-alpine AS deps
WORKDIR /app
ARG NPM_PUBLISH_TOKEN
COPY package*.json ./
RUN printf "//registry.npmjs.org/:_authToken=%s\n" "$NPM_PUBLISH_TOKEN" > .npmrc && \
    npm ci --omit=dev && \
    rm -f .npmrc

FROM node:20-alpine
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package*.json ./
COPY src/ ./src/
ENV PORT=8080
CMD ["node", "src/server.js"]
