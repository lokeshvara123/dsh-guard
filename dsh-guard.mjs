// dsh-guard.mjs — DeepSeek Harness profile 保护工具
// 三层防线:vet(装前体检) / backup(健康快照) / restore(增量恢复,可排除新插件)
// 用法:
//   node dsh-guard.mjs health [--profile <name>]
//   node dsh-guard.mjs backup [label]
//   node dsh-guard.mjs list
//   node dsh-guard.mjs restore <backupDir> [--exclude pkg1,pkg2] [--dry-run]
//   node dsh-guard.mjs vet <pkg[@version]> [--depth 2]
//   node dsh-guard.mjs postcheck [--auto-fix] [--dry-run]
//   node dsh-guard.mjs crashwatch [--auto-fix] [--dry-run]
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

let PROFILE = process.env.DSH_PROFILE_DIR || path.join(os.homedir(), ".dsh", "profiles", "desktop");
const GUARD = process.env.DSH_GUARD_HOME || path.join(os.homedir(), "Documents", "deepseek-harness", "dsh-guard");
const BACKUPS = path.join(GUARD, "backups");
const SNAPSHOT_FILES = ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "cordis.patch.yml", "cordis.yml"];

// 定位 DSH 内置 pnpm(优先环境变量,再扫常见安装位置,最后退回 PATH 上的 pnpm)
function detectPnpmEntry() {
  const candidates = [
    process.env.DSH_GUARD_PNPM,
    path.join(process.env.LOCALAPPDATA || "", "Programs", "DeepSeek Harness", "resources", "runtime", "primary-runtime", "dependencies", "pnpm", "dist", "pnpm.mjs"),
    "C:\\Program Files\\DeepSeek Harness\\resources\\runtime\\primary-runtime\\dependencies\\pnpm\\dist\\pnpm.mjs",
    "C:\\Program Files (x86)\\DeepSeek Harness\\resources\\runtime\\primary-runtime\\dependencies\\pnpm\\dist\\pnpm.mjs",
    "K:\\Deepseek harness\\resources\\runtime\\primary-runtime\\dependencies\\pnpm\\dist\\pnpm.mjs"
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      // keep looking
    }
  }
  return undefined;
}
const PNPM_ENTRY = detectPnpmEntry();

// 会被"上古版本"投毒坑害的核心服务包(出现在 profile 依赖树里就危险)
const CORE_SERVICE_PREFIXES = [
  "@deepseek-ai/dsh-llm",
  "@deepseek-ai/dsh-session",
  "@deepseek-ai/dsh-agent",
  "@deepseek-ai/dsh-tools",
  "@deepseek-ai/dsh-web",
  "@deepseek-ai/dsh-plugin-manager",
  "@deepseek-ai/dsh-credentials",
  "@deepseek-ai/dsh-subagent",
  "@deepseek-ai/dsh-agent-preset",
  "@deepseek-ai/dsh-mcp",
  "@deepseek-ai/cordis"
];
// 与宿主同版本才安全的版本下限(0.2.2-rc.5 这一代)
function isCoreService(name) {
  return CORE_SERVICE_PREFIXES.some((p) => name === p || name.startsWith(p + "-"));
}
function riskyVersion(version) {
  if (!version) return false;
  const v = String(version).replace(/^[\^~>=<\s]+/, "");
  if (/^\d+\.\d+\.\d+/.test(v)) {
    const [major, minor] = v.split(".").map(Number);
    return major < 0 || (major === 0 && minor < 2);
  }
  return true; // 0.0.1-rc.x 之类都算可疑
}

const help = `
dsh-guard — DSH profile 保护工具
  health                     体检当前 profile(插件清单 / 危险依赖 / 补丁完整性)
  backup [label]             把当前 5 个配置文件快照到 backups/<时间戳>-<label>/
  list                       列出所有快照
  diff [backupDir]           对比快照与当前 profile(或两个快照),列出新增/移除的插件
  postcheck [--auto-fix]     安装后体检:毒依赖扫描、包目录完整性;--auto-fix 自动摘除肇事包
  crashwatch [--auto-fix]    崩溃后自动修复:读最新 crash 日志,定位故障类;--auto-fix 自动删除肇事插件
      --dry-run              只打印将执行的动作,不落盘
  restore <dir> [选项]       增量恢复(见下)
      --exclude pkg1,pkg2    恢复时排除这些包(默认只回滚,不清白名单)
      --force                pnpm install 加 --force 重建 node_modules
  vet <pkg[@ver]> [--depth 2] 装前体检:查 npm 依赖树里的危险 @deepseek-ai/* 与构建脚本
`;

// ---------- 工具函数 ----------
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return undefined; }
}
function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
}
function registryUrl(pkg) {
  return "https://registry.npmjs.org/" + encodeURIComponent(pkg).replace(/%40/g, "@");
}
async function registryJson(pkg) {
  const res = await fetch(registryUrl(pkg), { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`registry ${res.status} for ${pkg}`);
  return res.json();
}

// ---------- health ----------
function health() {
  const issues = [];
  const pkg = readJson(path.join(PROFILE, "package.json"));
  if (!pkg) { console.log("[FAIL] profile package.json 读不到"); return 1; }
  const bundles = pkg.dsh?.profile?.bundles ?? [];
  console.log(`bundles: ${bundles.length} 个`);
  for (const b of bundles) console.log(`  - ${b}`);
  const nmDeepseek = path.join(PROFILE, "node_modules", "@deepseek-ai");
  if (fs.existsSync(nmDeepseek)) {
    for (const name of fs.readdirSync(nmDeepseek)) {
      const v = readJson(path.join(nmDeepseek, name, "package.json"))?.version ?? "?";
      if (isCoreService("@deepseek-ai/" + name) && riskyVersion(v)) {
        issues.push(`[危险] profile 里存在核心包副本 @deepseek-ai/${name}@${v} — 会顶掉宿主版本,重启必崩,请删除`);
      } else {
        console.log(`  @deepseek-ai/${name} = ${v}${isCoreService("@deepseek-ai/" + name) ? " (核心包!若版本旧于宿主请删)" : ""}`);
      }
    }
  } else {
    console.log("  profile 无 @deepseek-ai 副本(最干净)");
  }
  const patch = path.join(PROFILE, "cordis.patch.yml");
  console.log(`cordis.patch.yml: ${fs.existsSync(patch) ? fs.statSync(patch).size + " bytes" : "缺失!"}`);
  if (issues.length) { console.log("\n问题:"); for (const i of issues) console.log("  " + i); return 1; }
  console.log("\n健康 ✅");
  return 0;
}

// ---------- backup / list ----------
function backup(label = "") {
  fs.mkdirSync(BACKUPS, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const dir = path.join(BACKUPS, `${stamp}${label ? "-" + label : ""}`);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of SNAPSHOT_FILES) {
    const src = path.join(PROFILE, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, f));
  }
  const pkg = readJson(path.join(PROFILE, "package.json"));
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({
    at: new Date().toISOString(),
    bundles: pkg?.dsh?.profile?.bundles ?? [],
    dependencies: pkg?.dependencies ?? {}
  }, null, 2) + "\n");
  console.log(`已备份 → ${dir}`);
  return dir;
}
function list() {
  if (!fs.existsSync(BACKUPS)) { console.log("还没有备份"); return 0; }
  const dirs = fs.readdirSync(BACKUPS).sort().reverse();
  for (const d of dirs) {
    const manifest = readJson(path.join(BACKUPS, d, "manifest.json"));
    const count = manifest?.bundles?.length ?? "?";
    console.log(`  ${d}  (bundles: ${count})`);
  }
  return 0;
}

// ---------- restore ----------
// 从备份恢复,支持排除新装的插件:只有被排除的包才会从 bundles/deps/patch 行里剥掉
function stripPatchRows(patchText, excluded) {
  const lines = patchText.split("\n");
  const out = [];
  let skipBlock = false;
  for (const line of lines) {
    const nameMatch = /^\s+name:\s*['"]?([^'"]+)['"]?\s*$/.exec(line);
    if (nameMatch && excluded.has(nameMatch[1].trim())) {
      skipBlock = true;
      // 向上回溯删除该 block 的 id 行(简单处理:跳过 id 行)
      for (let i = out.length - 1; i >= 0; i--) {
        if (/^\s+-?\s*id:\s*/.test(out[i]) || /^\s*-\s*id:\s*/.test(out[i])) { out.pop(); break; }
      }
      continue;
    }
    if (skipBlock) {
      if (/^\s*-\s+id:/.test(line) || /^\s*-\s+insert:/.test(line)) skipBlock = false;
      else continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

function restore(target, options) {
  const dryRun = options["dry-run"] === true;
  const excluded = new Set((options.exclude || "").split(",").map((s) => s.trim()).filter(Boolean));
  const dir = target.includes(path.sep) ? target : path.join(BACKUPS, target);
  if (!fs.existsSync(path.join(dir, "package.json"))) {
    console.error(`找不到备份: ${dir}`);
    console.error("可用备份:");
    list();
    return 1;
  }
  const backupPkg = readJson(path.join(dir, "package.json"));
  const bundles = (backupPkg?.dsh?.profile?.bundles ?? []).filter((b) => !excluded.has(b));
  const deps = { ...(backupPkg?.dependencies ?? {}) };
  for (const name of excluded) delete deps[name];
  const patchText = fs.readFileSync(path.join(dir, "cordis.patch.yml"), "utf8");
  const newPatch = excluded.size ? stripPatchRows(patchText, excluded) : patchText;

  const plan = [];
  plan.push(`从 ${dir} 恢复`);
  plan.push(`bundles: ${bundles.length} 个${excluded.size ? `(已排除: ${[...excluded].join(", ")})` : ""}`);
  if (dryRun) {
    console.log("[DRY-RUN] 将执行:");
    for (const p of plan) console.log("  " + p);
    console.log("  然后: node pnpm.mjs install --dir profile(重建 node_modules)");
    return 0;
  }
  writeJson(path.join(PROFILE, "package.json"), { ...backupPkg, dsh: { ...backupPkg.dsh, profile: { ...backupPkg.dsh?.profile, bundles } }, dependencies: deps });
  fs.writeFileSync(path.join(PROFILE, "cordis.patch.yml"), newPatch);
  for (const f of ["pnpm-lock.yaml", "pnpm-workspace.yaml", "cordis.yml"]) {
    const src = path.join(dir, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(PROFILE, f));
  }
  for (const p of plan) console.log("  " + p);
  console.log("配置文件已恢复。接下来运行 pnpm install 重建依赖…");
  return { needsInstall: true, force: options.force === true };
}

async function runPnpmInstall(force = false) {
  const { spawnSync } = await import("node:child_process");
  if (PNPM_ENTRY) {
    const args = [PNPM_ENTRY, "install", "--dir", PROFILE, "--reporter", "append-only"];
    if (force) args.push("--force");
    const r = spawnSync(process.execPath, args, {
      stdio: "inherit",
      env: { ...process.env },
      timeout: 600000
    });
    return r.status ?? 1;
  }
  const args = ["install", "--dir", PROFILE];
  if (force) args.push("--force");
  const r = spawnSync("pnpm", args, { stdio: "inherit", env: { ...process.env }, timeout: 600000 });
  if (r.error) {
    console.error("找不到 DSH 内置 pnpm,也找不到 PATH 上的 pnpm。请设置环境变量 DSH_GUARD_PNPM 指向 pnpm.mjs。");
    return 1;
  }
  return r.status ?? 1;
}

// ---------- vet ----------
async function vet(spec, depth = 2) {
  const at = spec.lastIndexOf("@");
  const pkg = at > 0 ? spec.slice(0, at) : spec;
  const version = at > 0 ? spec.slice(at + 1) : undefined;
  console.log(`体检 ${pkg}${version ? "@" + version : "(latest)"} …`);
  const meta = await registryJson(pkg);
  const target = version ?? meta["dist-tags"]?.latest;
  const info = meta.versions?.[target];
  if (!info) { console.error(`版本 ${target} 不存在`); return 1; }
  let flags = 0;
  const seen = new Set();
  async function walk(deps, level, chain) {
    if (level > depth) return;
    for (const [name, ver] of Object.entries(deps ?? {})) {
      if (seen.has(name)) continue;
      seen.add(name);
      if (isCoreService(name)) {
        if (riskyVersion(ver)) {
          console.log(`  [危险] ${name}@${ver} (来自 ${chain}) — 旧版核心包,会顶掉宿主,禁止安装`);
          flags++;
        } else {
          console.log(`  [留意] ${name}@${ver} (来自 ${chain})`);
        }
        continue;
      }
      if (name.startsWith("@deepseek-ai/")) {
        console.log(`  [信息] ${name}@${ver} (来自 ${chain})`);
      }
      try {
        const sub = await registryJson(name);
        const subVer = sub["dist-tags"]?.latest;
        const subInfo = sub.versions?.[subVer];
        await walk(subInfo?.dependencies, level + 1, chain + " → " + name);
      } catch {
        // 拉不到就不深挖
      }
    }
  }
  await walk(info.dependencies, 1, pkg);
  const scripts = info.scripts ?? {};
  const buildScripts = Object.entries(scripts).filter(([k]) => ["preinstall", "install", "postinstall"].includes(k));
  for (const [k, cmd] of buildScripts) {
    console.log(`  [构建脚本] ${k}: ${String(cmd).slice(0, 100)}`);
  }
  if (!flags && buildScripts.length === 0) console.log("体检通过 ✅ 未发现危险核心依赖或构建脚本");
  else if (!flags) console.log("注意:有构建脚本(安装时可能触发 build-blocked 审批)");
  return flags > 0 ? 1 : 0;
}

// ---------- diff ----------
function diff(target) {
  const dir = target ? (target.includes(path.sep) ? target : path.join(BACKUPS, target)) : undefined;
  const other = dir ? readJson(path.join(dir, "package.json")) : undefined;
  const current = readJson(path.join(PROFILE, "package.json"));
  const a = dir ? (other?.dsh?.profile?.bundles ?? []) : (other ? other.dsh?.profile?.bundles : []);
  const b = current?.dsh?.profile?.bundles ?? [];
  const removed = a.filter((x) => !b.includes(x));
  const added = b.filter((x) => !a.includes(x));
  if (dir) console.log(`对比 ${dir} → 当前 profile`);
  else if (!fs.existsSync(BACKUPS)) { console.log("没有快照可对比,先 backup 一次"); return 1; }
  else {
    const dirs = fs.readdirSync(BACKUPS).sort();
    const latest = dirs[dirs.length - 1];
    const bak = readJson(path.join(BACKUPS, latest, "package.json"));
    const bakBundles = bak?.dsh?.profile?.bundles ?? [];
    const removed2 = bakBundles.filter((x) => !b.includes(x));
    const added2 = b.filter((x) => !bakBundles.includes(x));
    console.log(`对比 最新快照 ${latest} → 当前 profile`);
    console.log(`  新增的插件: ${added2.length ? added2.join(", ") : "(无)"}`);
    console.log(`  移除的插件: ${removed2.length ? removed2.join(", ") : "(无)"}`);
    return 0;
  }
  console.log(`  新增的插件: ${added.length ? added.join(", ") : "(无)"}`);
  console.log(`  移除的插件: ${removed.length ? removed.join(", ") : "(无)"}`);
  return 0;
}

// ---------- postcheck / 肇事包定位 ----------
// 在 profile 依赖树里找出引入某个危险核心包的直接依赖(肇事者)
function findCulprit(riskyName) {
  const pkg = readJson(path.join(PROFILE, "package.json"));
  const deps = pkg?.dependencies ?? {};
  for (const [dep, ver] of Object.entries(deps)) {
    const depDir = path.join(PROFILE, "node_modules", dep, "package.json");
    const info = readJson(depDir);
    if (!info) continue;
    const found = Object.entries(info.dependencies ?? {}).some(([n, v]) => n === riskyName && riskyVersion(v));
    if (found) return { dep, ver };
  }
  return undefined;
}

function scanPoison() {
  const found = [];
  const nmDeepseek = path.join(PROFILE, "node_modules", "@deepseek-ai");
  if (!fs.existsSync(nmDeepseek)) return found;
  for (const name of fs.readdirSync(nmDeepseek)) {
    const full = "@deepseek-ai/" + name;
    if (!isCoreService(full)) continue;
    const v = readJson(path.join(nmDeepseek, name, "package.json"))?.version ?? "?";
    if (riskyVersion(v)) found.push({ name: full, version: v });
  }
  return found;
}

// 从当前 profile 中摘除指定插件(清单 + 依赖 + 补丁行),并重建 node_modules
async function removeFromProfile(names, { dryRun, force = true } = {}) {
  const pkg = readJson(path.join(PROFILE, "package.json"));
  const bundles = (pkg?.dsh?.profile?.bundles ?? []).filter((b) => !names.includes(b));
  const deps = { ...(pkg?.dependencies ?? {}) };
  for (const n of names) delete deps[n];
  const patch = fs.readFileSync(path.join(PROFILE, "cordis.patch.yml"), "utf8");
  const newPatch = stripPatchRows(patch, new Set(names));
  console.log(`将摘除: ${names.join(", ")}`);
  if (dryRun) {
    console.log("[DRY-RUN] 未落盘。");
    return 0;
  }
  writeJson(path.join(PROFILE, "package.json"), { ...pkg, dsh: { ...pkg.dsh, profile: { ...pkg.dsh?.profile, bundles } }, dependencies: deps });
  fs.writeFileSync(path.join(PROFILE, "cordis.patch.yml"), newPatch);
  console.log("已更新配置,重建依赖…");
  const status = await runPnpmInstall(force);
  if (status !== 0) { console.error("pnpm install 失败,请检查网络后重跑 postcheck --auto-fix"); return 1; }
  console.log("摘除完成,重新体检:");
  return health();
}

async function postcheck(options) {
  const dryRun = options["dry-run"] === true;
  const poison = scanPoison();
  const pkg = readJson(path.join(PROFILE, "package.json"));
  const bundles = pkg?.dsh?.profile?.bundles ?? [];
  console.log(`postcheck: bundles ${bundles.length} 个`);
  const missing = [];
  for (const b of bundles) {
    if (b.startsWith("@deepseek-ai/dsh")) continue; // 宿主包不看目录
    if (!fs.existsSync(path.join(PROFILE, "node_modules", b))) missing.push(b);
  }
  if (missing.length) console.log(`  [问题] 包目录缺失: ${missing.join(", ")}`);
  if (poison.length === 0 && missing.length === 0) {
    console.log("postcheck 通过 ✅ 可放心重启");
    return 0;
  }
  for (const p of poison) {
    const culprit = findCulprit(p.name);
    console.log(`  [危险] ${p.name}@${p.version}${culprit ? ` ← 肇事插件 ${culprit.dep}(${culprit.ver})` : " ← 孤立残留"}`);
  }
  if (options["auto-fix"]) {
    const targets = new Set();
    for (const p of poison) {
      const culprit = findCulprit(p.name);
      if (culprit) targets.add(culprit.dep);
    }
    if (targets.size === 0 && poison.length > 0) {
      console.log("  没有找到肇事插件(孤立残留),直接删除危险目录…");
      if (!dryRun) {
        for (const p of poison) fs.rmSync(path.join(PROFILE, "node_modules", p.name), { recursive: true, force: true });
        await runPnpmInstall(true);
      }
      return health();
    }
    return removeFromProfile([...targets], { dryRun, force: true });
  }
  console.log("  (加 --auto-fix 自动摘除肇事插件,或加 --dry-run 预览)");
  return 1;
}

// ---------- crashwatch ----------
const CRASH_DIR = path.join(process.env.APPDATA || "", "@deepseek-ai", "dsh-desktop", "logs");
const MARKER = path.join(GUARD, "crashwatch.marker");

async function crashwatch(options) {
  const dryRun = options["dry-run"] === true;
  if (!fs.existsSync(CRASH_DIR)) { console.log("crash 日志目录不存在"); return 0; }
  const lastSeen = fs.existsSync(MARKER) ? Number(fs.readFileSync(MARKER, "utf8")) : 0;
  const logs = fs.readdirSync(CRASH_DIR)
    .filter((f) => /^crash-.*\.log$/.test(f))
    .map((f) => ({ f, t: fs.statSync(path.join(CRASH_DIR, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  const fresh = logs.filter((l) => l.t > lastSeen);
  if (fresh.length === 0) {
    console.log("没有新的崩溃日志 ✅");
    return 0;
  }
  const newest = fresh[0];
  const content = fs.readFileSync(path.join(CRASH_DIR, newest.f), "utf8");
  const errIdx = content.indexOf("--- error ---");
  const errText = errIdx >= 0 ? content.slice(errIdx, errIdx + 1500) : content.slice(0, 1200);
  console.log(`发现新崩溃日志: ${newest.f}`);
  const fatal = errText.includes("required plugins did not activate");
  const poison = scanPoison();
  if (fatal) {
    console.log("  故障类型: 启动即崩(核心服务未激活)—— 典型的毒插件顶包");
    if (poison.length > 0) {
      for (const p of poison) {
        const culprit = findCulprit(p.name);
        console.log(`  [危险] ${p.name}@${p.version}${culprit ? ` ← 肇事插件 ${culprit.dep}` : " ← 孤立残留"}`);
      }
    } else {
      console.log("  当前 profile 已无危险核心包残留(可能已被清掉/已修复)");
    }
  } else {
    console.log("  故障类型: 其它(截取前 600 字):");
    console.log("    " + errText.slice(0, 600).split("\n").slice(0, 8).join("\n    "));
  }
  if (options["auto-fix"] && fatal && poison.length > 0) {
    const targets = new Set();
    for (const p of poison) {
      const culprit = findCulprit(p.name);
      if (culprit) targets.add(culprit.dep);
    }
    if (targets.size > 0) {
      const status = await removeFromProfile([...targets], { dryRun, force: true });
      fs.writeFileSync(MARKER, String(newest.t));
      console.log("修复完成。请完全退出并重启 DSH(如弹恢复框,点「重启」)。");
      return status;
    }
  }
  if (!dryRun) fs.writeFileSync(MARKER, String(newest.t));
  console.log("(加 --auto-fix 自动摘除肇事插件,或加 --dry-run 预览)");
  return fatal ? 1 : 0;
}

// ---------- main ----------
const args = process.argv.slice(2);
const cmd = args[0];
const rest = args.slice(1);const options = {};
const positionals = [];
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  if (a.startsWith("--")) {
    const eq = a.indexOf("=");
    if (eq >= 0) {
      options[a.slice(2, eq)] = a.slice(eq + 1);
    } else {
      const key = a.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        options[key] = next;
        i++;
      } else {
        options[key] = true;
      }
    }
  } else positionals.push(a);
}

// 支持 --profile <name> 与 DSH_PROFILE_DIR 环境变量(默认 desktop)
if (options.profile && typeof options.profile === "string") {
  PROFILE = path.join(os.homedir(), ".dsh", "profiles", options.profile);
}

try {
  switch (cmd) {
    case "health": process.exit(health());
    case "backup": backup(positionals[0]); process.exit(0);
    case "list": process.exit(list());
    case "restore": {
      const r = restore(positionals[0], options);
      if (r === 1) process.exit(1);
      if (r?.needsInstall) {
        console.log("运行 pnpm install(可能需要几分钟)…");
        const status = await runPnpmInstall(r.force);
        process.exit(status === 0 ? 0 : 1);
      }
      process.exit(0);
    }
    case "vet": process.exit(await vet(positionals[0], Number(options.depth) || 2));
    case "diff": process.exit(diff(positionals[0]));
    case "postcheck": process.exit(await postcheck(options));
    case "crashwatch": process.exit(await crashwatch(options));
    default: console.log(help); process.exit(0);
  }
} catch (error) {
  console.error("出错:", error?.message || error);
  process.exit(1);
}
