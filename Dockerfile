FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --production=false

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build

# --- Production stage ---
FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --production && npm cache clean --force

COPY --from=builder /app/dist ./dist

# Build metadata — injected by CI/CD pipeline
ARG BUILD_VERSION=dev
ARG BUILD_COMMIT=dev
ARG BUILD_DATE=unknown
ARG BUILD_EDITION=community
ENV BUILD_VERSION=$BUILD_VERSION
ENV BUILD_COMMIT=$BUILD_COMMIT
ENV BUILD_DATE=$BUILD_DATE
ENV BUILD_EDITION=$BUILD_EDITION

# Non-root user for security
RUN addgroup -g 1001 bluey && adduser -u 1001 -G bluey -s /bin/sh -D bluey
USER bluey

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:8000/health || exit 1

CMD ["node", "dist/main.js"]
