'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const Module = require('node:module');
const path = require('node:path');

const servicePath = path.resolve(__dirname, '../services/registrySearchService.js');

function loadServiceWithAxios(axiosStub) {
  const originalLoad = Module._load;

  Module._load = function(request, parent, isMain) {
    if (request === 'axios') return axiosStub;
    if (request === '../logger' && parent && parent.filename === servicePath) {
      return {
        info() {},
        warn() {},
        error() {}
      };
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

test('Docker Hub 搜索不禁用 Axios 的环境代理支持', async () => {
  let requestOptions;
  const service = loadServiceWithAxios({
    async get(url, options) {
      requestOptions = options;
      return { data: { count: 0, results: [] } };
    }
  });

  await service.searchDockerHub('nginx');

  assert.ok(requestOptions);
  assert.equal(
    Object.prototype.hasOwnProperty.call(requestOptions, 'proxy'),
    false,
    'proxy 配置应留给 Axios 根据 HTTP_PROXY/HTTPS_PROXY/NO_PROXY 环境变量解析'
  );
});
