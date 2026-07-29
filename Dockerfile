FROM node:20-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate

WORKDIR /app

# Copy monorepo configuration and lockfile
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* turbo.json tsconfig.base.json start.sh ./
COPY packages/ ./packages/
COPY apps/ ./apps/
COPY templates/ ./templates/

# Install dependencies and build monorepo packages
RUN pnpm install --no-frozen-lockfile
RUN pnpm run build
RUN chmod +x start.sh

# Expose default ports
EXPOSE 4000 4001 4002 3000 8080

CMD ["/app/start.sh"]
