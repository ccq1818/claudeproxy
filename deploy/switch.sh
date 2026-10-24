#!/usr/bin/env bash
# switch.sh — claudeproxy 出口切换（多 VPS 可复用）
#
# 用法：
#   ./switch.sh local          # 本地 facade（出口 = 本地 clash）
#   ./switch.sh <ssh别名>      # 隧道到指定 VPS（别名需在 ~/.ssh/config 里配好）
#                               例：./switch.sh vultr-jp   ./switch.sh aws-sg
#   ./switch.sh status         # 当前模式、隧道指向哪台 VPS、端口健康
#   ./switch.sh list           # 最近用过的目标清单
#
# 约定：每台 VPS 都按 DEPLOY.md 部署同一个 claudeproxy（同 key、默认端口 8466）。
# 客户端配置（BASE_URL=127.0.0.1:8466 + key）在所有目标之间完全不变。
set -euo pipefail

PORT="${CLAUDEPROXY_PORT:-8466}"
DIR="${CLAUDEPROXY_DIR:-$HOME/claudeproxy}"
LOCAL_PROXY="${CLAUDEPROXY_LOCAL_PROXY:-http://127.0.0.1:7890}"
HIST="$HOME/.claudeproxy-targets"

tunnel_pids() { pgrep -f "autossh.*-L ${PORT}:127.0.0.1:${PORT}" 2>/dev/null || true; }
facade_pids() { pgrep -f "node .*server\.mjs" 2>/dev/null | grep -v $$ || true; }

current_host() {
  local p; p="$(tunnel_pids | head -1)"
  [ -n "$p" ] && ps -o command= -p "$p" 2>/dev/null | awk '{print $NF}' || true
}
stop_tunnel() { local p; p="$(tunnel_pids)"; [ -n "$p" ] && kill $p 2>/dev/null && echo "tunnel down"; }
stop_facade() { local p; p="$(facade_pids)"; [ -n "$p" ] && kill $p 2>/dev/null && echo "local facade stopped"; }
remember() { touch "$HIST"; grep -qxF "$1" "$HIST" 2>/dev/null || echo "$1" >> "$HIST"; }

cmd="${1:-status}"
case "$cmd" in
  local)
    stop_tunnel
    if [ -z "$(facade_pids)" ]; then
      (cd "$DIR" && HTTPS_PROXY="$LOCAL_PROXY" HTTP_PROXY="$LOCAL_PROXY" nohup node server.mjs >/dev/null 2>&1 &)
      echo "local facade up (egress: local clash $LOCAL_PROXY)"
    else
      echo "local facade already up"
    fi
    ;;
  status)
    echo "mode:    $([ -n "$(tunnel_pids)" ] && echo "vps [$(current_host)]" || ([ -n "$(facade_pids)" ] && echo "local" || echo "none"))"
    echo "targets: $(paste -sd' ' "$HIST" 2>/dev/null || echo '(none used yet)')"
    curl -s -m 2 "http://127.0.0.1:${PORT}/health" && echo "  <- port ${PORT} answering" || echo "port ${PORT}: no answer"
    ;;
  list)
    echo "used targets:"; sed 's/^/  /' "$HIST" 2>/dev/null || true
    echo "any Host alias in ~/.ssh/config works: ./switch.sh <alias>"
    ;;
  *)
    # 任意其他参数都当作 ssh 别名（即某台 VPS）
    if ! ssh -G "$cmd" >/dev/null 2>&1; then
      echo "unknown target '$cmd' — add it to ~/.ssh/config first" >&2
      exit 1
    fi
    stop_facade
    stop_tunnel
    autossh -M 0 -f -N -L ${PORT}:127.0.0.1:${PORT} "$cmd"
    remember "$cmd"
    echo "tunnel up -> ${cmd} (egress: ${cmd} direct)"
    ;;
esac
