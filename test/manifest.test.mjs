import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('package.json declares the bundle manifest', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'dsh-energy-orb');
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml');
  assert.equal(pkg.dsh.client.platform, 'web');
  for (const key of ['.', './client', './icon']) {
    assert.ok(pkg.exports[key], `exports missing ${key}`);
  }
});

test('cordis.patch.yml inserts the dsh-energy-orb row', () => {
  const yml = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8');
  assert.match(yml, /id:\s*['"]?dsh-energy-orb/);
  assert.match(yml, /name:\s*['"]?dsh-energy-orb/);
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
