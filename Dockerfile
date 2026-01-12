# Use Playwright base image with all browsers
FROM mcr.microsoft.com/playwright:v1.57.0-jammy

# Install additional system dependencies
RUN apt-get update && \
    apt-get install -y \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libatspi2.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    xdg-utils \
    wget \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /app

# Set environment variables
ENV NODE_ENV=production
ENV PORT=8080
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Copy package files
COPY package*.json ./

# Install dependencies (clean install, no dev dependencies)
RUN npm ci --only=production

# Copy application code
COPY . .

# Create tmp directory with proper permissions
RUN mkdir -p /tmp && chmod 777 /tmp

# Create non-root user
RUN useradd -m -u 1000 -s /bin/bash appuser
USER appuser

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:8080/health || exit 1

# Expose port
EXPOSE 8080

# Start the application
CMD ["node", "index.js"]
