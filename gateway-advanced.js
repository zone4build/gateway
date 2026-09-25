/**
 * Zone4Build API Gateway (Advanced)
 *
 * ✨ Features:
 * - Fastify-based reverse proxy
 * - Dynamic config from config-api with hot-reload
 * - License-based feature gating (FREE/PRO/ENTERPRISE)
 * - Redis-based rate limiting (synchronized across pods)
 * - Multi-tenant request routing
 * - WebSocket support for Singulary IDE agents
 * - Full audit logging
 *
 * Architecture:
 * NGINX Ingress → Fastify Gateway → Microservices
 */

const fastify = require('fastify')({ logger: true });
const httpProxy = require('@fastify/http-proxy');
const cors = require('@fastify/cors');
const helmet = require('@fastify/helmet');
const rateLimit = require('@fastify/rate-limit');
const redis = require('redis');
const ConfigClient = require('../config-client');

// ═══════════════════════════════════════════════════════════════════
// 🚀 INITIALIZATION
// ═══════════════════════════════════════════════════════════════════

const PORT = process.env.GATEWAY_PORT || 8080;
const HOST = process.env.GATEWAY_HOST || '0.0.0.0';
const NODE_ENV = process.env.NODE_ENV || 'development';

// Redis for rate limiting state
const redisClient = redis.createClient({
  host: process.env.REDIS_HOST || 'localhost',
  port: process.env.REDIS_PORT || 6379,
});

let gatewayConfig = null;
let licenseState = null;

// ═══════════════════════════════════════════════════════════════════
// 🔐 LICENSE TIER CAPABILITIES
// ═══════════════════════════════════════════════════════════════════

const TIER_CAPABILITIES = {
  'FREE': {
    maxRequestsPerMinute: 100,
    allowedEndpoints: ['/auth', '/doc', '/generic/basic'],
    allowWebSocket: false
  },
  'STARTER': {
    maxRequestsPerMinute: 1000,
    allowedEndpoints: ['/auth', '/doc', '/generic', '/commerce/basic'],
    allowWebSocket: false
  },
  'PRO': {
    maxRequestsPerMinute: 10000,
    allowedEndpoints: ['/auth', '/doc', '/generic', '/commerce', '/ai'],
    allowWebSocket: true
  },
  'ENTERPRISE': {
    maxRequestsPerMinute: 100000,
    allowedEndpoints: ['*'],
    allowWebSocket: true
  }
};

// ═══════════════════════════════════════════════════════════════════
// 📋 STARTUP SEQUENCE
// ═══════════════════════════════════════════════════════════════════

async function startup() {
  try {
    console.log('🚀 [GATEWAY] Starting Zone4Build API Gateway...');

    // 1️⃣ Register security middleware
    await fastify.register(helmet, {
      contentSecurityPolicy: false,
      hsts: { maxAge: 31536000, includeSubDomains: true }
    });

    // 2️⃣ Register CORS
    await fastify.register(cors, {
      origin: (process.env.ALLOWED_ORIGINS || '*').split(','),
      credentials: true
    });

    // 3️⃣ Initialize ConfigClient (blocks until config loaded)
    console.log('📡 [GATEWAY] Fetching configuration from config-api...');
    const configToken = process.env.CONFIG_API_TOKEN;
    if (!configToken) {
      throw new Error('CONFIG_API_TOKEN environment variable required');
    }

    gatewayConfig = await ConfigClient.initialize({
      serviceName: 'gateway',
      env: NODE_ENV,
      configApiHost: process.env.CONFIG_API_HOST || 'localhost',
      configApiPort: process.env.CONFIG_API_PORT || 3009,
      token: configToken
    });

    console.log('✅ [GATEWAY] Configuration loaded successfully');

    // Extract license state
    licenseState = gatewayConfig.SYSTEM || { LICENSE_TIER: 'FREE', LICENSE_VALID: false };
    console.log(`🔐 [GATEWAY] License Tier: ${licenseState.LICENSE_TIER}`);

    // 4️⃣ Setup rate limiting with Redis
    if (redisClient.isOpen || await redisClient.connect()) {
      console.log('🔴 [GATEWAY] Redis connected for rate limiting');

      const tierCapabilities = TIER_CAPABILITIES[licenseState.LICENSE_TIER] || TIER_CAPABILITIES.FREE;

      await fastify.register(rateLimit, {
        max: tierCapabilities.maxRequestsPerMinute,
        timeWindow: '1 minute',
        cache: redisClient,
        allowList: ['/health', '/ready', '/version']
      });

      console.log(`⚙️  [GATEWAY] Rate limit: ${tierCapabilities.maxRequestsPerMinute} req/min`);
    } else {
      console.warn('⚠️  [GATEWAY] Redis connection failed, rate limiting disabled');
    }

    // 5️⃣ License enforcement middleware
    fastify.addHook('preHandler', async (request, reply) => {
      const path = request.url.split('?')[0]; // Remove query params
      const tierCapabilities = TIER_CAPABILITIES[licenseState.LICENSE_TIER] || TIER_CAPABILITIES.FREE;

      // Check if endpoint is allowed for this tier
      if (tierCapabilities.allowedEndpoints !== '*') {
        const allowed = tierCapabilities.allowedEndpoints.some(endpoint =>
          path === endpoint || path.startsWith(endpoint + '/')
        );

        if (!allowed) {
          console.warn(`🚫 [GATEWAY] Access denied for ${path} on tier ${licenseState.LICENSE_TIER}`);
          return reply.code(403).send({
            error: 'Forbidden',
            message: `Endpoint ${path} requires ${licenseState.LICENSE_TIER === 'FREE' ? 'PRO' : 'ENTERPRISE'} tier`,
            license: licenseState
          });
        }
      }

      // Check WebSocket requirements
      if (request.headers.upgrade === 'websocket' && !tierCapabilities.allowWebSocket) {
        console.warn(`🚫 [GATEWAY] WebSocket denied for tier ${licenseState.LICENSE_TIER}`);
        return reply.code(403).send({
          error: 'Forbidden',
          message: 'WebSocket connections require PRO or ENTERPRISE tier'
        });
      }

      // Inject tenant context
      request.tenantId = request.headers['x-tenant-id'] || 'default';
      request.correlationId = request.headers['x-correlation-id'] || `gateway-${Date.now()}`;
    });

    // 6️⃣ Setup proxy routes from config
    await setupProxyRoutes();

    // 7️⃣ Health/status endpoints
    fastify.get('/health', async () => {
      return {
        status: 'ok',
        service: 'zone4build-gateway',
        licenseTier: licenseState.LICENSE_TIER,
        uptime: process.uptime()
      };
    });

    fastify.get('/ready', async () => {
      return { status: 'ready' };
    });

    fastify.get('/version', async () => {
      const pkg = require('./package.json');
      return { version: pkg.version };
    });

    // 8️⃣ Listen for config updates
    ConfigClient.on('updated', async (newConfig) => {
      console.log('🔄 [GATEWAY] Configuration updated, reloading...');
      gatewayConfig = newConfig;
      licenseState = newConfig.SYSTEM || { LICENSE_TIER: 'FREE', LICENSE_VALID: false };
      console.log(`🔐 [GATEWAY] License Tier updated: ${licenseState.LICENSE_TIER}`);
    });

    // Start server
    await fastify.listen({ port: PORT, host: HOST });
    console.log(`🌐 [GATEWAY] Listening on ${HOST}:${PORT}`);
    console.log(`📚 [GATEWAY] License: ${licenseState.LICENSE_TIER}`);
    console.log('✅ [GATEWAY] Ready to serve requests');

  } catch (err) {
    console.error('❌ [GATEWAY] Startup failed:', err.message);
    process.exit(1);
  }
}

// ═══════════════════════════════════════════════════════════════════
// 🔀 PROXY ROUTE SETUP
// ═══════════════════════════════════════════════════════════════════

async function setupProxyRoutes() {
  const routes = gatewayConfig.ROUTES || [
    { prefix: '/auth',         target: 'http://auth-api:3000' },
    { prefix: '/generic',      target: 'http://generic-api:3001/api/generic' },
    { prefix: '/doc',          target: 'http://doc-api:3006' },
    { prefix: '/commerce',     target: 'http://commerce-api:3001' },
    { prefix: '/notification', target: 'http://notification-api:3005' },
    { prefix: '/compliance',   target: 'http://compliance-api:3010' },
    { prefix: '/ai',           target: 'http://singulary-api:3000' }
  ];

  // Register proxy for each route
  for (const route of routes) {
    console.log(`  📍 ${route.prefix} → ${route.target}`);

    await fastify.register(httpProxy, {
      upstream: route.target,
      prefix: route.prefix,
      rewritePrefix: '',
      // Preserve important headers
      replyOptions: {
        getUpstream: (request) => route.target,
        preserveHost: true
      },
      // WebSocket support
      websocket: true,
      // Forwarded headers for security
      http2: false
    });
  }

  console.log(`✅ [GATEWAY] ${routes.length} proxy routes registered`);
}

// ═══════════════════════════════════════════════════════════════════
// 🛑 GRACEFUL SHUTDOWN
// ═══════════════════════════════════════════════════════════════════

process.on('SIGTERM', async () => {
  console.log('📍 [GATEWAY] SIGTERM received, graceful shutdown...');
  if (redisClient.isOpen) {
    await redisClient.quit();
  }
  await fastify.close();
  process.exit(0);
});

// ═══════════════════════════════════════════════════════════════════
// 🚀 START
// ═══════════════════════════════════════════════════════════════════

startup().catch(err => {
  console.error('Fatal error during startup:', err);
  process.exit(1);
});

module.exports = fastify;
