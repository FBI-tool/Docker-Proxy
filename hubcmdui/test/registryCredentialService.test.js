'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const Module = require('node:module');
const path = require('node:path');

const servicePath = path.resolve(__dirname, '../services/registryCredentialService.js');

function loadServiceWithDatabase(databaseStub) {
  const originalLoad = Module._load;

  Module._load = function(request, parent, isMain) {
    if (request === '../database/database' && parent && parent.filename === servicePath) {
      return databaseStub;
    }
    if (request === '../logger' && parent && parent.filename === servicePath) {
      return { info() {}, warn() {}, error() {} };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    delete require.cache[servicePath];
    return require(servicePath);
  } finally {
    Module._load = originalLoad;
  }
}

test('GoProxy 的 token 凭证会同步到内部 registry_credentials 表', async () => {
  const ops = [];
  const service = loadServiceWithDatabase({
    async all() {
      return [];
    },
    async run(sql, params = []) {
      ops.push({ sql, params });
    }
  });

  const synced = await service.syncFromGoProxyConfig({
    registries: [
      {
        name: 'ghcr',
        hosts: ['ghcr.io'],
        upstream: 'https://ghcr.io',
        auth: {
          type: 'token',
          username: 'example-user',
          password: 'example-token'
        }
      }
    ]
  });

  assert.equal(synced, 1);
  assert.equal(ops[0].sql, 'DELETE FROM registry_credentials');
  assert.match(ops[1].sql, /INSERT INTO registry_credentials/);
  assert.equal(ops[1].params[0], 'ghcr');
  assert.equal(ops[1].params[1], 'example-user');
  assert.ok(ops[1].params[2], 'password 应被加密后写入');
});
