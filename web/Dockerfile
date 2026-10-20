# syntax=docker/dockerfile:1.7

FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY astro.config.mjs tsconfig.json ./
COPY public ./public
COPY src ./src
RUN npm run build

FROM caddy:2-alpine
# Caddy writes its certificates readable by their owner only, and the server
# reads them for STARTTLS: both run as 10001.
RUN chown -R 10001:10001 /data /config
USER 10001:10001
COPY --from=build /app/dist /srv
