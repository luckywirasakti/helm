'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Skip everything if we're not on Linux — metrics.js shells out to
// `ps`, `df`, `nproc`, `ss`, `systemctl`, etc. All of these exist on the
// target platform (Linux server) but not on macOS dev machines or CI
// runners that may not be Linux. Be lenient so the suite passes
// anywhere while still being useful on the real target.
const IS_LINUX = process.platform === 'linux';
const skipNonLinux = IS_LINUX ? test : test.skip;

skipNonLinux('getMetrics() returns a well-shaped snapshot', () => {
  const { getMetrics } = require('../src/utils/metrics');
  const m = getMetrics();

  assert.equal(typeof m, 'object');
  assert.ok(m, 'snapshot must not be null');

  // Top-level fields
  for (const key of ['timestamp', 'hostname', 'kernel', 'uptime', 'uptimeSec',
                     'load', 'cpu', 'ram', 'swap', 'disk', 'network',
                     'processes', 'services', 'serviceCount', 'ports']) {
    assert.ok(key in m, `missing field: ${key}`);
  }

  // Nested shapes
  assert.equal(typeof m.cpu.cores, 'number');
  assert.equal(typeof m.cpu.usage, 'number');
  assert.ok(m.cpu.cores >= 1, 'cpu.cores should be >= 1');
  assert.ok(m.ram.total > 0, 'ram.total should be > 0');
  assert.ok(Array.isArray(m.load) && m.load.length === 3, 'load should be 3 numbers');

  // Types
  assert.ok(typeof m.timestamp === 'number');
  assert.ok(typeof m.serviceCount === 'number');
  assert.ok(Array.isArray(m.processes));
  assert.ok(Array.isArray(m.services));
  assert.ok(Array.isArray(m.ports));
  assert.equal(typeof m.network, 'object');
});

test('package.json exposes the expected scripts and metadata', () => {
  const pkg = require('../package.json');
  assert.equal(pkg.license, 'MIT', 'license should be MIT (matches README badge)');
  assert.equal(pkg.main, 'src/app.js');
  assert.ok(pkg.scripts.start, 'start script is required');
  assert.ok(pkg.engines && pkg.engines.node, 'engines.node should be declared');
  assert.ok(pkg.dependencies.dotenv, 'dotenv must be a runtime dep');
  assert.ok(pkg.dependencies.ws, 'ws must be a runtime dep');
  assert.ok(pkg.dependencies['node-pty'], 'node-pty must be a runtime dep');
});
