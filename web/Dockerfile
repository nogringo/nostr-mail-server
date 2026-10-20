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
COPY --from=build /app/dist /srv
