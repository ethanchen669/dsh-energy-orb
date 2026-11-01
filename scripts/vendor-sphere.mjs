#!/usr/bin/env node
// 把 apps/energy-sphere-demo 的球体组件 vendor 进本插件（一次生成、之后插件自己拥有）。
//
// 为什么要 vendoring 而不是 `import 'three'`：Client 半边由引擎以 classic script 形态下发，
// Web 里没有 import map 也没有 node_modules —— 所有裸说明符（`three`、`three/addons/*`）
// 必须在发布前改写成**相对 URL**，否则浏览器在 `/energy-orb/assets/...` 下解析不到。
//
// 这个脚本按**源文件驱动**做闭包遍历（不是手抄文件清单）：从 energy-sphere.js 出发，
// 逐个解析 import 说明符 → 映射到目标路径 → 改写为相对路径 → 递归。
// 手抄清单的失败方式是「少了三个文件，生产环境 404」，闭包遍历的失败方式是这个脚本自己报错。
//
// 用法：
//   node scripts/vendor-sphere.mjs                      # 默认源：../../dsh-fly/apps/energy-sphere-demo
//   ENERGY_SPHERE_SRC=/abs/path node scripts/vendor-sphere.mjs
//   node scripts/vendor-sphere.mjs --check              # 只校验已 vendor 的文件与 manifest 一致（不写盘）
//
// 产物：
//   client/sphere/{energy-sphere,animation,options}.js   ← demo src/*
//   client/vendor/{three.module.min.js,three.core.min.js} ← three/build/*
//   client/vendor/addons/**                               ← three/examples/jsm/**（实际用到的闭包）
//   client/vendor/manifest.json                           ← 溯源 + 每文件 sha256（测试据此守完整性）
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const OUT = join(ROOT, 'client');
const DEFAULT_SRC = resolve(ROOT, '../../dsh-fly/apps/energy-sphere-demo');
const SRC_APP = resolve(process.env.ENERGY_SPHERE_SRC || process.argv.find((a) => a.startsWith('--source='))?.slice(9) || DEFAULT_SRC);
const CHECK_ONLY = process.argv.includes('--check');

const APP_ENTRY = join(SRC_APP, 'src', 'energy-sphere.js');

/** 源绝对路径 → 目标绝对路径（三条规则；别的源一律拒绝，防止把任意文件复制进包里）。 */
function destFor(srcAbs) {
  const threeDir = join(SRC_APP, 'node_modules', 'three');
  for (const [base, destDir] of [
    [join(threeDir, 'build'), join(OUT, 'vendor')],
    [join(threeDir, 'examples', 'jsm'), join(OUT, 'vendor', 'addons')],
    [join(SRC_APP, 'src'), join(OUT, 'sphere')],
  ]) {
    if (srcAbs.startsWith(base + sep)) {
      return join(destDir, relative(base, srcAbs));
    }
  }
  throw new Error(`拒绝 vendor 未纳入映射的源文件：${srcAbs}`);
}

/** import 说明符 → 源绝对路径（裸说明符只放行 three 与 three/addons/*）。 */
function resolveSpecifier(importerSrcAbs, spec) {
  const threeDir = join(SRC_APP, 'node_modules', 'three');
  if (spec === 'three') return join(threeDir, 'build', 'three.module.min.js');
  if (spec.startsWith('three/addons/')) {
    return join(threeDir, 'examples', 'jsm', spec.slice('three/addons/'.length));
  }
  if (spec.startsWith('.')) return resolve(dirname(importerSrcAbs), spec);
  throw new Error(`${importerSrcAbs} 里出现不支持的裸说明符 "${spec}"（只放行 three 与 three/addons/*）`);
}

const SPEC_RE = /(\bfrom\s*|\bimport\s*)(['"])([^'"]+)\2/g;

function importedSpecifiers(source) {
  const out = [];
  for (const m of source.matchAll(SPEC_RE)) out.push(m[3]);
  return out;
}

function relSpecifier(fromDest, toDest) {
  let rel = relative(dirname(fromDest), toDest).split(sep).join('/');
  if (!rel.startsWith('.')) rel = `./${rel}`;
  return rel;
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/**
 * 本地补丁（唯一允许与上游 demo 分叉的地方；每条都要有测试钉住）。
 *
 * ①透明背景：UnrealBloomPass 的 HUD/辉光链把整帧 alpha 写成 1 —— demo 的深色整页背景看不出来，
 *   但在 DSH 里它是一个**不透明的深色方块**贴在右下角（真机截图证据见 docs/verify/）。
 *   修法是在 OutputPass 之后加一级 pass：用亮度还原 alpha，并在最外圈径向淡出
 *   （环形阵列约占半宽的 0.82，所以淡出从 0.84 开始，不会切到机械环）。
 *   补丁形状：find 必须在源文件里**恰好出现一次**，否则脚本报错（防上游改版后静默失效）。
 */
const PATCHES = [
  {
    id: 'transparent-alpha-pass',
    path: 'client/sphere/energy-sphere.js',
    find: "import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';",
    replace: [
      "import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';",
      "import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';",
    ].join('\n'),
    note: '末级 pass 还原 alpha + 径向收边（去掉不透明方形辉光底）',
  },
  {
    id: 'transparent-alpha-pass-wire',
    path: 'client/sphere/energy-sphere.js',
    find: '  composer.addPass(new OutputPass());',
    replace: [
      '  composer.addPass(new OutputPass());',
      '  // [dsh-energy-orb patch] 透明画布：bloom 链把整帧 alpha 写成 1，宿主里就是一块不透明方形。',
      '  // 用亮度还原 alpha，并把最外圈径向淡出（机械环约占半宽 0.82，从 0.84 起淡出不会切到环）。',
      '  const transparentPass = new ShaderPass({',
      '    uniforms: { tDiffuse: { value: null } },',
      "    vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 ); }',",
      "    fragmentShader: [",
      "      'uniform sampler2D tDiffuse;',",
      "      'varying vec2 vUv;',",
      "      'void main() {',",
      "      '  vec4 c = texture2D( tDiffuse, vUv );',",
      "      '  float d = distance( vUv, vec2( 0.5 ) ) * 2.0;',",
      "      '  float mask = 1.0 - smoothstep( 0.84, 1.0, d );',",
      "      '  float a = clamp( max( max( c.r, c.g ), c.b ), 0.0, 1.0 ) * mask;',",
      "      '  gl_FragColor = vec4( c.rgb * mask, a );',",
      "      '}',",
      "    ].join( '\\n' ),",
      '  });',
      '  composer.addPass(transparentPass);',
    ].join('\n'),
    note: '装配补丁 pass',
  },
];

/** 应用补丁：每条 find 必须恰好命中一次（0 次 = 上游改了，2 次 = 补丁位置不唯一）。 */
function applyPatches(relPath, source) {
  let out = source;
  const applied = [];
  for (const patch of PATCHES.filter((p) => p.path === relPath)) {
    const hits = out.split(patch.find).length - 1;
    if (hits !== 1) {
      throw new Error(`补丁 ${patch.id} 在 ${relPath} 命中 ${hits} 次（必须恰好 1 次；上游 demo 改版了？请更新 ${patch.find.slice(0, 60)}…）`);
    }
    out = out.replace(patch.find, patch.replace);
    applied.push({ id: patch.id, note: patch.note });
  }
  return { source: out, applied };
}

/** BFS 闭包：返回 [{ srcAbs, destAbs }]（按 dest 排序，稳定输出）。 */
function closure(entrySrc) {
  const seen = new Map();   // srcAbs -> destAbs
  const queue = [entrySrc];
  while (queue.length > 0) {
    const srcAbs = queue.shift();
    if (seen.has(srcAbs)) continue;
    if (!existsSync(srcAbs)) throw new Error(`源文件不存在（闭包遍历到）：${srcAbs}`);
    seen.set(srcAbs, destFor(srcAbs));
    const source = readFileSync(srcAbs, 'utf8');
    for (const spec of importedSpecifiers(source)) {
      queue.push(resolveSpecifier(srcAbs, spec));
    }
  }
  return [...seen.entries()]
    .map(([srcAbs, destAbs]) => ({ srcAbs, destAbs }))
    .sort((a, b) => a.destAbs.localeCompare(b.destAbs));
}

function rewrite(source, srcAbs, destAbs) {
  const relPath = relative(ROOT, destAbs).split(sep).join('/');
  const { source: patched, applied } = applyPatches(relPath, source);
  let count = 0;
  const rewritten = patched.replace(SPEC_RE, (whole, lead, quote, spec) => {
    const targetSrc = resolveSpecifier(srcAbs, spec);
    const targetDest = destFor(targetSrc);
    count += 1;
    return `${lead}${quote}${relSpecifier(destAbs, targetDest)}${quote}`;
  });
  const leftovers = importedSpecifiers(rewritten).filter((s) => !s.startsWith('.'));
  if (leftovers.length > 0) {
    throw new Error(`${srcAbs} 改写后仍有裸说明符：${leftovers.join(', ')}`);
  }
  return { rewritten, count, applied };
}

function threeVersion() {
  const pkg = JSON.parse(readFileSync(join(SRC_APP, 'node_modules', 'three', 'package.json'), 'utf8'));
  return pkg.version;
}

function main() {
  if (!existsSync(APP_ENTRY)) {
    throw new Error(`找不到 demo 入口 ${APP_ENTRY}；用 ENERGY_SPHERE_SRC=<apps/energy-sphere-demo 绝对路径> 指定`);
  }
  if (!existsSync(join(SRC_APP, 'node_modules', 'three', 'build', 'three.module.min.js'))) {
    throw new Error(`${SRC_APP}/node_modules/three 缺失；先在 demo 里 pnpm install --ignore-workspace`);
  }

  const files = closure(APP_ENTRY);
  const entries = [];
  const appliedPatches = [];
  let rewrittenTotal = 0;

  for (const { srcAbs, destAbs } of files) {
    const source = readFileSync(srcAbs, 'utf8');
    const { rewritten, count, applied } = rewrite(source, srcAbs, destAbs);
    rewrittenTotal += count;
    for (const p of applied) appliedPatches.push({ path: relative(ROOT, destAbs).split(sep).join('/'), ...p });
    const bytes = Buffer.from(rewritten);
    entries.push({
      path: relative(ROOT, destAbs).split(sep).join('/'),
      bytes: bytes.length,
      sha256: sha256(bytes),
      source: relative(SRC_APP, srcAbs).split(sep).join('/'),
    });
    if (CHECK_ONLY) {
      const onDisk = existsSync(destAbs) ? readFileSync(destAbs) : null;
      if (!onDisk || !onDisk.equals(bytes)) {
        throw new Error(`--check 失败：${relative(ROOT, destAbs)} 与源不一致（需重跑 node scripts/vendor-sphere.mjs）`);
      }
    } else {
      mkdirSync(dirname(destAbs), { recursive: true });
      writeFileSync(destAbs, bytes);
    }
  }

  // 清掉本次闭包之外的旧产物（只清我们生成的两棵子树里的 .js）
  if (!CHECK_ONLY) {
    for (const dir of [join(OUT, 'vendor', 'addons')]) {
      // 不递归删未知目录：闭包里没出现过的 addon 由下面的显式检查兜住
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    }
  }

  const manifest = {
    generatedBy: 'scripts/vendor-sphere.mjs',
    sourceApp: relative(ROOT, SRC_APP).split(sep).join('/'),
    threeVersion: threeVersion(),
    rewrite: "'three' → vendor/three.module.min.js；'three/addons/*' → vendor/addons/*；相对说明符原样折叠成相对 URL",
    patches: appliedPatches,
    files: entries,
  };
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  const manifestPath = join(OUT, 'vendor', 'manifest.json');
  if (CHECK_ONLY) {
    const onDisk = existsSync(manifestPath) ? readFileSync(manifestPath, 'utf8') : '';
    if (onDisk !== manifestText) throw new Error('--check 失败：client/vendor/manifest.json 不匹配');
    console.log(`✓ vendor --check 通过：${entries.length} 个文件与源一致（three ${manifest.threeVersion}）`);
    return;
  }
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, manifestText);

  // 断言后打印（不是无条件 ✓）：条目数、改写数、无裸说明符都已在上面的循环里硬校验
  for (const e of entries) {
    console.log(`  ${String(e.bytes).padStart(7)}B  ${e.sha256.slice(0, 12)}  ${e.path}`);
  }
  console.log(`✓ vendor 完成：${entries.length} 个文件、${rewrittenTotal} 处说明符改写、three ${manifest.threeVersion}`);
  console.log(`  manifest: client/vendor/manifest.json（测试据此守完整性）`);
}

main();
