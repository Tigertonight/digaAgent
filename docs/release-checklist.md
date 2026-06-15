# Release Checklist

发版前在 macOS（arm64 主机）至少跑完下面这一遍。优先目标是把
"本地能跑、DMG 起不来"这个高发问题的复现成本压到 5 分钟内。

## 第一道：自动 release-smoke

```
npm run electron:build
npm run release:smoke
```

`release:smoke` 会：

1. 在 `dist/` 自动选最新的 `*.dmg`（也可以传 `--dmg path`）；
2. `hdiutil attach`，把 `.app` 复制到一个临时 `Applications` 目录；
3. `xattr -cr` 清掉所有 quarantine 属性；
4. 在 `mktemp -d` 出来的 **临时 `$HOME`** 下启动 app（让 `~/.pi`、`~/.diga-agent`、Keychain 都是干净的）；
5. 等 `/api/health`；
6. 跑 `scripts/smoke-test.mjs` 走完所有公开 endpoint；
7. 把摘要写到 `dist/release-smoke-summary.json`，包含最近 50 行 stdout，
   失败时还会落 `app-output.log`。

退出码非 0 = 这版 DMG 不能发。

## 第二道：手动测试矩阵

跑 release-smoke 通过后，再过下面这张表。每行勾一遍。

| # | 场景 | 期望 |
|---|------|------|
| 1 | 干净 HOME（release-smoke 路径）| /api/health 200，主窗口出来 |
| 2 | 已有 `~/.pi/auth.json`，没有 `~/.diga-agent` | 老用户路径：能识别已有 auth；不会 panic |
| 3 | 已有旧版 `~/.diga-agent/settings.json` | 配置正确读出（含 budget、远程模式）|
| 4 | DMG 内直接双击 | 启动成功；不会出现"已损坏"对话框 |
| 5 | 拖到 `/Applications` 后启动 | 同上；菜单栏能用 |
| 6 | 无网络启动 | 主窗口仍可加载，远程功能优雅降级 |
| 7 | 没 Homebrew、没 cloudflared | 远程开关里显示"未安装"，不卡死 |
| 8 | Keychain 已锁定 / keytar 读失败 | 启动不挂；菜单 → 导出诊断 → keytar.ok=false |
| 9 | Apple Silicon 原生 arm64 | 默认路径 |
| 10 | Intel / Rosetta（如果支持）| 同 1 一样能跑 |

每项失败时：菜单 → Help → "导出诊断信息…"，把 JSON 附到 issue 里。

## 一旦用户报障

让用户先做这两步：

1. 菜单 → Help → "导出诊断信息…"，把生成的 JSON 发回。诊断包含：
   - app 版本、平台、是否 packaged、各种路径
   - quarantine / xattr 检测
   - keytar 是否能 init
   - `/api/health`、`/api/auth`、`/api/models-config` 探针
   - `~/.pi`、`~/.diga-agent` 是否存在 / size（不读内容）
   - 最近 200 行主进程 + server 子进程 stdio（已 redact API key 模板）
2. 如果 app 完全打不开（菜单都没法点），让他们在终端跑：
   ```
   xattr -dr com.apple.quarantine "/Applications/Diga Agent.app"
   "/Applications/Diga Agent.app/Contents/MacOS/Diga Agent" 2>&1 | head -100
   ```
   把这段贴回来。

## 已知坑

- **DMG 未签名/未公证**：用户必须手动 `xattr -dr com.apple.quarantine`。
  release-smoke 已经会自己跑，但用户不会自动跑，README 仍需明显提示。
  下一步如果上 codesign + notarize，本 checklist 第 4、5 行的失败概率会大幅下降。
- **GUI 启动 PATH 不同于终端 PATH**：对 cloudflared / brew 等外部 CLI 的查找需要
  考虑 `/opt/homebrew/bin`、`/usr/local/bin`，不能只信 `process.env.PATH`。
  当前主进程通过 `resolveBrewPath / resolveCloudflaredPath` 兜底；导出诊断里的
  `system.pathEntryCount` 可作为体现 PATH 是否被吃掉的早期信号。
- **electron-builder 复制依赖范围**：`scripts/build-electron.mjs` 已经把根
  package.json 的 dependencies 临时改成只剩 keytar（其余依赖来自
  `.next/standalone/node_modules`）。新引入根级 native binding 时务必更新
  `RUNTIME_DEPS`，并跑 `release:smoke` 验证。
