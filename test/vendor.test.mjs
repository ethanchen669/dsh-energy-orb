// vendored 资产的完整性：manifest 是唯一事实来源，改动必须经过 scripts/vendor-sphere.mjs。
// 三个漂移入口各钉一条：①文件被手改（sha256 不符）②说明符漏改写（浏览器解析不到）③
// 资产路由白名单与 manifest 列表不一致（新文件 404 / 过期文件仍可访问）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from '../client/vendor/three.module.min.js';
import { ALLOWED_ASSETS, ASSET_PREFIX, assetKeyFromUrl } from '../host/asset-route.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLIENT = join(ROOT, 'client');
const manifest = JSON.parse(readFileSync(join(CLIENT, 'vendor', 'manifest.json'), 'utf8'));

/** 递归收集目录下的 .js 文件（相对 CLIENT）。 */
function jsFilesUnder(relDir) {
  const out = [];
  const walk = (rel) => {
    for (const name of readdirSync(join(CLIENT, rel))) {
      const childRel = `${rel}/${name}`;
      if (statSync(join(CLIENT, childRel)).isDirectory()) walk(childRel);
      else if (extname(name) === '.js') out.push(childRel);
    }
  };
  walk(relDir);
  return out;
}

test('本地补丁有记录且落到了生成物里（透明画布修复不许被静默丢弃）', () => {
  const ids = manifest.patches.map((p) => p.id);
  assert.deepEqual(ids, ['transparent-alpha-pass', 'transparent-alpha-pass-wire'], `manifest 补丁记录不符：${ids}`);
  const sphere = readFileSync(join(CLIENT, 'sphere', 'energy-sphere.js'), 'utf8');
  assert.match(sphere, /\[dsh-energy-orb patch\]/, '补丁标记不在生成物里');
  assert.match(sphere, /import \{ ShaderPass \} from '\.\.\/vendor\/addons\/postprocessing\/ShaderPass\.js'/,
    '补丁 import 未落地');
  assert.match(sphere, /const transparentPass = new ShaderPass/, '末级透明 pass 未装配');
  // alpha 由亮度还原 + 外圈径向淡出：这两个式子是「不是不透明方块」的根据
  assert.match(sphere, /float a = clamp\( max\( max\( c\.r, c\.g \), c\.b \), 0\.0, 1\.0 \) \* mask;/);
  assert.match(sphere, /smoothstep\( 0\.84, 1\.0, d \)/);
});

test('manifest 记录来源与 three 版本（溯源可查）', () => {
  assert.equal(manifest.generatedBy, 'scripts/vendor-sphere.mjs');
  assert.match(manifest.sourceApp, /apps\/energy-sphere-demo$/);
  assert.equal(manifest.threeVersion, '0.180.0');
  assert.equal(THREE.REVISION, '180', 'import 到的 three 版本与 manifest 不一致');
  assert.ok(manifest.files.length >= 15, `manifest 文件数太少：${manifest.files.length}`);
});

test('manifest 里每个文件的 sha256/字节数都与磁盘一致（手改必红）', () => {
  for (const entry of manifest.files) {
    const file = join(ROOT, entry.path);
    const buf = readFileSync(file);
    assert.equal(buf.length, entry.bytes, `${entry.path} 字节数不符（${buf.length} != ${entry.bytes}）`);
    assert.equal(createHash('sha256').update(buf).digest('hex'), entry.sha256, `${entry.path} sha256 不符（被手改过？重跑 node scripts/vendor-sphere.mjs）`);
  }
});

test('磁盘上的 vendored .js 与 manifest 列表一一对应（无游离文件）', () => {
  const listed = new Set(manifest.files.map((e) => e.path.replace(/^client\//, '')));
  for (const rel of [...jsFilesUnder('sphere'), ...jsFilesUnder('vendor')]) {
    assert.ok(listed.has(rel), `${rel} 在磁盘上但不在 manifest 里（重跑 vendor 脚本）`);
  }
  for (const rel of listed) {
    assert.ok(rel.startsWith('sphere/') || rel.startsWith('vendor/'), `manifest 出现越界路径 ${rel}`);
  }
});

test('改写后不许残留裸说明符（浏览器没有 node_modules）', () => {
  for (const rel of [...jsFilesUnder('sphere'), ...jsFilesUnder('vendor')]) {
    const source = readFileSync(join(CLIENT, rel), 'utf8');
    const specs = [...source.matchAll(/(?:\bfrom\s*|\bimport\s*)(['"])([^'"]+)\1/g)].map((m) => m[2]);
    for (const spec of specs) {
      assert.ok(spec.startsWith('.'), `${rel} 里残留裸说明符 "${spec}"`);
    }
    // 相对说明符必须真的能在磁盘上解析到（漏 copy 一个文件就在这里红）
    for (const spec of specs) {
      const resolved = normalize(join(CLIENT, rel, '..', spec));
      assert.doesNotThrow(() => statSync(resolved), `${rel} 的 import "${spec}" 指向不存在的文件`);
    }
  }
});

test('资产路由白名单与 manifest 完全一致（两处漂移必有一处红）', () => {
  const vendored = manifest.files
    .filter((e) => e.path.startsWith('client/vendor/') && !e.path.endsWith('manifest.json'))
    .map((e) => e.path.replace(/^client\//, ''))
    .sort();
  const routeVendor = ALLOWED_ASSETS.filter((p) => p.startsWith('vendor/')).sort();
  assert.deepEqual(routeVendor, vendored, '白名单与 manifest 不一致');
  const sphere = manifest.files.filter((e) => e.path.startsWith('client/sphere/')).map((e) => e.path.replace(/^client\//, '')).sort();
  assert.deepEqual(sphere, ['sphere/animation.js', 'sphere/energy-sphere.js', 'sphere/options.js']);
  for (const key of ALLOWED_ASSETS) {
    assert.equal(assetKeyFromUrl(`${ASSET_PREFIX}/${key}`), key, `${key} 取不到白名单键`);
  }
});

test('白名单外一律取不到键：目录穿越 / 非白名单 / manifest 本身', () => {
  for (const url of [
    `${ASSET_PREFIX}/../package.json`,
    `${ASSET_PREFIX}/sphere/../../index.js`,
    `${ASSET_PREFIX}/vendor/manifest.json`,
    `${ASSET_PREFIX}/sphere/does-not-exist.js`,
    `${ASSET_PREFIX}/`,
    '/api/energy-orb/state',
  ]) {
    assert.equal(assetKeyFromUrl(url), null, `${url} 不应命中白名单`);
  }
});
