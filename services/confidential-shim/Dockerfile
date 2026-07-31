# Confidential attester shim. node:22-slim plus poppler-utils (pdftoppm and
# pdftotext for the PDF evidence path). Built artifacts only; dev deps pruned.

FROM node:22-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends poppler-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

ENV NODE_ENV=production
EXPOSE 8080

CMD ["node", "dist/index.js"]
