// 效果图截图脚本（设计阶段 mockup，一次性工具）
// 用法：node docs/mockups/shoot-mockups.mjs   （从任意目录跑都行）
// 依赖 dsh-fly 仓的 playwright-core（createRequire 解析），产物落 docs/mockups/*.png
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const require = createRequire('/Users/ethan/ai-workspace/dsh-fly/package.json')
const { chromium } = require('playwright-core')

const HERE = dirname(fileURLToPath(import.meta.url))
const html = 'file://' + join(HERE, 'orb-mockup.html')

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1360, height: 1600 }, deviceScaleFactor: 2 })
await page.goto(html)
await page.waitForFunction(() => typeof window.__renderAll === 'function')
// 渲染是确定性的（无 rAF），再调一次确保画完
await page.evaluate(() => window.__renderAll())

const shots = [
  ['fig-idle', 'orb-idle.png'],
  ['fig-active', 'orb-active.png'],
  ['fig-closeup', 'orb-closeups.png'],
]
for (const [id, out] of shots) {
  await page.locator('#' + id).screenshot({ path: join(HERE, out) })
  console.log('✓', join(HERE, out))
}
await browser.close()
