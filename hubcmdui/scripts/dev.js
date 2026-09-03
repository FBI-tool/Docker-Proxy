#!/usr/bin/env node
/**
 * dev.js —— `npm run dev` 的实际启动器。
 *
 * 选型优先级：
 *  1. 项目内 node_modules/.bin/nodemon（devDependency 安装齐全）
 *  2. 全局 node_modules 里的 nodemon
 *  3. 兜底：用 Node 内置 `--watch` 模式（>=18）启动 server.js
 *
 * 之前：直接 `nodemon server.js` → "command not found"，因为很多人跑过
 * `npm install --omit=dev` / `npm ci --omit=dev`，nodemon 没装上，结果 dev
 * 入口完全不可用。改为脚本分发后，无论 npm install 是否包含 dev devDeps
 * 都能跑起来。
 *
 * 用法：npm run dev   （与之前一致）
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const repoRoot = path.resolve(__dirname, '..');
const target = path.join(repoRoot, 'server.js');

function exists(p) {
  try { return fs.statSync(p); } catch { return null; }
}

function findNodemon() {
  // 1. 项目级 .bin/nodemon
  const local = path.join(repoRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'nodemon.cmd' : 'nodemon');
  if (exists(local)) return local;
  // 2. 全局（PATH 中查找）
  const which = process.platform === 'win32' ? 'where' : 'which';
  try {
    const out = require('child_process').spawnSync(which, ['nodemon'], { encoding: 'utf8' });
    if (out.status === 0 && out.stdout.trim()) return out.stdout.trim().split('\n')[0].trim();
  } catch { /* ignore */ }
  return null;
}

function nodeVersion() {
  const m = process.version.match(/^v(\d+)\.(\d+)/);
  return m ? { major: +m[1], minor: +m[2] } : null;
}

function launch(cmd, args, env) {
  const child = spawn(cmd, args, { stdio: 'inherit', env: { ...process.env, ...env } });
  child.on('exit', (code) => process.exit(code == null ? 0 : code));
  // SIGINT (Ctrl+C) 优雅转发到子进程
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => { try { child.kill(sig); } catch {} });
  }
}

const args = process.argv.slice(2);
const nodemonBin = findNodemon();

if (nodemonBin) {
  console.log(`[dev] using nodemon at ${nodemonBin}`);
  launch(nodemonBin, [target, ...args]);
} else {
  const v = nodeVersion();
  if (!v || v.major < 18) {
    console.error(`[dev] Node ${process.version} 不支持 --watch 模式，请升级到 >= 18 或运行 'npm install' 装上 nodemon`);
    process.exit(1);
  }
  console.log(`[dev] 未找到 nodemon，使用 Node 内置 --watch（v${v.major}.${v.minor}）`);
  // 透传额外参数到 server.js
  launch(process.execPath, ['--watch', target, ...args]);
}
