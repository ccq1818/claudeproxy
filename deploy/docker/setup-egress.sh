#!/usr/bin/env bash
# 把宿主机额外的出口 IP 绑定到网卡，并给每个容器写 SNAT 规则（出口 IP 固定）。
# 用法：sudo bash setup-egress.sh <网卡> <ip1> <ip2> <ip3>   例：sudo bash setup-egress.sh eth0 104.223.81.2 104.223.81.3 104.223.81.4
# 容器固定内网 IP 与 docker-compose.yml 对应：cpx1=172.28.0.11 cpx2=.12 cpx3=.13
set -euo pipefail
IFACE="${1:?usage: setup-egress.sh <iface> <ip1> <ip2> <ip3>}"; shift
[ "$#" -eq 3 ] || { echo "need exactly 3 egress IPs"; exit 1; }
CIDS=(172.28.0.11 172.28.0.12 172.28.0.13)
for i in 0 1 2; do
  ip="${!i}"; cid="${CIDS[$i]}"
  ip addr add "$ip/32" dev "$IFACE" 2>/dev/null || echo "alias $ip already present"
  iptables -t nat -D POSTROUTING -s "$cid" -j SNAT --to-source "$ip" 2>/dev/null || true
  iptables -t nat -A POSTROUTING -s "$cid" -j SNAT --to-source "$ip"
  echo "container cpx$((i+1)) ($cid) -> egress $ip"
done
echo "done. 验证：docker exec cpx1 curl -s https://api.ipify.org  应返回 ${!0}... 用各容器分别试"
