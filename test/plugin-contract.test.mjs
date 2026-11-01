// dsh-fly 外部插件契约的**本地尺子**。
//
// 把本仓登记进主仓 `plugins.lock.json` 之后，主仓的 `scripts/tests/plugin-lock.spec.mjs` 会要求：
// 带 `dsh.client` 的锁定插件，其策略脚本必须是主仓同名脚本的**逐字节副本**
// （构建器 + 源哈希 + 两道署名闸门）。改一份不改另一份的失败形状是「主仓门禁红在插件仓」，
// 而插件仓自己的测试全绿 —— 所以在**这边**也钉一条，越早红越好。
//
// 本插件是手写 JS 客户端（没有 `src/client/index.tsx`），所以 `scripts/build-client.mjs`
// 不会被跑；它作为契约副本存在，保证结构性一致（将来真要接 TS 客户端时不用换骨架）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FLY_REPO = resolve(ROOT, '../../dsh-fly');

/** 本仓文件 → 主仓对应文件（逐字节必须相同）。 */
const CONTRACT_PAIRS = [
  ['scripts/build-client.mjs', 'scripts/build-plugin-client.mjs'],
  ['scripts/lib/client-src-hash.mjs', 'scripts/lib/client-src-hash.mjs'],
  ['scripts/lib/commit-identity.mjs', 'scripts/lib/commit-identity.mjs'],
  ['scripts/check-commit-identity.mjs', 'scripts/check-commit-identity.mjs'],
];

test('契约脚本都在（锁进 dsh-fly 的前提）', () => {
  for (const [mine] of CONTRACT_PAIRS) {
    assert.ok(existsSync(join(ROOT, mine)), `缺少契约脚本 ${mine}`);
  }
});

test('契约脚本与 dsh-fly 主仓逐字节相同（本机有主仓时才比）', (t) => {
  if (!existsSync(join(FLY_REPO, 'scripts/build-plugin-client.mjs'))) {
    t.diagnostic(`跳过：本机没有 dsh-fly 主仓（${FLY_REPO}）`);
    return;
  }
  for (const [mine, theirs] of CONTRACT_PAIRS) {
    const a = readFileSync(join(ROOT, mine), 'utf8');
    const b = readFileSync(join(FLY_REPO, theirs), 'utf8');
    assert.equal(a, b, `${mine} 与主仓 ${theirs} 不一致（改一份就得改两份）`);
  }
});

test('package.json 的锁定身份字段与主仓约定一致', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  // 主仓 auditLockedPlugins 用 name/version 与锁比对；这里只是提醒别写歧义值。
  assert.equal(pkg.name, 'dsh-energy-orb');
  assert.match(pkg.version, /^\d+\.\d+\.\d+/);
  assert.ok(pkg.repository?.url === 'git+https://github.com/ethanchen669/dsh-energy-orb.git',
    `repository.url 必须与仓地址逐字一致（provenance 会校验）：${pkg.repository?.url}`);
  assert.equal(pkg.private, undefined, '锁进主仓 / 发布 npm 的包不能再带 private');
});
