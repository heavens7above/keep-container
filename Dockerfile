# Use Node.js LTS with Playwright base
FROM mcr.microsoft.com/playwright:v1.57.0-jammy

# Install additional dependencies
RUN apt-get update && \
    apt-get install -y \
    wget \
    curl \
    gnupg \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --only=production

# Install Playwright browsers (already installed in base image, but ensure)
RUN npx playwright install chromium

# Copy application code
COPY . .

# Create tmp directory
RUN mkdir -p /tmp && chmod 777 /tmp

# Set environment variables
ENV NODE_ENV=production
ENV PORT=8080
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=30s --retries=3 \
    CMD curl -f http://localhost:${PORT}/health || exit 1

EXPOSE 8080

# Run as non-root user (already set in base image)
USER pwuser

CMD ["node", "index.js"]
