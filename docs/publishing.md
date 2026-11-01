# 发布这个插件（仓库内视角）

> 上游流程以 `dsh-fly` 主仓的 [`docs/plugin-publishing-sop.md`](../../dsh-fly/docs/plugin-publishing-sop.md) 为准；
> 这里只记**本仓特有的**那几步。

## 一次性：首次发布

包不存在时，npm 上**没有** Trusted Publisher 页面可填，所以第一版不能用 tag → OIDC 那条路：

```bash
cd ~/ai-workspace/dsh-plugins/dsh-energy-orb
npm login                                  # 需要 2FA，由人执行
npm stage publish --access public --registry=https://registry.npmjs.org/
# 然后去 npm 网页 → 该包的 Staged versions → 批准
```

> `npm publish` 直接发也要 2FA，且不带 provenance；`stage` 版本批准后才算发布。

## 一次性：Trusted Publisher（首版之后）

npm → `dsh-energy-orb` → **Settings → Trusted Publisher**：

```
Publisher            GitHub Actions
Organization or user ethanchen669
Repository           dsh-energy-orb
Workflow filename    release.yml
Allowed actions      ☑ Allow npm publish       ← 不勾只会"暂存"
Publishing access    ◉ Require 2FA and disallow bypass-2fa tokens
```

配好之后，推 `v*` tag 即自动发布（带 provenance），流程见 `.github/workflows/release.yml`。

## 每次发版

```bash
# ① 升版本 + 跑本仓门禁
node -e "…"        # 改 package.json version
npm test                                   # 单测（含 vendor 完整性 / 真 cordis 接线）
npm run verify:host                        # 可选：真 cordis + 真 webServer 集成
node scripts/vendor-sphere.mjs --check     # vendored 资产必须与上游 demo 一致

# ② 提交 + 注释 tag（tag 必须指向携带该版本的提交）
git add -A && git commit -F - <<'MSG'
chore(release): X.Y.Z —— <这一版做了什么>
MSG
git tag -a vX.Y.Z -m "vX.Y.Z — <一句话>"
git rev-parse --short=8 'vX.Y.Z^{commit}'; git rev-parse --short=8 HEAD   # 必须相等

# ③ 推（本机 github.com 直连不通，走 ssh.github.com:443）
GIT_SSH_COMMAND="ssh -o Hostname=ssh.github.com -o Port=443 -o ServerAliveInterval=10" \
  git push origin main && \
GIT_SSH_COMMAND="ssh -o Hostname=ssh.github.com -o Port=443 -o ServerAliveInterval=10" \
  git push origin refs/tags/vX.Y.Z
```

## 发布后验收（本仓已实测的姿势）

```bash
# ① attestation（最早到，读发布记录，不受 CDN 缓存影响）
curl -s -o /dev/null -w '%{http_code}\n' https://registry.npmjs.org/-/npm/v1/attestations/dsh-energy-orb@X.Y.Z
curl -s -o /dev/null -w '%{http_code}\n' https://registry.npmjs.org/-/npm/v1/attestations/dsh-energy-orb@99.99.99   # 必须 404（对照）

# ② dist-tags + readme 快照（换缓存键再看）
npm view dsh-energy-orb version --registry=https://registry.npmjs.org/ --prefer-online

# ③ tarball 直取
curl -sI https://registry.npmjs.org/dsh-energy-orb/-/dsh-energy-orb-X.Y.Z.tgz | head -1

# ④ 装一遍（最重要：发布成功 ≠ 能装）
S=$(mktemp -d /tmp/fly-install-XXXXXX) && cd "$S"
DSH_HOME="$S" dsh --profile fresh --from-default-profile web --dump-config >/dev/null
DSH_HOME="$S" dsh plugin --profile fresh add dsh-energy-orb@X.Y.Z --registry=https://registry.npmjs.org/
DSH_HOME="$S" dsh --profile fresh --dump-config | grep -c 'id: dsh-energy-orb'   # ≥ 1
```

本仓 2026-11-01 用 `npm pack` 产物在**仓库外 + 全新 profile** 上做过同款验证：
`dsh plugin add <tgz>` exit 0、装进来 `version 0.1.0`、`--dump-config` 里有 `- id: dsh-energy-orb`，
新实例上 `/energy-orb/assets/**` 15 个文件全 200、`/api/energy-orb/state` 返回契约 JSON。
