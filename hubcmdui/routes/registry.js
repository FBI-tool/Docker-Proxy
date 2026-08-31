/**
 * 多 Registry 搜索路由
 * 支持 Docker Hub、GHCR、Quay、GCR、K8s、MCR、Elastic 等平台
 */
const express = require('express');
const router = express.Router();
const logger = require('../logger');
const registrySearchService = require('../services/registrySearchService');
const configServiceDB = require('../services/configServiceDB');

/**
 * 获取支持的 Registry 列表
 * GET /api/registry/list
 */
router.get('/list', async (req, res) => {
    try {
        const registries = registrySearchService.getRegistryList();
        res.json({
            success: true,
            registries
        });
    } catch (err) {
        logger.error('获取 Registry 列表失败:', err.message);
        res.status(500).json({ 
            success: false,
            error: '获取 Registry 列表失败', 
            details: err.message 
        });
    }
});

/**
 * 搜索指定 Registry
 * GET /api/registry/search/:registryId
 * 参数:
 *   - registryId: Registry 标识 (docker-hub, ghcr, quay, gcr, k8s, mcr, elastic, nvcr)
 *   - term: 搜索关键词
 *   - page: 页码（默认 1）
 *   - limit: 每页数量（默认 25）
 */
router.get('/search/:registryId', async (req, res) => {
    try {
        const { registryId } = req.params;
        const { term, page = 1, limit = 25 } = req.query;
        
        if (!term) {
            return res.status(400).json({ 
                success: false,
                error: '缺少搜索关键字(term)' 
            });
        }
        
        logger.info(`搜索 ${registryId}: 关键字="${term}", 页码=${page}`);
        
        const result = await registrySearchService.searchRegistry(
            registryId, 
            term, 
            parseInt(page), 
            parseInt(limit)
        );
        
        res.json({
            success: true,
            ...result
        });
    } catch (err) {
        logger.error(`Registry 搜索失败 (${req.params.registryId}):`, err.message);
        res.status(500).json({ 
            success: false,
            error: 'Registry 搜索失败', 
            details: err.message 
        });
    }
});

/**
 * 搜索所有 Registry（聚合搜索）
 * GET /api/registry/search-all
 * 参数:
 *   - term: 搜索关键词
 *   - page: 页码（默认 1）
 *   - limit: 每个 Registry 返回的数量（默认 10）
 */
router.get('/search-all', async (req, res) => {
    try {
        const { term, page = 1, limit = 10 } = req.query;
        
        if (!term) {
            return res.status(400).json({ 
                success: false,
                error: '缺少搜索关键字(term)' 
            });
        }
        
        logger.info(`聚合搜索所有 Registry: 关键字="${term}", 页码=${page}`);

        // 仅聚合搜索后台「Registry 平台配置」中已启用的平台
        let enabledIds = null;
        try {
            const enabledConfigs = await configServiceDB.getEnabledRegistryConfigs();
            if (Array.isArray(enabledConfigs) && enabledConfigs.length) {
                enabledIds = enabledConfigs.map(c => c.registryId || c.registry_id);
            }
        } catch (e) {
            logger.warn('读取启用 Registry 配置失败，回退为搜索全部:', e.message);
        }
        
        const result = await registrySearchService.searchAllRegistries(
            term, 
            parseInt(page), 
            parseInt(limit),
            enabledIds
        );
        
        res.json({
            success: true,
            ...result
        });
    } catch (err) {
        logger.error('聚合搜索失败:', err.message);
        res.status(500).json({ 
            success: false,
            error: '聚合搜索失败', 
            details: err.message 
        });
    }
});

/**
 * 获取镜像标签
 * GET /api/registry/tags/:registryId
 * 参数:
 *   - registryId: Registry 标识
 *   - name: 镜像名称
 *   - page: 页码（默认 1）
 *   - limit: 每页数量（默认 100）
 */
router.get('/tags/:registryId', async (req, res) => {
    try {
        const { registryId } = req.params;
        const { name, page = 1, limit = 100, sourceRepository = '' } = req.query;
        
        if (!name) {
            return res.status(400).json({ 
                success: false,
                error: '缺少镜像名称(name)' 
            });
        }
        
        logger.info(`获取 ${registryId} 镜像标签: ${name}, 页码=${page}`);
        
        const result = await registrySearchService.getImageTags(
            registryId,
            name,
            parseInt(page),
            parseInt(limit),
            sourceRepository
        );
        
        res.json({
            success: true,
            ...result
        });
    } catch (err) {
        logger.error(`获取镜像标签失败 (${req.params.registryId}):`, err.message);
        // 透传更具体的业务错误（如「需要登录认证」），让前端给出明确提示而非笼统报错
        const isAuthErr = err.message && err.message.includes('需要登录');
        const status = isAuthErr ? 403 : (err.statusCode || err.response?.status || 500);
        res.status(status).json({
            success: false,
            error: err.message || '获取镜像标签失败',
            details: err.message
        });
    }
});

/**
 * 获取标签数量
 * GET /api/registry/tag-count/:registryId
 * 参数:
 *   - registryId: Registry 标识
 *   - name: 镜像名称
 */
router.get('/tag-count/:registryId', async (req, res) => {
    try {
        const { registryId } = req.params;
        const { name, sourceRepository = '' } = req.query;
        
        if (!name) {
            return res.status(400).json({ 
                success: false,
                error: '缺少镜像名称(name)' 
            });
        }
        
        logger.info(`获取 ${registryId} 镜像标签数量: ${name}`);
        
        // 获取第一页标签来获取总数
        const result = await registrySearchService.getImageTags(
            registryId,
            name,
            1,
            1,
            sourceRepository
        );
        
        res.json({
            success: true,
            count: result.count || 0,
            recommended_mode: result.count > 500 ? 'paginated' : 'full'
        });
    } catch (err) {
        logger.error(`获取标签数量失败 (${req.params.registryId}):`, err.message);
        res.status(500).json({ 
            success: false,
            error: '获取标签数量失败', 
            details: err.message 
        });
    }
});

module.exports = router;
