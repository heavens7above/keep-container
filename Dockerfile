# Use Node.js LTS as base
FROM node:18-slim

# Install Playwright dependencies and Chrome
RUN apt-get update && \
    apt-get install -y \
    wget \
    gnupg \
    ca-certificates \
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
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    xvfb \
    xdg-utils \
    curl \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# Install Chrome for Playwright
RUN wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | apt-key add - && \
    echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list && \
    apt-get update && \
    apt-get install -y google-chrome-stable --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies (using npm install instead of npm ci)
RUN npm install --only=production && \
    npx playwright install chromium --with-deps

# Copy application code
COPY . .

# Create tmp directory
RUN mkdir -p /tmp && chmod 777 /tmp

# Create non-root user
RUN useradd -m -u 1000 -s /bin/bash appuser && \
    chown -R appuser:appuser /app
USER appuser

# Environment variables
ENV NODE_ENV=production
ENV PORT=8080
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV CHROME_BIN=/usr/bin/google-chrome-stable

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=30s --retries=3 \
    CMD curl -f http://localhost:8080/health || exit 1

EXPOSE 8080

CMD ["node", "index.js"]
