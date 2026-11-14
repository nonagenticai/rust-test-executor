// Default an X-Tenant-Id header on every supertest request so the existing
// business-logic tests pass through the orchestrator-only tenantGuard. The
// guard's own behaviour (exempt paths, 401 without header) is unit-tested in
// @nonagentic/coding-test-executor-common, so executor tests assume the
// orchestrator context and focus on their own logic. Tests that set their own
// X-Tenant-Id are left untouched.
const Test = require('supertest/lib/test');

const originalEnd = Test.prototype.end;
Test.prototype.end = function patchedEnd(...args) {
  const headers = this._header || {};
  if (!headers['x-tenant-id']) {
    this.set('X-Tenant-Id', 'jest-tenant');
  }
  return originalEnd.apply(this, args);
};
