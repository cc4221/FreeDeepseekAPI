FROM node:20-alpine

WORKDIR /app

# Copy source files
COPY package.json ./
COPY server.js ./
COPY client.js ./
COPY scripts/ ./scripts/
COPY chrome-extension/ ./chrome-extension/
COPY docs/ ./docs/
COPY tests/ ./tests/
COPY LICENSE ./
COPY auth.example.json ./

# Create directory for persistent auth data and fix ownership for non-root user
RUN mkdir -p /app/data && chown -R node:node /app/data

# Environment defaults
ENV PORT=9655
ENV HOST=0.0.0.0
ENV DEEPSEEK_AUTH_DIR=/app/data
ENV SESSIONS_CACHE_PATH=/app/sessions-cache.json
ENV NON_INTERACTIVE=1

# Switch to non-root user for security
USER node

EXPOSE 9655

# Health check
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost:${PORT}/health || exit 1

ENTRYPOINT ["node", "server.js"]
