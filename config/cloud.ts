import type { CloudConfig } from '@stacksjs/types'
import type { CloudConfig as TsCloudConfig } from '@stacksjs/ts-cloud'
import { env } from '@stacksjs/env'

/**
 * UptimeStatus Cloud Configuration
 *
 * Single Hetzner Cloud box (Forge-style, no AWS) running the app, its
 * loopback-only API process, the queue worker, and the scheduler as
 * four systemd services behind ts-cloud's rpx reverse proxy.
 *
 * This file previously carried the stacksjs.com framework website's own
 * production config verbatim (wrong project slug, wrong domains —
 * stacksjs.com/docs/blog/verygoodadblock.org — and AWS-only sections
 * that don't apply to a Hetzner deploy at all) — never customized after
 * `buddy new`. Rewritten for stacksjs/status#1 Phase 9's real e2e
 * deploy verification.
 *
 * Environment variables:
 * - CLOUD_PROVIDER=hetzner
 * - HCLOUD_TOKEN / HCLOUD_LOCATION (apiToken/location fall back to these)
 * - APP_DOMAIN=uptime-status.org
 *
 * @see https://github.com/stacksjs/ts-cloud
 */

// ts-cloud configuration for deployment
export const tsCloud: TsCloudConfig = {
  /**
   * Project configuration
   */
  project: {
    name: 'uptime-status',
    slug: 'uptime-status',
    region: 'us-east-1', // Unused on the Hetzner path — kept for the AWS driver interface.
  },

  // Deploy compute to Hetzner Cloud (apiToken falls back to HCLOUD_TOKEN env).
  cloud: {
    provider: 'hetzner',
  },

  /**
   * Deployment Mode
   *
   * - 'server': Traditional EC2-based deployment (Forge-style)
   * - 'serverless': Container + static site deployment (Vapor-style)
   */
  mode: 'server',

  /**
   * Environment configurations
   * Each environment can have its own settings
   *
   * Note: Deployment mode is automatically determined by your infrastructure configuration.
   * Simply define the resources you need below (functions, servers, storage, etc.) and
   * ts-cloud will deploy them accordingly. You can mix and match any resources.
   */
  environments: {
    production: {
      type: 'production',
      region: 'us-east-1',
      variables: {
        NODE_ENV: 'production',
        LOG_LEVEL: 'info',
      },

      /**
       * Serverless Application (Vapor-style) — optional
       *
       * Deploy one codebase as three AWS Lambda functions sharing one artifact:
       * HTTP (API Gateway v2), a queue worker (SQS, one job per invocation), and
       * a CLI function (EventBridge scheduler + on-demand commands / migrations).
       *
       * Defining `app` opts this environment into the serverless deploy pipeline
       * (`buddy deploy --serverless`). Leave it commented to keep the default
       * server/container deployment. Every option is shown below.
       *
       * @see https://ts-cloud.stacksjs.com/features/serverless
       */
      // app: {
      //   // Runtime + application kind. Common Node versions use the AWS managed
      //   // runtime; Bun and newer Node (e.g. 24) run on a ts-cloud-built
      //   // provided.al2023 custom layer (built once via `buddy cloud` / the
      //   // `serverless:build-{node,bun,php}-layer` ts-cloud CLI commands).
      //   kind: 'node', // 'node' | 'bun' | 'php'
      //   runtimeVersion: '22', // node: 18/20/22 (managed) or 24+ (custom layer); bun: a release
      //   // runtime: 'provided.al2023', // override (usually derived from kind + runtimeVersion)
      //   entry: 'server.ts', // entry exporting { fetch, queue, cli } (node/bun)
      //
      //   // HTTP function.
      //   memory: 1024, // MB
      //   timeout: 28, // seconds (API Gateway v2 caps at 29)
      //   concurrency: undefined, // reserved concurrency, optional
      //   gatewayVersion: 2, // 2 = HTTP API (default), 1 = REST API
      //   warm: 2, // keep N containers warm via scheduled pings
      //
      //   // CLI function (scheduler + commands/migrations).
      //   cliMemory: 1024,
      //   cliTimeout: 900,
      //
      //   // Queue worker.
      //   queues: true, // true = single default queue; or ['emails', { invoices: 10 }]; false = disabled
      //   queueConcurrency: 1000,
      //   queueTimeout: 120,
      //   queueMemory: 1024,
      //   queueTries: 3, // max receives before DLQ
      //
      //   // Scheduler: 'on' | 'off' | 'sub-minute'.
      //   scheduler: 'on',
      //
      //   // Build hooks (local, before packaging) + deploy hooks (remote, via CLI fn).
      //   build: ['bun install', 'bun run build'],
      //   deploy: ['migrate'],
      //
      //   // Persistent mode (Laravel Octane / long-lived server). Lower latency.
      //   octane: false,
      //
      //   // Packaging: 'zip' (default) or 'image' (ECR container, for >250MB apps).
      //   packaging: 'zip',
      //
      //   // Static assets → S3 + CloudFront, exposed as ASSET_URL.
      //   assets: 'public',
      //
      //   // Custom domain + ACM certificate.
      //   domain: 'app.stacksjs.com',
      //   // certificateArn: 'arn:aws:acm:us-east-1:...:certificate/...',
      //
      //   // Managed data (require vpc.subnets — private subnets):
      //   // vpc: { subnets: ['subnet-aaa', 'subnet-bbb'], securityGroups: [] },
      //   // database: { connection: 'aurora-serverless' },
      //   // rdsProxy: true,
      //   cache: { driver: 'dynamodb' }, // 'dynamodb' (zero-NAT default) | 'elasticache'
      //   // storage: { bucket: 'stacks-production-app' },
      //
      //   // Managed WAF in front of the HTTP API.
      //   // firewall: { enabled: true, rateLimit: 2000, rules: ['common', 'sqlInjection'] },
      //
      //   // Env vars + secrets (secrets resolved from Secrets Manager / SSM at deploy).
      //   env: { APP_ENV: 'production' },
      //   // secrets: ['APP_KEY', 'DB_PASSWORD'],
      //
      //   // Ephemeral /tmp size in MB (512–10240).
      //   tmpStorage: 512,
      //
      //   // PHP-only (kind: 'php'):
      //   // phpVersion: '8.3',
      //   // architecture: 'x86_64', // or 'arm64'
      //   // layers: ['arn:aws:lambda:us-east-1:...:layer:tscloud-php-83-x86_64:1'],
      // },
    },
    staging: {
      type: 'staging',
      region: 'us-east-1',
      variables: {
        NODE_ENV: 'staging',
        LOG_LEVEL: 'debug',
      },
    },
    development: {
      type: 'development',
      region: 'us-east-1',
      variables: {
        NODE_ENV: 'development',
        LOG_LEVEL: 'debug',
      },
    },
  },

  /**
   * Infrastructure configuration
   * Define your cloud resources here
   */
  infrastructure: {
    /**
     * Compute Configuration
     *
     * For mode: 'server'
     * Defines the EC2 instances running your Stacks/Bun application.
     * When instances > 1, load balancer is automatically enabled.
     *
     * For mode: 'serverless'
     * These settings are not used. See 'containers' configuration instead.
     *
     * @example Single instance (development/staging)
     * compute: { instances: 1, size: 'micro' }
     *
     * @example Multiple instances with auto-scaling (production)
     * compute: {
     *   instances: 3,
     *   size: 'small',
     *   autoScaling: { min: 2, max: 10, scaleUpThreshold: 70 },
     * }
     *
     * @example Mixed instance fleet for cost optimization
     * compute: {
     *   instances: 3,
     *   fleet: [
     *     { size: 'small', weight: 1 },
     *     { size: 'medium', weight: 2 },
     *     { size: 'small', weight: 1, spot: true },
     *   ],
     *   spotConfig: {
     *     baseCapacity: 1,           // Always keep 1 on-demand
     *     onDemandPercentage: 50,    // 50% on-demand, 50% spot
     *     strategy: 'capacity-optimized',
     *   },
     * }
     */
    compute: {
      instances: 1,
      // 'large' -> Hetzner cx43 (8 vCPU / 16GB RAM, ~$20/mo) — sized for
      // a few hundred monitored sites with periodic HTTP/SSL/DNS checks
      // plus occasional Lighthouse/crawl runs, with headroom so this
      // doesn't need to scale up again soon.
      size: 'large', // Provider-agnostic: 'nano', 'micro', 'small', 'medium', 'large', 'xlarge', '2xlarge'
      disk: {
        size: 40,
        type: 'ssd', // Provider-agnostic: 'standard', 'ssd', 'premium'
        encrypted: true,
      },
      webServer: 'rpx',
      proxy: {
        engine: 'rpx',
        // No domain configured yet (uptime-status.org DNS not wired up)
        // — on-demand TLS needs a resolvable domain to complete the
        // Let's Encrypt HTTP-01 challenge. Re-enable once DNS points
        // uptime-status.org at this box.
        onDemandTls: false,
        onDemandTlsEmail: 'admin@uptime-status.org',
      },
      // Uncomment for auto-scaling:
      // autoScaling: {
      //   min: 1,
      //   max: 5,
      //   scaleUpThreshold: 70,
      //   scaleDownThreshold: 30,
      // },
    },

    /**
     * Jump Box / Bastion Host
     *
     * Provides SSH access to your private cloud resources.
     * Set to `true` for a default t3.micro jump box, or configure options.
     *
     * Connect via: buddy cloud:ssh
     * Or via SSM: aws ssm start-session --target <instance-id>
     */
    // jumpBox: true,
    // jumpBox: {
    //   enabled: true,
    //   size: 'micro',
    //   keyName: 'stacks-production',
    //   allowedCidrs: ['0.0.0.0/0'],
    //   databaseTools: true,
    //   mountEfs: true,
    // },

    /**
     * Container Configuration (for serverless mode only)
     *
     * Defines ECS Fargate containers running your Bun API.
     * Only used when mode: 'serverless'.
     *
     * @example Basic API container
     * containers: {
     *   api: {
     *     cpu: 256,    // 0.25 vCPU
     *     memory: 512, // 512 MB
     *     port: 3000,
     *     healthCheck: '/health',
     *   }
     * }
     *
     * @example Production API with auto-scaling
     * containers: {
     *   api: {
     *     cpu: 512,
     *     memory: 1024,
     *     port: 3000,
     *     desiredCount: 2,
     *     autoScaling: {
     *       min: 2,
     *       max: 10,
     *       targetCpuUtilization: 70,
     *     },
     *   }
     * }
     */
    containers: {
      api: {
        cpu: 512, // 256, 512, 1024, 2048, 4096
        memory: 1024, // Must be compatible with CPU (512 MB - 16 GB)
        port: 3000,
        healthCheck: '/health',
        desiredCount: 2,
        autoScaling: {
          min: 1,
          max: 10,
          targetCpuUtilization: 70,
          targetMemoryUtilization: 80,
        },
      },
    },

    /**
     * Load Balancer / ACM SSL / Route53 DNS / S3 storage — all AWS-only
     * constructs, unused entirely by the Hetzner deploy path
     * (deployToHetzner/runHetznerDeploy in buddy's deploy command reads
     * only infrastructure.compute + sites + hetzner.location/apiToken).
     * Previously left populated with stacksjs.com's real production
     * values (Route53 hosted zone ID included) despite being dead code
     * for this app's deploy target — disabled/emptied rather than left
     * as misleading unused config pointing at infrastructure this app
     * doesn't own.
     */
    loadBalancer: {
      enabled: false,
      type: 'application',
      healthCheck: {
        path: '/health',
        interval: 30,
        healthyThreshold: 2,
        unhealthyThreshold: 5,
      },
    },

    ssl: {
      enabled: false,
      provider: 'letsencrypt',
      domains: env.SSL_DOMAINS?.split(',') || (env.APP_DOMAIN ? [env.APP_DOMAIN] : []),
      redirectHttp: true,
      letsEncrypt: {
        email: env.LETSENCRYPT_EMAIL || 'admin@uptime-status.org',
        staging: false,
        autoRenew: true,
      },
    },

    storage: {},

    /**
     * DNS Configuration
     *
     * uptime-status.org is registered with Porkbun — ts-cloud has native
     * Porkbun DNS support (PORKBUN_API_KEY/PORKBUN_SECRET_KEY env vars,
     * see ~/Code/pantry/.config/cloud.ts for the same provider on the
     * same Hetzner-deploy pattern). Records aren't created automatically
     * until those two env vars are set — until then, point the domain
     * at the server's IP manually from the Porkbun dashboard.
     */
    dns: {
      domain: env.APP_DOMAIN || 'uptime-status.org',
      provider: 'porkbun',
    },

    /**
     * Functions Configuration (optional)
     * Lambda functions for specific serverless workloads
     *
     * Note: Stacks uses Bun-based routing (./routes) for APIs, not Lambda functions.
     * Only add functions here for specific use cases like:
     * - Background job processing
     * - Event-driven tasks
     * - Image processing
     * - Scheduled tasks
     */
    functions: {
      // Example background worker (optional)
      // 'background-worker': {
      //   handler: 'worker.handler',
      //   runtime: 'nodejs20.x',
      //   timeout: 300,
      //   memorySize: 1024,
      // },
    },

    /**
     * Queue Configuration (SQS)
     * Background job processing, event-driven tasks, and scheduled work.
     *
     * Jobs defined in app/Jobs/*.ts are auto-discovered at deploy time
     * and scheduled via EventBridge rules targeting these queues.
     */
    queues: {
      jobs: {
        visibilityTimeout: 120,
        deadLetterQueue: true,
        maxReceiveCount: 3,
      },
      // Uncomment for ordered processing:
      // orders: {
      //   fifo: true,
      //   contentBasedDeduplication: true,
      // },
    },

    /**
     * Database Configuration (optional)
     */
    databases: {
      // Uncomment to add a database
      // 'main': {
      //   engine: 'postgres',
      //   instanceClass: 'db.t3.micro',
      //   storage: 20,
      //   username: 'admin',
      //   password: 'changeme123', // Use AWS Secrets Manager in production
      // },
    },

    /**
     * CDN Configuration
     * CloudFront distribution for global content delivery
     */
    cdn: {
      // Uncomment to enable CloudFront CDN
      // 'frontend': {
      //   origin: 'stacks-production-frontend.s3.us-east-1.amazonaws.com',
      //   customDomain: 'cdn.stacks-js.org',
      // },
    },

    /**
     * Redirects Configuration
     * Domain-level and path-level URL redirects.
     *
     * Domain redirects create S3 redirect buckets.
     * Path redirects create CloudFront Functions.
     */
    // redirects: {
    //   // Redirect these domains to your primary domain
    //   // domains: ['www.stacksjs.com', 'stacks.dev'],
    //   // target: 'stacksjs.com',
    //
    //   // Path-level redirects (source -> target)
    //   // paths: {
    //   //   '/old-page': '/new-page',
    //   //   '/blog/old-post': '/blog/new-post',
    //   // },
    // },

    /**
     * Cache Configuration (ElastiCache)
     * Redis or Memcached for in-memory caching
     */
    // Cache temporarily disabled for initial deployment - enable after stack is stable
    // cache: {
    //   type: 'redis',
    //   nodeType: 'cache.t3.micro',
    //   redis: {
    //     engineVersion: '7.1',
    //     numCacheNodes: 2,
    //     automaticFailoverEnabled: true,
    //     snapshotRetentionLimit: 7,
    //   },
    // },

    /**
     * Email Configuration (SES)
     * Amazon SES for transactional email sending
     *
     * Domain is auto-detected from dns.domain if not specified.
     * DNS records (SPF, DKIM, DMARC) are auto-created when hostedZoneId is available.
     *
     * Note: 'email' is not a valid property on InfrastructureConfig.
     * Uncomment and move to a supported config section when the type supports it.
     */
    // email: {
    //   domain: 'stacksjs.com',
    //   configurationSet: true,
    //   enableDkim: true,
    //   server: {
    //     enabled: true,
    //   },
    // },

    /**
     * Search Configuration (OpenSearch)
     * Full-text search engine powered by OpenSearch
     */
    // search: {
    //   instanceType: 't3.small.search',
    //   instanceCount: 1,
    //   volumeSize: 10,
    //   volumeType: 'gp3',
    //   encryption: {
    //     atRest: true,
    //     nodeToNode: true,
    //   },
    //   autoTune: true,
    // },

    /**
     * File System Configuration (EFS)
     * Elastic File System for shared storage across instances
     */
    // fileSystem: {
    //   shared: {
    //     encrypted: true,
    //     performanceMode: 'generalPurpose',
    //     throughputMode: 'bursting',
    //   },
    // },

    /**
     * AI Configuration (Bedrock)
     * Amazon Bedrock for AI/ML model access
     */
    // ai: {
    //   models: ['anthropic.claude-3-5-sonnet-20241022-v2:0'],
    //   allowStreaming: true,
    //   service: 'ecs', // 'ecs' | 'ec2' | 'lambda'
    // },

    /**
     * Tunnel Configuration
     *
     * Deploy a custom tunnel server for `buddy share`.
     * Only needed if you want your own tunnel domain — localtunnel.dev
     * is the shared Stacks default and requires no deployment.
     *
     * Set enabled: true and provide a custom domain to deploy a
     * dedicated tunnel server via `buddy deploy:tunnel`.
     */
    // tunnel: {
    //   enabled: false,
    //   // domain: 'tunnel.mycompany.com',  // must NOT be localtunnel.dev
    //   // region: 'us-east-1',
    //   // ssl: { enabled: true },
    // },

    /**
     * Monitoring Configuration (optional)
     */
    monitoring: {
      // Uncomment to add alarms
      // alarms: {
      //   'high-cpu': {
      //     metricName: 'CPUUtilization',
      //     namespace: 'AWS/EC2',
      //     threshold: 80,
      //     comparisonOperator: 'GreaterThanThreshold',
      //   },
      // },
    },
  },

  /**
   * Sites Configuration
   *
   * Site kinds (resolved by ts-cloud's `resolveSiteKind`):
   *  - `start` + `port` → server-app, systemd service behind the reverse proxy
   *  - `start`, no `port` → server-app, systemd service with nothing exposed
   *    (background worker/scheduler — no port to open, nothing to route to)
   *  - no `start` (has `root`) → server-static, built locally and shipped to
   *    `/var/www/<siteName>`
   *
   * `main`'s `domain` is intentionally commented out: DNS for
   * uptime-status.org isn't pointed at this box yet (see infrastructure.dns
   * above — no PORKBUN_API_KEY/PORKBUN_SECRET_KEY configured, so ts-cloud
   * won't create the record automatically). Deploying without a domain
   * serves the app directly on the box's public IP (http://<ip>:3000) for
   * e2e verification; uncomment once DNS is confirmed and redeploy to pick
   * up the domain + enable infrastructure.compute.proxy.onDemandTls.
   */
  sites: {
    main: {
      // Ship the repo (source only; node_modules/.git excluded by the packager)
      // and install on the server via preStart, matching the Forge-style deploy.
      root: '.',
      path: '/',
      // domain: env.APP_DOMAIN || 'uptime-status.org',
      start: 'bun storage/framework/core/buddy/src/cli.ts serve',
      port: 3000,
      preStart: ['bun install'],
    },

    // API (bun-router) behind `buddy serve`'s same-origin /api proxy.
    // Intentionally NO `domain`/`path`: ts-cloud's rpx gateway skips
    // domain-less sites, so the service stays loopback-only and is
    // reached exclusively via the :3000 proxy (stacksjs/stacks#1950).
    // Loopback isolation is enforced at the firewall too: the Hetzner
    // deploy strips this port from the provision config
    // (scrubLoopbackSitePortsForFirewall in buddy's deploy command), so
    // ts-cloud never opens :3008 to 0.0.0.0/0 — without that, the
    // HOST=127.0.0.1 bind below would be the only thing keeping the full
    // API off the public internet.
    api: {
      root: '.',
      start: 'bun storage/framework/core/actions/src/serve/api.ts',
      port: 3008,
      preStart: ['bun install'],
      env: { HOST: '127.0.0.1', APP_ENV: 'production' },
    },

    // Queue worker — QUEUE_DRIVER=database, so jobs dispatched by the
    // scheduler (DispatchDueChecks, CheckOverdueHeartbeats, etc. — see
    // app/Scheduler.ts) sit in the `jobs` table until this process picks
    // them up. No `port`: nothing to expose, just a persistent process.
    worker: {
      root: '.',
      start: 'bun buddy queue:work',
      preStart: ['bun install'],
      env: { APP_ENV: 'production' },
    },

    // Scheduler — drives app/Scheduler.ts's cron-style jobs (every-minute
    // monitor-check dispatch, heartbeat overdue checks, maintenance-window
    // status sync, etc.). Without this running, monitors are never
    // actually checked in production — DispatchDueChecks only fires when
    // something invokes the scheduler loop.
    scheduler: {
      root: '.',
      start: 'bun buddy schedule:run',
      preStart: ['bun install'],
      env: { APP_ENV: 'production' },
    },
  },
}

// Stacks cloud configuration (for existing Stacks cloud features)
const config: CloudConfig = {
  // Add Stacks-specific cloud config here if needed
}

export default config
