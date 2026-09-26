/**
 * Zone4Build API Gateway (Fastify + Config-Client)
 *
 * ✨ Features:
 * - Fastify reverse proxy with hot-reload config
 * - License-based feature gating (FREE/PRO/ENTERPRISE)
 * - Redis-backed rate limiting (synchronized across pods)
 * - Multi-tenant request routing via x-tenant-id
 * - WebSocket support for real-time features (Singulary IDE)
 * - Dynamic route configuration from config-api
 *
 * Architecture:
 * Client → NGINX Ingress → Fastify Gateway → Microservices
 */

require('dotenv').config();

const fastify = require('fastify')({ logger: true });
const httpProxy = require('@fastify/http-proxy');
const cors = require('@fastify/cors');
const helmet = require('@fastify/helmet');
const rateLimit = require('@fastify/rate-limit');
const Redis = require('ioredis');
let ConfigClient;
try {
  ConfigClient = require('./config-client');
} catch (e) {
  ConfigClient = require('../config-client');
}

// ═══════════════════════════════════════════════════════════════════
// ⚙️ CONFIGURATION
// ═══════════════════════════════════════════════════════════════════

const PORT = process.env.GATEWAY_PORT || 4000;
const HOST = process.env.GATEWAY_HOST || '0.0.0.0';
const NODE_ENV = process.env.NODE_ENV || 'development';

// Redis client for rate limiting
const redisClient = new Redis(`redis://${process.env.REDIS_HOST || 'localhost'}:${process.env.REDIS_PORT || 6379}`);

// In-memory config and license state
let gatewayConfig = null;
let licenseState = {
  LICENSE_TIER: 'FREE',
  LICENSE_VALID: false,
  REASON: 'Not initialized'
};

// ═══════════════════════════════════════════════════════════════════
// 🔐 LICENSE TIER CONFIGURATION
// ═══════════════════════════════════════════════════════════════════

const LICENSE_TIERS = {
  FREE: {
    maxRequestsPerMinute: 100,
    allowedPrefixes: ['/auth', '/doc/public'],
    allowWebSocket: false,
    description: 'Free tier - limited access'
  },
  STARTER: {
    maxRequestsPerMinute: 1000,
    allowedPrefixes: ['/auth', '/doc', '/generic/basic'],
    allowWebSocket: false,
    description: 'Starter tier - basic access'
  },
  PRO: {
    maxRequestsPerMinute: 10000,
    allowedPrefixes: ['/auth', '/doc', '/generic', '/commerce', '/ai'],
    allowWebSocket: true,
    description: 'Pro tier - full access'
  },
  ENTERPRISE: {
    maxRequestsPerMinute: 100000,
    allowedPrefixes: ['*'],
    allowWebSocket: true,
    description: 'Enterprise tier - unlimited'
  }
};

// ═══════════════════════════════════════════════════════════════════
// 🚀 STARTUP SEQUENCE
// ═══════════════════════════════════════════════════════════════════

async function startup() {
  try {
    console.log('🚀 [GATEWAY] Starting Zone4Build API Gateway (Fastify)...');

    // 1️⃣ Register security middleware
    await fastify.register(helmet, {
      contentSecurityPolicy: false,
      hsts: { maxAge: 31536000, includeSubDomains: true }
    });
    console.log('✅ [GATEWAY] Helmet security headers registered');

    // 2️⃣ Register CORS
    const allowedOrigins = (process.env.ALLOWED_ORIGINS || '*').split(',');
    await fastify.register(cors, {
      origin: allowedOrigins.map(o => o.trim()),
      credentials: true
    });
    console.log(`✅ [GATEWAY] CORS enabled for: ${allowedOrigins.join(', ')}`);

    // 3️⃣ Initialize ConfigClient (with timeout for dev mode)
    console.log('📡 [GATEWAY] Fetching configuration from config-api...');
    const configToken = process.env.CONFIG_API_TOKEN;
    if (!configToken) {
      throw new Error('CONFIG_API_TOKEN environment variable is required');
    }

    try {
      // Set 5-second timeout for config fetch
      const configPromise = ConfigClient.initialize({
        serviceName: 'gateway',
        env: NODE_ENV,
        configApiHost: process.env.CONFIG_API_HOST || 'localhost',
        configApiPort: process.env.CONFIG_API_PORT || 3009,
        token: configToken
      });

      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Config API timeout')), 5000)
      );

      gatewayConfig = await Promise.race([configPromise, timeoutPromise]);
      console.log('✅ [GATEWAY] Configuration loaded from config-api');
    } catch (err) {
      if (NODE_ENV === 'development') {
        console.warn(`⚠️  [GATEWAY] Config API unavailable in dev mode: ${err.message}`);
        console.log('📋 [GATEWAY] Using default development configuration...');

        // Use sensible defaults for local development
        gatewayConfig = {
          SYSTEM: {
            LICENSE_TIER: 'PRO',
            LICENSE_VALID: true,
            REASON: 'Development mode default'
          },
          ROUTES: []  // Use fallback routes in setupProxyRoutes()
        };
      } else {
        throw err;
      }
    }

    // Extract license state
    licenseState = gatewayConfig.SYSTEM || {
      LICENSE_TIER: 'FREE',
      LICENSE_VALID: false,
      REASON: 'Default to FREE if not configured'
    };

    console.log(`🔐 [GATEWAY] License Tier: ${licenseState.LICENSE_TIER}`);
    console.log(`🔐 [GATEWAY] License Valid: ${licenseState.LICENSE_VALID}`);

    // 4️⃣ Setup Redis and rate limiting
    // ioredis connects automatically

    const tierConfig = LICENSE_TIERS[licenseState.LICENSE_TIER] || LICENSE_TIERS.FREE;
    console.log(`[DEBUG] tierConfig:`, tierConfig);

    await fastify.register(rateLimit, {
      max: tierConfig.maxRequestsPerMinute,
      timeWindow: '1 minute',
      redis: redisClient,
      allowList: ['/health', '/ready', '/version']
    });

    console.log(`📊 [GATEWAY] Rate limit: ${tierConfig.maxRequestsPerMinute} req/min`);

    // 5️⃣ License enforcement middleware
    fastify.addHook('preHandler', async (request, reply) => {
      const path = request.url.split('?')[0]; // Remove query params

      // Always allow health checks and system endpoints
      if (path === '/health' || path === '/ready' || path === '/version') {
        return;
      }

      const tierConfig = LICENSE_TIERS[licenseState.LICENSE_TIER] || LICENSE_TIERS.FREE;

      // Check if endpoint is allowed for this tier
      if (tierConfig.allowedPrefixes !== '*') {
        const isAllowed = tierConfig.allowedPrefixes.some(prefix =>
          path === prefix || path.startsWith(prefix + '/')
        );

        if (!isAllowed) {
          console.warn(`🚫 [GATEWAY] Access denied for ${path} on ${licenseState.LICENSE_TIER} tier`);
          return reply.code(403).send({
            error: 'Forbidden',
            message: `Endpoint ${path} requires higher license tier`,
            currentTier: licenseState.LICENSE_TIER,
            requiredTier: 'PRO or higher'
          });
        }
      }

      // Check WebSocket requirements
      if (request.headers.upgrade === 'websocket' && !tierConfig.allowWebSocket) {
        console.warn(`🚫 [GATEWAY] WebSocket denied for ${licenseState.LICENSE_TIER} tier`);
        return reply.code(403).send({
          error: 'Forbidden',
          message: 'WebSocket requires PRO or ENTERPRISE tier'
        });
      }

      // Inject tenant context for downstream services
      request.tenantId = request.headers['x-tenant-id'] || 'default';
      request.correlationId = request.headers['x-correlation-id'] || `gateway-${Date.now()}`;
    });

    console.log('✅ [GATEWAY] License enforcement middleware registered');

    // 6️⃣ Setup proxy routes from config
    await setupProxyRoutes();

    // 7️⃣ Health/status endpoints
    fastify.get('/health', async (request, reply) => {
      return {
        status: 'ok',
        service: 'zone4build-gateway',
        version: require('./package.json').version,
        licenseTier: licenseState.LICENSE_TIER,
        uptime: process.uptime()
      };
    });

    fastify.get('/ready', async (request, reply) => {
      return { status: 'ready' };
    });

    fastify.get('/version', async (request, reply) => {
      return { version: require('./package.json').version };
    });

    // 8️⃣ Listen for config updates (hot-reload)
    ConfigClient.on('updated', async (newConfig) => {
      console.log('🔄 [GATEWAY] Configuration updated, reloading...');
      gatewayConfig = newConfig;

      const newLicenseState = newConfig.SYSTEM || licenseState;
      if (newLicenseState.LICENSE_TIER !== licenseState.LICENSE_TIER) {
        console.log(`🔐 [GATEWAY] License Tier changed: ${licenseState.LICENSE_TIER} → ${newLicenseState.LICENSE_TIER}`);
      }

      licenseState = newLicenseState;

      // Update rate limits if changed
      const newTierConfig = LICENSE_TIERS[licenseState.LICENSE_TIER] || LICENSE_TIERS.FREE;
      console.log(`📊 [GATEWAY] Rate limit updated: ${newTierConfig.maxRequestsPerMinute} req/min`);
    });

    // 9️⃣ Start server
    await fastify.listen({ port: PORT, host: HOST });

    console.log(`\n${'═'.repeat(60)}`);
    console.log(`✅ [GATEWAY] Zone4Build API Gateway Ready!`);
    console.log(`${'═'.repeat(60)}`);
    console.log(`🌐 Listening on: ${HOST}:${PORT}`);
    console.log(`🔐 License Tier: ${licenseState.LICENSE_TIER}`);
    console.log(`📊 Rate Limit: ${LICENSE_TIERS[licenseState.LICENSE_TIER].maxRequestsPerMinute} req/min`);
    console.log(`${'═'.repeat(60)}\n`);

  } catch (err) {
    console.error('❌ [GATEWAY] Startup failed:', err.message);
    process.exit(1);
  }
}

// ═══════════════════════════════════════════════════════════════════
// 🔀 SETUP PROXY ROUTES (from config)
// ═══════════════════════════════════════════════════════════════════

async function setupProxyRoutes() {
  // Use routes from config-api or fall back to defaults
  const routes = (gatewayConfig && Array.isArray(gatewayConfig.ROUTES) && gatewayConfig.ROUTES.length > 0)
    ? gatewayConfig.ROUTES
    : [
        { prefix: '/auth',         target: 'http://saas-platform-zone4food-saas-platform-auth-api:3000' },
        { prefix: '/generic',      target: 'http://saas-platform-zone4food-saas-platform-generic-api:3000' },
        { prefix: '/doc',          target: 'http://saas-platform-zone4food-saas-platform-doc-api:3000' },
        { prefix: '/commerce',     target: 'http://saas-platform-zone4food-saas-platform-commerce-api:3000' },
        { prefix: '/notification', target: 'http://saas-platform-zone4food-saas-platform-notification-api:3000' },
        { prefix: '/compliance',   target: 'http://saas-platform-zone4food-saas-platform-compliance-api:3000' },
        { prefix: '/ai',           target: 'http://singulary:3000' }  // Singulary IDE (WebSocket!)
      ];

  console.log('📍 [GATEWAY] Registering proxy routes:');

  for (const route of routes) {
    const isWebSocketRoute = route.prefix === '/ai';  // Singulary needs WebSocket

    await fastify.register(httpProxy, {
      upstream: route.target,
      prefix: route.prefix,
      rewritePrefix: '',
      websocket: isWebSocketRoute,  // Enable WebSocket for /ai
      http2: false
    });

    console.log(`  ✅ ${route.prefix} → ${route.target}${isWebSocketRoute ? ' (WebSocket enabled)' : ''}`);
  }

  console.log(`✅ [GATEWAY] ${routes.length} routes registered`);
}

// ═══════════════════════════════════════════════════════════════════
// 🛑 GRACEFUL SHUTDOWN
// ═══════════════════════════════════════════════════════════════════

process.on('SIGTERM', async () => {
  console.log('\n📍 [GATEWAY] SIGTERM received, graceful shutdown...');

  if (redisClient.isOpen) {
    await redisClient.quit();
    console.log('✅ [GATEWAY] Redis disconnected');
  }

  await fastify.close();
  console.log('✅ [GATEWAY] Fastify server closed');

  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('\n📍 [GATEWAY] SIGINT received, graceful shutdown...');

  if (redisClient.isOpen) {
    await redisClient.quit();
    console.log('✅ [GATEWAY] Redis disconnected');
  }

  await fastify.close();
  console.log('✅ [GATEWAY] Fastify server closed');

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
