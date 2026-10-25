# contextbudget as a container image (GHCR).
# The image runs the same bin as the npm package: dist/cli.js.
# Default command is "mcp", so `docker run -i <image>` is a stdio MCP server;
# any other arguments reach the CLI normally.
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

FROM node:20-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER node
ENTRYPOINT ["node", "/app/dist/cli.js"]
CMD ["mcp"]
LABEL org.opencontainers.image.source="https://github.com/CloudCorpRecords/contextbudget" \
      org.opencontainers.image.description="contextbudget: Token budget auditor for agent context: per-file and per-directory token estimates for a repo, the top offenders eating the window, and concrete exclusion advice, against a configurable budget." \
      org.opencontainers.image.licenses="MIT" \
      io.modelcontextprotocol.server.name="io.github.CloudCorpRecords/contextbudget"
