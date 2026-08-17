FROM node:22-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV ASC_HTTP_HOST=0.0.0.0
ENV ASC_UPLOAD_ROOT=/data/uploads
ENV ASC_DOWNLOAD_ROOT=/data/downloads
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/build ./build
COPY data ./data
COPY skills ./skills
COPY README.md LICENSE ./
RUN mkdir -p /data/uploads /data/downloads && chown -R node:node /data

USER node
EXPOSE 3000
CMD ["node", "build/http.js"]
