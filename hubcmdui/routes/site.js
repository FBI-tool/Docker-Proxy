/**
 * 站点公开信息路由
 * 提供前端页脚等所需的「锁定站点信息」（GitHub 仓库地址等）。
 * 该信息在数据库中以 AES 加密存储且不可更改，此处仅做解密后下发。
 */
const express = require('express');
const router = express.Router();
const logger = require('../logger');
const configServiceDB = require('../services/configServiceDB');
const { requireLogin } = require('../middleware/auth');

const DEFAULT_GITHUB_URL = 'https://github.com/dqzboy/Docker-Proxy';

// 前台落地页（/）是否展示。默认开启；后端存储键 configs.landingVisible。
const LANDING_VISIBLE_KEY = 'landingVisible';
const DEFAULT_LANDING_VISIBLE = true;

// 公开接口：获取站点锁定信息（无需登录）
router.get('/', async (req, res) => {
  try {
    const githubUrl = (await configServiceDB.getLockedGithubUrl()) || DEFAULT_GITHUB_URL;
    res.json({
      githubUrl,
      year: new Date().getFullYear(),
      siteName: 'Docker 镜像加速服务'
    });
  } catch (error) {
    res.json({
      githubUrl: DEFAULT_GITHUB_URL,
      year: new Date().getFullYear(),
      siteName: 'Docker 镜像加速服务'
    });
  }
});

// 公开接口：前台落地页（/）是否展示（无需登录）。
//  状态保存在 configs 表（key=landingVisible），默认开启；查询异常时按"开启"返回，避免误关。
router.get('/landing-visible', async (req, res) => {
  try {
    const stored = await configServiceDB.getConfig(LANDING_VISIBLE_KEY);
    // 未显式配置视为默认开启；同时把非布尔值规整成布尔值。
    const visible = stored === undefined || stored === null
      ? DEFAULT_LANDING_VISIBLE
      : !!stored;
    res.json({ visible });
  } catch (error) {
    logger.warn('读取 landingVisible 失败，按默认开启返回:', error.message);
    res.json({ visible: DEFAULT_LANDING_VISIBLE });
  }
});

// 后台接口：切换前台落地页（/）的展示开关（需登录）。
router.post('/landing-visible', requireLogin, async (req, res) => {
  try {
    const { visible } = req.body || {};
    if (typeof visible !== 'boolean') {
      return res.status(400).json({ error: 'visible 必须是布尔值' });
    }
    await configServiceDB.saveConfig(
      LANDING_VISIBLE_KEY,
      visible,
      '前台落地页（/）是否对访客展示'
    );
    logger.info(`前台落地页展示开关已更新为: ${visible}`);
    res.json({ success: true, visible });
  } catch (error) {
    logger.error('保存 landingVisible 失败:', error);
    res.status(500).json({ error: '保存失败', details: error.message });
  }
});

module.exports = router;
