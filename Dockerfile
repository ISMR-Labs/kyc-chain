FROM node:22.22.1-bookworm-slim AS compiler
WORKDIR /build
COPY deploy/compiler/package.json deploy/compiler/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY server ./server
COPY contracts ./contracts
COPY scripts ./scripts
RUN npm run compile

FROM node:22.22.1-bookworm-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4310 DATA_DIR=/var/lib/kyc-chain
WORKDIR /app
COPY deploy/package.json deploy/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --chown=node:node server ./server
COPY --chown=node:node contracts ./contracts
COPY --chown=node:node public ./public
COPY --chown=node:node scripts ./scripts
COPY --from=compiler --chown=node:node /build/artifacts/KYCRegistry.json ./artifacts/KYCRegistry.json
USER node
EXPOSE 4310
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 CMD node -e "fetch('http://127.0.0.1:4310/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/index.js"]
