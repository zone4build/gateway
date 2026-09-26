FROM node:20-slim AS base

FROM base AS deps
WORKDIR /app
COPY package*.json ./
RUN npm install --production --ignore-scripts

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 --gid 1001 nodeuser

# Copy dependencies from deps stage
COPY --chown=nodeuser:nodejs --from=deps /app/node_modules ./node_modules
# Copy source code
COPY --chown=nodeuser:nodejs . .

USER nodeuser
EXPOSE 4000
ENV PORT=4000

CMD ["node", "server.js"]
