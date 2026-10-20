# syntax=docker/dockerfile:1.7

FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
ENV PORT=3000
WORKDIR /app

# Fixed ids, shared with the web image whose Caddy writes the STARTTLS certificate.
RUN addgroup -S -g 10001 nostrmail && adduser -S -u 10001 -G nostrmail nostrmail

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY migrations ./migrations

USER nostrmail
EXPOSE 3000 2525
CMD ["node", "dist/server.js"]
