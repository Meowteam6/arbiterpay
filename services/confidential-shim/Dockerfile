# Confidential attester shim. node:22-slim plus poppler-utils (pdftoppm and
# pdftotext for the PDF evidence path) and snpguest (AMD SEV-SNP attestation
# report + certificate fetch, Tier A). Built artifacts only; dev deps pruned.

FROM node:22-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends poppler-utils ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

# snpguest: pinned release + sha256 so the attestation tooling is
# reproducible. static-pie linked, so it needs no runtime libs. Fetches the
# SEV-SNP report from /dev/sev-guest and the VCEK/ASK/ARK chain.
ARG SNPGUEST_VERSION=v0.10.0
ARG SNPGUEST_SHA256=70e700465e3523e67dd5104583dc36cd11eef630c6f04c5b9ccafd6ba2e76ca0
RUN curl -fsSL -o /usr/local/bin/snpguest \
      "https://github.com/virtee/snpguest/releases/download/${SNPGUEST_VERSION}/snpguest" \
    && echo "${SNPGUEST_SHA256}  /usr/local/bin/snpguest" | sha256sum -c - \
    && chmod +x /usr/local/bin/snpguest

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

ENV NODE_ENV=production
EXPOSE 8080

CMD ["node", "dist/index.js"]
