#!/usr/bin/env bash
# harden-vps.sh — 在 VPS 上运行一次：把遥测/遥测类开关写进 ~/.claude/settings.json，
# 覆盖所有不经 facade 的手工 claude 调用（/login、手动 -p 等）。
# 应在 `claude /login` 之前运行，这样连登录会话本身都是静默的。
set -euo pipefail

mkdir -p "$HOME/.claude"
node -e '
const fs = require("fs");
const p = process.env.HOME + "/.claude/settings.json";
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(p, "utf8")); } catch {}
cfg.env = Object.assign({}, cfg.env, {
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  DISABLE_TELEMETRY: "1",
  DISABLE_ERROR_REPORTING: "1",
  DISABLE_AUTOUPDATER: "1",
  DISABLE_UPDATES: "1",
  DISABLE_BUG_COMMAND: "1",
  DO_NOT_TRACK: "1",
  CLAUDE_CODE_DISABLE_TERMINAL_TITLE: "1",
});
fs.writeFileSync(p, JSON.stringify(cfg, null, 2));
console.log("[harden] env written to " + p);
console.log(JSON.stringify(cfg.env, null, 2));
'
echo "[harden] done — now run: claude /login"
