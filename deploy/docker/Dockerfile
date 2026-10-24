# claudeproxy + claude code CLI（用于容器内一次性 /login）
FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates curl && rm -rf /var/lib/apt/lists/*
RUN npm install -g @anthropic-ai/claude-code
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY server.mjs ./
COPY deploy/harden-vps.sh /usr/local/bin/harden-vps
RUN chmod +x /usr/local/bin/harden-vps && harden-vps
EXPOSE 8466
CMD ["node", "server.mjs"]
