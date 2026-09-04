# syntax=docker/dockerfile:1

# ---------------------------------------------------------------- deps
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# --------------------------------------------------------------- build
FROM node:22-alpine AS build
WORKDIR /app
ENV DOCKER_BUILD=true
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# No database or secrets are needed at build time: the database connection and
# the encryption key are both resolved lazily, on first use.
RUN npm run build && npm run build:scripts

# ---------------------------------------------------------------- run
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN addgroup -g 1001 -S nodejs && adduser -S -u 1001 -G nodejs nextjs

# Standalone output carries only the modules the server actually needs.
COPY --from=build --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=build --chown=nextjs:nodejs /app/public ./public

# The migration/admin/worker scripts are pre-bundled to self-contained
# JavaScript, so the runtime image needs no TypeScript toolchain.
COPY --from=build --chown=nextjs:nodejs /app/dist-scripts ./dist-scripts
COPY --from=build --chown=nextjs:nodejs /app/drizzle ./drizzle
COPY --chown=nextjs:nodejs docker-entrypoint.sh ./

USER nextjs
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:3000/login').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["./docker-entrypoint.sh"]
