import process from "node:process";
import type { PantryConfig } from "ts-pantry";

/**
 * Pantry configuration for the Stacks project
 *
 * This file defines system-level dependencies managed by Pantry.
 * JavaScript/TypeScript dependencies remain in package.json.
 *
 * Self-hosted installs default to SQLite and need zero services. The hosted /
 * multi-region deploy sets DB_CONNECTION=postgres (and QUEUE_DRIVER=redis),
 * which flips pantry to provision + autostart Postgres/Redis and run
 * migrations on activation — the same "cd in and it's ready" flow easy-otc-api
 * uses. Versions are pinned exactly because only specific builds are synced to
 * the object storage (see easy-otc-api/deps.yaml's note).
 *
 * @see https://pantry.sh/docs/configuration
 */
const usePostgres = (process.env.DB_CONNECTION || "sqlite") === "postgres";
const useRedis = usePostgres || process.env.QUEUE_DRIVER === "redis";

export const config: PantryConfig = {
  /**
   * System dependencies with version constraints
   * These are binary tools and system packages required for development
   */
  dependencies: {
    "bun.com": "^1.3.0",
    craft: "^0.0.1",
    // SQLite for self-hosted; Postgres for the hosted/multi-region deploy.
    ...(usePostgres ? { "postgresql.org": "18.4" } : { "sqlite.org": "^3.47.2" }),
    // Redis (real, not valkey) for the shared cross-region queue.
    ...(useRedis ? { "redis.io": "8.8.0" } : {}),
  },

  /**
   * Install packages globally (available system-wide)
   * Set to false to install locally in the project
   */
  global: false,

  /**
   * Service management configuration
   * Auto-start and manage databases and other services
   */
  services: {
    enabled: true,
    autoStart: true,

    /**
     * Database configuration
     * Automatically provisions and starts the database
     */
    database: {
      connection: usePostgres ? "postgres" : "sqlite",
      name: process.env.DB_DATABASE || "stacks",
      username: usePostgres ? (process.env.DB_USERNAME || "postgres") : "root",
      password: process.env.DB_PASSWORD || "",
      authMethod: "trust",
    },

    /**
     * Commands to run after database setup
     * Useful for migrations and seeding
     */
    postDatabaseSetup: ["./buddy migrate", "./buddy seed"],

    /**
     * Framework-specific service detection
     */
    frameworks: {
      enabled: true,
      stacks: {
        enabled: true,
        autoDetect: true,
      },
    },
  },

  /**
   * Project-level lifecycle hooks
   */
  preSetup: {
    enabled: false,
    commands: [],
  },

  postSetup: {
    enabled: true,
    commands: [
      {
        name: "Generate model files",
        command: "./buddy",
        args: ["generate:model-files"],
        description: "Generate TypeScript model files from database schema",
        required: false,
      },
    ],
  },

  preActivation: {
    enabled: false,
    commands: [],
  },

  postActivation: {
    enabled: false,
    commands: [],
  },

  /**
   * Cache configuration for faster installations
   */
  cache: {
    enabled: true,
    maxSize: 2048, // 2GB
    ttlHours: 168, // 1 week
    autoCleanup: true,
    compression: true,
  },

  /**
   * Network settings
   */
  network: {
    timeout: 30000,
    maxConcurrent: 5,
    retries: 3,
    followRedirects: true,
  },

  /**
   * Security settings
   */
  security: {
    verifySignatures: true,
    checkVulnerabilities: true,
    allowUntrusted: false,
  },

  /**
   * Logging configuration
   */
  logging: {
    level: "info",
    toFile: false,
    timestamps: true,
    json: false,
  },

  /**
   * Update policies
   */
  updates: {
    checkForUpdates: true,
    autoUpdate: false,
    checkFrequency: 24,
    includePrereleases: false,
    channels: ["stable"],
  },

  /**
   * Resource management
   */
  resources: {
    autoCleanup: true,
    keepVersions: 3,
  },

  /**
   * Environment profiles for different contexts
   */
  profiles: {
    active: "development",
    development: {
      verbose: true,
      logging: {
        level: "debug",
      },
    },
    production: {
      verbose: false,
      logging: {
        level: "warn",
      },
      cache: {
        maxSize: 4096, // 4GB for production
      },
    },
    ci: {
      verbose: true,
      autoInstall: true,
      cache: {
        enabled: false,
      },
    },
  },

  /**
   * Verbose output
   */
  verbose: true,

  /**
   * Installation path for packages
   */
  installPath: "/usr/local",

  /**
   * Auto-install missing dependencies
   */
  autoInstall: true,

  /**
   * Install runtime dependencies
   */
  installDependencies: false,

  /**
   * Install build-time dependencies
   */
  installBuildDeps: false,
};

export default config;
