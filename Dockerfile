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

# Create directory for persistent auth data
RUN mkdir -p /app/data

# Environment defaults
ENV PORT=9655
ENV HOST=0.0.0.0
ENV DEEPSEEK_AUTH_DIR=/app/data
ENV NON_INTERACTIVE=1

EXPOSE 9655

# Health check
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost:${PORT}/health || exit 1

ENTRYPOINT ["node", "server.js"]
