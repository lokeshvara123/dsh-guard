# dsh-guard

DeepSeek Harness profile 保护工具:装前体检、安装后自检、崩溃后自动修复 —— 让你的插件生态不再被"一刀切"清空。

## 解决什么问题

DSH 桌面端的故障恢复是"一刀切"的:启动失败时,点一下「禁用第三方插件」就会把**所有**社区插件清空。更糟的是,一些社区插件在依赖里钉死了上古版本的 `@deepseek-ai/dsh-*` 核心包,安装后会在下次启动时顶掉宿主的官方版本,直接导致启动崩溃。

dsh-guard 在 DSH 外面(纯 Node,崩溃时也能运行)提供三道防线:

1. **装前体检 `vet`** — 查 npm 依赖树,带旧版核心包的插件直接拦下;
2. **安装后自检 `postcheck`** — 扫描 profile 里的危险依赖与包完整性,`--auto-fix` 自动摘除肇事插件(只删它一个);
3. **崩溃后自动修复 `crashwatch`** — 读 DSH 崩溃日志,自动定位并删除肇事插件,其余插件不动。

另有 `backup` / `restore` / `diff` / `list` / `health` 做快照与增量恢复。

## 安装

单文件脚本,无需安装依赖:

```bash
# 放到任何地方,例如:
#   Windows: Documents\deepseek-harness\dsh-guard\
#   macOS/Linux: ~/dsh-guard/
node dsh-guard.mjs health
```

Windows 下附带 `dsh-guard.cmd`,可直接 `dsh-guard health`。要求 Node.js ≥ 18。

## 命令

| 命令 | 说明 |
|---|---|
| `health [--profile X]` | 体检当前 profile:插件清单、危险依赖、补丁完整性 |
| `vet <pkg[@ver]> [--depth 2]` | 装前体检:依赖树里的危险 `@deepseek-ai/*` 与构建脚本 |
| `postcheck [--auto-fix] [--dry-run]` | 安装后自检;`--auto-fix` 自动摘除肇事插件 |
| `crashwatch [--auto-fix] [--dry-run]` | 读最新 DSH 崩溃日志,分类并(可选)自动修复 |
| `backup [label]` | 快照当前 5 个配置文件到 backups/ |
| `list` / `diff [快照]` | 列出快照 / 对比快照与当前 profile 的插件差异 |
| `restore <快照> [--exclude a,b] [--force] [--dry-run]` | 增量恢复,可排除出问题的新插件 |

## 环境变量

- `DSH_GUARD_PROFILE` 或 `--profile` — profile 名(默认 `desktop`);
- `DSH_PROFILE_DIR` — profile 目录(优先级最高);
- `DSH_GUARD_PNPM` — DSH 内置 pnpm.mjs 的路径(未自动探测到时);
- `DSH_GUARD_HOME` — 工具数据目录(快照、标记),默认 `~/Documents/deepseek-harness/dsh-guard`。

## 推荐工作流

```
# 装新插件前
dsh-guard vet <pkg>
# 装完后、重启前
dsh-guard postcheck --auto-fix && dsh-guard backup after-<pkg>
# 如果启动失败(在任意终端,DSH 崩溃也能跑)
dsh-guard crashwatch --auto-fix
```

## 工作原理简述

- **毒依赖识别**:profile 的 `node_modules/@deepseek-ai/` 里出现核心服务包(`dsh-llm` / `dsh-session` / `dsh-agent` / `dsh-tools` / `dsh-web` / `dsh-plugin-manager` / `dsh-credentials` / `dsh-subagent` / `dsh-agent-preset` / `dsh-mcp` / `cordis`)且版本低于 0.2.x 时,即判定为危险,并沿 profile 依赖反向定位肇事插件;
- **崩溃分类**:解析 `crash-*.log` 的 `--- error ---` 段,识别 `required plugins did not activate` 这一"毒包顶核心"故障类;
- **摘除**:只把肇事包从 `dsh.profile.bundles`、`dependencies` 与 `cordis.patch.yml` 的行里移除,再用 pnpm 重建依赖,其余插件不动。

## License

MIT
