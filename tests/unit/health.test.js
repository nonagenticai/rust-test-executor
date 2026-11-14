const request = require('supertest');
const { app } = require('../../src/rust_test_service');

describe('GET /health', () => {
  test('returns 200 status code', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
  });

  test('Content-Type is application/json', async () => {
    const res = await request(app).get('/health');
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });

  test('status is healthy', async () => {
    const res = await request(app).get('/health');
    expect(res.body.status).toBe('healthy');
  });

  test('service name is rust-test-executor', async () => {
    const res = await request(app).get('/health');
    expect(res.body.service).toBe('rust-test-executor');
  });

  test('version is present', async () => {
    const res = await request(app).get('/health');
    expect(res.body.version).toBe('1.0.0');
  });

  test('timestamp is a valid ISO string', async () => {
    const res = await request(app).get('/health');
    expect(res.body.timestamp).toBeDefined();
    const d = new Date(res.body.timestamp);
    expect(d.toISOString()).toBe(res.body.timestamp);
  });

  test('capabilities includes tools list', async () => {
    const res = await request(app).get('/health');
    const caps = res.body.capabilities;
    expect(caps).toBeDefined();
    expect(caps.tools).toEqual(
      expect.arrayContaining(['cargo', 'clippy', 'rustfmt', 'nextest', 'llvm-cov', 'audit', 'deny'])
    );
  });

  test('capabilities includes feature flags', async () => {
    const res = await request(app).get('/health');
    const features = res.body.capabilities.features;
    expect(features.parallelExecution).toBe(true);
    expect(features.coverage).toBe(true);
    expect(features.linting).toBe(true);
    expect(features.formatting).toBe(true);
    expect(features.securityAudit).toBe(true);
  });

  test('runtime has version, memory, and uptime', async () => {
    const res = await request(app).get('/health');
    const runtime = res.body.runtime;
    expect(runtime).toBeDefined();
    expect(runtime.version).toBeDefined();
    expect(runtime.memory).toBeDefined();
    expect(typeof runtime.memory.used).toBe('number');
    expect(typeof runtime.memory.total).toBe('number');
    expect(typeof runtime.uptime).toBe('number');
  });
});
