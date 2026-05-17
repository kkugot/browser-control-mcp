FROM node:22-alpine

ARG NPM_REGISTRY=https://registry.npmjs.org/
ARG NPM_STRICT_SSL=true
ARG HTTP_PROXY
ARG HTTPS_PROXY
ARG NO_PROXY

# Set working directory
WORKDIR /app

# Ensure npm can validate registry TLS certificates inside minimal Alpine images
RUN apk add --no-cache ca-certificates && update-ca-certificates

# Copy package files for dependency installation
COPY mcp-server/package*.json ./mcp-server/

# Copy common directory (shared dependency)
COPY common/ ./common/

# Set working directory to mcp-server for installation
WORKDIR /app/mcp-server

# Install dependencies from the committed lockfile without network-only metadata checks.
# NPM_REGISTRY/NPM_STRICT_SSL and standard proxy args let users build behind
# corporate registry proxies or TLS interception.
RUN npm config set registry "$NPM_REGISTRY" \
    && npm config set strict-ssl "$NPM_STRICT_SSL" \
    && if [ -n "$HTTP_PROXY" ]; then npm config set proxy "$HTTP_PROXY"; fi \
    && if [ -n "$HTTPS_PROXY" ]; then npm config set https-proxy "$HTTPS_PROXY"; fi \
    && if [ -n "$NO_PROXY" ]; then npm config set noproxy "$NO_PROXY"; fi \
    && npm ci --no-audit --no-fund \
    && npm config delete registry \
    && npm config delete strict-ssl \
    && npm config delete proxy \
    && npm config delete https-proxy \
    && npm config delete noproxy

# Copy mcp-server source code
COPY mcp-server/ ./

# Build mcp-server
RUN npm run build

# Set default port (EXTENSION_SECRET should be provided at runtime)
ENV EXTENSION_PORT=8089

# Expose port (default WebSocket port for extension communication)
EXPOSE 8089

# Start the MCP server
CMD ["npm", "start"]
