FROM node:22.19.0-alpine AS build

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
RUN npm install --global pnpm@11.10.0 \
    && pnpm install --frozen-lockfile

# Vite inlines VITE_* at build time, so they must arrive as build args
# (e.g. docker build --build-arg VITE_GOOGLE_CLIENT_ID=...).
ARG VITE_GONVEX_WS_URL=wss://gonvex.whagons.com/ws
ARG VITE_GONVEX_PROJECT_ID=01f1974b-dcda-6fc3-b16d-9acf5f3b4192
ARG VITE_GOOGLE_CLIENT_ID=
ENV VITE_GONVEX_WS_URL=$VITE_GONVEX_WS_URL \
    VITE_GONVEX_PROJECT_ID=$VITE_GONVEX_PROJECT_ID \
    VITE_GOOGLE_CLIENT_ID=$VITE_GOOGLE_CLIENT_ID

COPY . .
RUN pnpm build

FROM nginx:1.27-alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80
