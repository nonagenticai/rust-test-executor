/**
 * Shared Express helpers for the test executors — INLINED, not a dependency.
 *
 * These five helpers used to live in the private `@nonagentic/coding-test-executor-common`
 * package on the estate's internal npm registry. This repository is published as a standalone
 * public project, so the code is carried here as first-party source: a public repo must build
 * from public artefacts, and the package was 100 lines of stateless helpers with no external
 * behaviour beyond `express`.
 *
 * Behaviour is unchanged from 1.0.1 — `tenantGuard` is still a marker that a request came
 * through the orchestrator, not cryptographic auth (see its comment), and the executor remains
 * stateless with network-level isolation as the real control.
 */

'use strict';

const express = require('express');

const TENANT_HEADER = 'x-tenant-id';
const DEFAULT_EXEMPT = ['/health', '/healthz', '/ready', '/'];

function createLogger() {
  return {
    info: (msg, meta = {}) =>
      console.log(`[INFO] ${new Date().toISOString()} - ${msg}`, JSON.stringify(meta, null, 2)),
    error: (msg, meta = {}) =>
      console.error(`[ERROR] ${new Date().toISOString()} - ${msg}`, JSON.stringify(meta, null, 2)),
    warn: (msg, meta = {}) =>
      console.warn(`[WARN] ${new Date().toISOString()} - ${msg}`, JSON.stringify(meta, null, 2)),
    debug: (msg, meta = {}) =>
      console.log(`[DEBUG] ${new Date().toISOString()} - ${msg}`, JSON.stringify(meta, null, 2)),
  };
}

function setupExpress(options = {}) {
  const { jsonLimit = '50mb', urlencoded = true } = options;
  const app = express();
  app.use(express.json({ limit: jsonLimit }));
  if (urlencoded) {
    app.use(express.urlencoded({ extended: true }));
  }
  return app;
}

function healthHandler(meta = {}) {
  const { service = 'test-executor', version = '1.0.0', capabilities = {} } = meta;
  return (_req, res) => {
    const memUsage = process.memoryUsage();
    res.json({
      status: 'healthy',
      service,
      version,
      timestamp: new Date().toISOString(),
      capabilities,
      runtime: {
        version: process.version,
        memory: { used: memUsage.heapUsed, total: memUsage.heapTotal },
        uptime: process.uptime(),
      },
    });
  };
}

// Orchestrator-only access guard. Requests must carry an X-Tenant-Id header to
// reach any non-exempt route. This is a lightweight marker that a request came
// through the coding-testing orchestrator, NOT cryptographic auth — these
// executors are stateless. Network-level isolation (k8s NetworkPolicy) is the
// robust control; this raises the bar from wide-open and documents intent.
function tenantGuard(options = {}) {
  const { exempt = DEFAULT_EXEMPT, header = TENANT_HEADER } = options;
  const exemptSet = new Set(exempt);
  return (req, res, next) => {
    if (exemptSet.has(req.path)) {
      return next();
    }
    const tenantId = req.get(header);
    if (!tenantId || !String(tenantId).trim()) {
      return res.status(401).json({
        error: 'X-Tenant-Id header required',
        detail: 'This service is orchestrator-only; requests must carry an X-Tenant-Id header.',
      });
    }
    return next();
  };
}

function installGracefulShutdown(options = {}) {
  const {
    server = null,
    log = console,
    signals = ['SIGTERM', 'SIGINT'],
    exit = process.exit,
    exitCode = 0,
  } = options;
  const shutdown = (signal) => {
    if (log && typeof log.info === 'function') {
      log.info(`Received ${signal}, shutting down gracefully`);
    }
    if (server && typeof server.close === 'function') {
      server.close(() => exit(exitCode));
    } else {
      exit(exitCode);
    }
  };
  signals.forEach((sig) => process.on(sig, () => shutdown(sig)));
  return shutdown;
}

module.exports = {
  createLogger,
  setupExpress,
  healthHandler,
  tenantGuard,
  installGracefulShutdown,
  TENANT_HEADER,
  DEFAULT_EXEMPT,
};
