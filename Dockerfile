# Dockerfile — reproducible runtime for the Job Dashboard.
#
# Why the apt-get list looks heavy:
#   - chromium: puppeteer needs a Chrome binary; using the OS-managed one is
#     more reliable than letting puppeteer download its own inside Alpine
#   - libvips42 + dev deps: sharp (used transitively by @xenova/transformers
#     for image preprocessing) wants libvips. Without it, the embeddings
#     pipeline silently falls back to keyword-only — which is exactly the
#     "sharp module not found" error you saw on your Mac
#   - fonts-liberation + libnss3 + libatk*: Chromium runtime requirements
#
# Builds for the platform of whoever runs `docker build` (use --platform on
# Apple Silicon to force linux/arm64 if you want native speed).
FROM node:22-bookworm-slim

# Tell puppeteer to use the system chromium instead of downloading its own.
# We set this BEFORE npm install so the postinstall script (which runs
# `npx puppeteer browsers install chrome`) is a no-op inside the container.
ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    NODE_ENV=production

RUN apt-get update && apt-get install -y --no-install-recommends \
        chromium \
        chromium-common \
        fonts-liberation \
        libasound2 \
        libatk-bridge2.0-0 \
        libatk1.0-0 \
        libcups2 \
        libdbus-1-3 \
        libdrm2 \
        libgbm1 \
        libgtk-3-0 \
        libnspr4 \
        libnss3 \
        libxcomposite1 \
        libxdamage1 \
        libxfixes3 \
        libxkbcommon0 \
        libxrandr2 \
        xdg-utils \
        libvips42 \
        ca-certificates \
        tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Layer cache: copy package files first, then source. Changing source code
# doesn't bust the npm install layer.
COPY package*.json ./

# `npm ci` would be ideal but requires a committed package-lock.json that
# matches package.json exactly. Fall back to `npm install` if ci fails so a
# slightly-out-of-date lockfile doesn't block the build.
RUN npm ci --omit=dev --ignore-scripts || npm install --omit=dev --ignore-scripts

COPY . .

# Strip Mac-specific files that shouldn't be in the image
RUN find . -name '.DS_Store' -delete 2>/dev/null || true

EXPOSE 3000

# tini reaps zombie Chrome processes (puppeteer leaves orphans on crash).
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.js"]
