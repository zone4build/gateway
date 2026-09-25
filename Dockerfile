FROM node:18-alpine

WORKDIR /app

# Copy package files
COPY packages/gateway/package*.json ./

# Install dependencies
RUN npm install

# Copy config-client
COPY packages/config-client ./config-client
RUN cd config-client && npm install --production

# Copy gateway
COPY packages/gateway ./gateway
RUN cd gateway && npm install

WORKDIR /app/gateway

# Expose port
EXPOSE 4000

# Start server
CMD ["node", "server.js"]
