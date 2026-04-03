/**
 * 临时截图调试用例 — 用于与真实设备联调
 *
 * 使用方法:
 *   node test/screenshot-debug.mjs
 *
 * 请根据实际环境修改下方 ADDRESS 和 PLUGIN 常量。
 */

import fs from 'node:fs';
import path from 'node:path';
import { Screenshot } from '../src/index.mjs';

// ============ 根据实际设备修改 ============
const ADDRESS = '192.168.213.73';   // 设备 IP
const PLUGIN  = undefined;         // 插件名，undefined 表示自动检测；也可指定如 'rigol-1000z'
const TIMEOUT = 15000;             // 超时时间 (ms)
const OUT_DIR = './test/output';   // 截图输出目录
// =========================================

async function main() {
  console.log('--- Screenshot Debug ---');

  // 1. 列出所有已注册的截图插件
  const pluginList = Screenshot.listPlugins();
  console.log(`已注册插件 (${pluginList.length}):`);
  for (const p of pluginList) {
    console.log(`  - ${p.name}: ${p.description}`);
  }

  // 2. 自动检测设备对应的插件
  console.log(`\n正在检测设备 ${ADDRESS} ...`);
  const detected = await Screenshot.detectPlugin(ADDRESS, TIMEOUT);
  console.log(`检测到插件: ${detected ?? '(未识别)'}`);

  // 3. 截图
  console.log('\n正在截图 ...');
  const result = await Screenshot.screenshot(ADDRESS, {
    plugin: PLUGIN,
    timeout: TIMEOUT,
  });
  console.log(`截图完成 — 插件: ${result.plugin}, 格式: ${result.format}, 大小: ${result.data.length} bytes`);

  // 4. 保存到文件
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const filename = `screenshot_${Date.now()}.gen.${result.format}`;
  const filepath = path.join(OUT_DIR, filename);
  fs.writeFileSync(filepath, result.data);
  console.log(`已保存: ${filepath}`);
}

main().catch(err => {
  console.error('截图失败:', err);
  process.exit(1);
});
