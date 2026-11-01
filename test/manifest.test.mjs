import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('package.json declares the bundle manifest', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.name, '@dsh-fly/dsh-energy-orb');
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml');
  assert.equal(pkg.dsh.client.platform, 'web');
  for (const key of ['.', './client', './icon']) {
    assert.ok(pkg.exports[key], `exports missing ${key}`);
  }
});

test('cordis.patch.yml：行 id = 插件名 dsh-fly-energy-orb，行 name = npm 包名', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const yml = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8');
  // 行 id 是**插件名**（用户/市场里看到的名字），行 name 是 loader 解析用的**包名** ——
  // 两者是两件事：主仓门禁按 dsh.bundle 的 patch 读行 id，不再从包名硬推。
  assert.match(yml, /- id: dsh-fly-energy-orb/);
  // 行 name 必须是完整包名：loader 按它解析包、客户端半边按它登记（与 @dsh-fly/dsh-plugin-fly-skins 同款）
  assert.ok(yml.includes(`name: '${pkg.name}'`), `patch 行名与包名不一致：期望 name: '${pkg.name}'`);
});

test('client 半边的 ModuleLoader id == npm 包名（scoped 时不是裸名）', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const client = readFileSync(join(ROOT, 'client.js'), 'utf8');
  assert.ok(client.includes(`id: '${pkg.name}',`),
    `client.js 的 ModuleLoader id 必须是完整包名（期望 ${pkg.name}）—— 否则浏览器端的模块图对不上`);
});

test('index.js is loadable ESM exposing apply()', async () => {
  const mod = await import(join(ROOT, 'index.js'));
  assert.equal(typeof mod.apply, 'function');
});

test('display resources exist with localized title/description', () => {
  for (const loc of ['en', 'zh']) {
    const j = JSON.parse(readFileSync(join(ROOT, 'locale', `${loc}.json`), 'utf8'));
    assert.ok(j.meta?.title?.length > 0, `${loc} title`);
    assert.ok(j.meta?.description?.length > 0, `${loc} description`);
  }
  assert.match(readFileSync(join(ROOT, 'icon.svg'), 'utf8'), /<svg/);
});
