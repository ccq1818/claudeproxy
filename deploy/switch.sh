#!/usr/bin/env bash
# switch.sh — 在「VPS 出口」与「本地 clash 出口」之间一键切换。
#
# 两端跑同一个 claudeproxy、同一个 key、同一个本地端口 127.0.0.1:8466：
#   vps   模式：本地 facade 停掉，SSH 隧道接通 VPS 的 facade（出口 = VPS 直连）
#   local 模式：隧道断开，本地 facade 启动（出口 = 本地 clash）
# 客户端（settings.json 的 BASE_URL/key）两种模式下完全不变。
#
# 用前配置：
#   export CLAUDEPROXY_VPS="vps"          # ~/.ssh/config 里的主机别名
#   export CLAUDEPROXY_DIR="$HOME/path/to/claudeproxy"   # 本地 claudeproxy 目录
#   两边 config.json 放同一个 key（或都用 CLAUDE_LOCAL_API_KEY 指定同一个值）
set -euo pipefail

VPS="${CLAUDEPROXY_VPS:-vps}"
DIR="${CLAUDEPROXY_DIR:-$HOME/claudeproxy}"
PORT=8466
LOCAL_PROXY="${CLAUDEPROXY_LOCAL_PROXY:-http://127.0.0.1:7890}"  # 本地 clash

tunnel_pid() { pgrep -f "autossh.*-L ${PORT}:127.0.0.1:${PORT}" || true; }
facade_pid() { pgrep -f "node ${DIR}/server.mjs" || pgrep -f "node server.mjs" || true; }

case "${1:-}" in
  vps)
    # 停本地 facade，起隧道 —— 出口切到 VPS
    local_pids="$(facade_pid)"; [ -n "$local_pids" ] && kill $local_pids 2>/dev/null && echo "local facade stopped"
    if [ -z "$(tunnel_pid)" ]; then
      autossh -M 0 -f -N -L ${PORT}:127.0.0.1:${PORT} "$VPS"
      echo "tunnel up -> ${VPS} (egress: VPS direct)"
    else
      echo "tunnel already up"
    fi
    ;;
  local)
    # 断隧道，起本地 facade（子进程经本地 clash 出去）
    t_pids="$(tunnel_pid)"; [ -n "$t_pids" ] && kill $t_pids 2>/dev/null && echo "tunnel down"
    if [ -z "$(facade_pid)" ]; then
      (cd "$DIR" && HTTPS_PROXY="$LOCAL_PROXY" HTTP_PROXY="$LOCAL_PROXY" nohup node server.mjs >/dev/null 2>&1 &)
      echo "local facade up (egress: local clash $LOCAL_PROXY)"
    else
      echo "local facade already up"
    fi
    ;;
  status)
    echo "tunnel: $([ -n "$(tunnel_pid)" ] && echo UP || echo down)   local facade: $([ -n "$(facade_pid)" ] && echo UP || echo down)"
    curl -s -m 2 "http://127.0.0.1:${PORT}/health" && echo " <- port ${PORT} answering" || echo "port ${PORT}: no answer"
    ;;
  *)
    echo "usage: $0 vps|local|status" >&2; exit 1 ;;
esac
