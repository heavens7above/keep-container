FROM mcr.microsoft.com/playwright:v1.57.0-jammy

WORKDIR /app

COPY package*.json ./

RUN npm install --only=production

RUN npx playwright install chromium

COPY . .

RUN mkdir -p /tmp && chmod 777 /tmp

ENV NODE_ENV=production
ENV PORT=8080
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

HEALTHCHECK --interval=30s --timeout=3s --start-period=30s --retries=3 \
    CMD curl -f http://localhost:${PORT}/health || exit 1

EXPOSE 8080

USER pwuser

CMD ["node", "index.js"]
