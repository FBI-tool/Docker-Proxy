/**
 * Registry 凭证内部同步模块
 *
 * 设计背景（合并说明）：
 * 「代理管理」(GoProxy) 已支持为每个 registry 配置 token / Basic 认证（用户名/密码），
 * 但其管理端口返回的密码是脱敏的（********），hubcmdui 的搜索/标签服务无法
 * 直接复用。为避免出现「两套独立凭证入口」，本模块不再对外暴露 CRUD，
 * 而是在代理管理保存配置时，由 routes/goProxy.js 调用 syncFromGoProxyConfig，
 * 把其中带用户名与密码的认证同步进内部表；镜像搜索/标签查看的
 * token 流程通过 getPlainCredential 读取。
 *
 * 对外表现：用户只在一个地方（代理管理）配置访问凭证，实际代理拉取与搜索/
 * 标签查看两处同时生效 —— 无重复入口。
 *
 * 密码以 AES 加密存储（lib/cryptoUtil），仅内部 getPlainCredential 返回明文。
 */
const logger = require('../logger');
const database = require('../database/database');
const { encrypt, decrypt } = require('../lib/cryptoUtil');

/**
 * registry_id -> 候选域名（与 registrySearchService.REGISTRY_CONFIGS 的域名保持一致）。
 * 用于把 go-proxy 配置里的 registry（按 hosts / upstream 匹配）映射到 hubcmdui 的 registry_id。
 */
const REGISTRY_HOSTS = {
  'docker-hub': ['registry-1.docker.io', 'docker.io', 'hub.docker.com'],
  'ghcr':       ['ghcr.io'],
  'quay':       ['quay.io'],
  'gcr':        ['gcr.io', 'us.gcr.io', 'eu.gcr.io', 'asia.gcr.io', 'staging-k8s.gcr.io'],
  'k8s':        ['registry.k8s.io', 'k8s.gcr.io'],
  'mcr':        ['mcr.microsoft.com'],
  'elastic':    ['docker.elastic.co'],
  'nvcr':       ['nvcr.io']
};

const SYNCABLE_AUTH_TYPES = new Set(['basic', 'token']);
const MASKED_PASSWORD_SENTINEL = '********';

function hostOf(url) {
  if (!url) return '';
  try { return new URL(url).host; } catch { return ''; }
}

/**
 * 根据一个 go-proxy registry 的 hosts / upstream，反查对应的 hubcmdui registry_id。
 * @returns {string|null}
 */
function resolveRegistryId(proxyReg) {
  const hosts = Array.isArray(proxyReg.hosts) ? proxyReg.hosts : [];
  const upstreamHost = hostOf(proxyReg.upstream);
  for (const [registryId, candidates] of Object.entries(REGISTRY_HOSTS)) {
    for (const cand of candidates) {
      const hit = hosts.some(h => h === cand || h.endsWith('.' + cand) || cand.endsWith('.' + h))
        || (upstreamHost && (upstreamHost === cand || upstreamHost.endsWith('.' + cand) || cand.endsWith('.' + upstreamHost)));
      if (hit) return registryId;
    }
  }
  return null;
}

/**
 * 同步代理管理配置中的凭证到内部表。
 * 全量重建：先清空旧表，再按当前 go-proxy 配置写入所有带用户名与密码的认证。
 * @param {{registries:Array}} cfg go-proxy 配置对象
 */
async function syncFromGoProxyConfig(cfg) {
  const regs = (cfg && Array.isArray(cfg.registries)) ? cfg.registries : [];
  try {
    const now = new Date().toISOString();
    let synced = 0;
    const activeRegistryIds = new Set();
    const maskedRegistryIds = new Set();
    const credentials = [];

    for (const r of regs) {
      const auth = r.auth || {};
      const authType = String(auth.type || '').toLowerCase();
      const registryId = resolveRegistryId(r);
      if (!registryId) continue;

      if (!SYNCABLE_AUTH_TYPES.has(authType) || !auth.username) continue;
      if (auth.password === MASKED_PASSWORD_SENTINEL) {
        // 普通 GET /-/config 会脱敏密码。不能把 ******** 写入数据库，
        // 否则会覆盖真实 PAT；保留已有凭证，等待 secrets 配置接口刷新。
        maskedRegistryIds.add(registryId);
        activeRegistryIds.add(registryId);
        continue;
      }
      if (!auth.password) continue;

      credentials.push({
        registryId,
        username: auth.username,
        password: auth.password
      });
      activeRegistryIds.add(registryId);
      synced++;
    }

    // 仅在本次配置没有任何脱敏凭证时执行完整清理。
    // 这样旧版本 Go 端或普通脱敏配置读取失败时，不会误删可用凭证。
    if (maskedRegistryIds.size === 0) {
      await database.run('DELETE FROM registry_credentials');
      for (const credential of credentials) {
        const enc = encrypt(credential.password);
        await database.run(
          'INSERT INTO registry_credentials (registry_id, username, password, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
          [credential.registryId, credential.username, enc, now, now]
        );
      }
    } else {
      const existingRows = await database.all(
        'SELECT registry_id FROM registry_credentials'
      );
      for (const credential of credentials) {
        const enc = encrypt(credential.password);
        const existed = existingRows.some(row => row.registry_id === credential.registryId);
        if (existed) {
          await database.run(
            'UPDATE registry_credentials SET username = ?, password = ?, updated_at = ? WHERE registry_id = ?',
            [credential.username, enc, now, credential.registryId]
          );
        } else {
          await database.run(
            'INSERT INTO registry_credentials (registry_id, username, password, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
            [credential.registryId, credential.username, enc, now, now]
          );
        }
      }
      // 清理明确不再存在、且不属于脱敏 registry 的旧凭证。
      for (const row of existingRows) {
        if (!activeRegistryIds.has(row.registry_id)) {
          await database.run('DELETE FROM registry_credentials WHERE registry_id = ?', [row.registry_id]);
        }
      }
    }

    logger.info(`已从代理管理同步 ${synced} 条 Registry 凭证到内部表`);
    return synced;
  } catch (e) {
    logger.error(`同步 Registry 凭证失败: ${e.message}`);
    return 0;
  }
}

/**
 * 直接从当前 Go 代理管理端读取配置并同步 Registry 凭证。
 * 用于启动时/重载后/按需刷新，避免手工修改 config.yaml 后内部凭证表不同步。
 */
async function syncFromLiveGoProxyConfig() {
  try {
    const { goProxyService } = require('./goProxyService');
    const cfg = typeof goProxyService.getConfigWithSecrets === 'function'
      ? await goProxyService.getConfigWithSecrets()
      : await goProxyService.getConfig();
    return await syncFromGoProxyConfig(cfg);
  } catch (e) {
    logger.warn(`从 Go 代理读取 Registry 凭证失败: ${e.message}`);
    return 0;
  }
}

/**
 * 内部使用：获取明文凭证（仅供 token 获取流程调用）
 * @param {string} registryId
 * @returns {Promise<{username:string,password:string}|null>}
 */
async function getPlainCredential(registryId) {
  try {
    const row = await database.get(
      'SELECT username, password FROM registry_credentials WHERE registry_id = ?',
      [registryId]
    );
    if (!row || !row.password) return null;
    return { username: row.username || '', password: decrypt(row.password) };
  } catch (e) {
    logger.error(`读取 Registry 明文凭证失败 (${registryId}): ${e.message}`);
    return null;
  }
}

module.exports = {
  syncFromGoProxyConfig,
  syncFromLiveGoProxyConfig,
  getPlainCredential
};
