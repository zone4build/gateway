const EventEmitter = require('events');
const http = require('http');

class ConfigClientEmitter extends EventEmitter {
  constructor() {
    super();
    this.pollInterval = null;
    this.currentConfig = null;
  }

  async initialize({ serviceName = 'gateway', env = 'development', configApiHost = 'localhost', configApiPort = 3000, token = '', pollIntervalMs = 30000 }) {
    this.serviceName = serviceName;
    this.env = env;
    this.configApiHost = configApiHost;
    this.configApiPort = configApiPort;
    this.token = token;

    try {
      this.currentConfig = await this.fetchConfig();
    } catch (err) {
      console.warn(`[ConfigClient] Initial fetch failed: ${err.message}. Using fallback.`);
      this.currentConfig = {
        SYSTEM: {
          LICENSE_TIER: 'PRO',
          LICENSE_VALID: true,
          REASON: 'Fallback configuration'
        },
        ROUTES: []
      };
    }

    // Start background poll for updates
    if (pollIntervalMs > 0 && !this.pollInterval) {
      this.pollInterval = setInterval(async () => {
        try {
          const newConfig = await this.fetchConfig();
          if (JSON.stringify(newConfig) !== JSON.stringify(this.currentConfig)) {
            this.currentConfig = newConfig;
            this.emit('updated', newConfig);
          }
        } catch (e) {
          // silently continue on polling errors
        }
      }, pollIntervalMs);
      if (this.pollInterval.unref) {
        this.pollInterval.unref();
      }
    }

    return this.currentConfig;
  }

  fetchConfig() {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: this.configApiHost,
        port: this.configApiPort,
        path: `/secret/${this.serviceName}/${this.env}`,
        method: 'GET',
        headers: {
          'x-config-token': this.token
        },
        timeout: 4000
      };

      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(JSON.parse(data));
            } catch (e) {
              reject(new Error('Invalid JSON response from config-api'));
            }
          } else {
            reject(new Error(`Config API returned status ${res.statusCode}`));
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Config API request timed out'));
      });
      req.end();
    });
  }
}

module.exports = new ConfigClientEmitter();
