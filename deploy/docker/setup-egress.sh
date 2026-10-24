#!/usr/bin/env bash
# 把宿主机额外的出口 IP 绑定到网卡，并给每个容器写 SNAT 规则（出口 IP 固定）。
# 用法：sudo bash setup-egress.sh <网卡> <ip1> <ip2> <ip3>   例：sudo bash setup-egress.sh eth0 104.223.81.2 104.223.81.3 104.223.81.4
# 容器固定内网 IP 与 docker-compose.yml 对应：cpx1=172.28.0.11 cpx2=.12 cpx3=.13
set -euo pipefail
IFACE="${1:?usage: setup-egress.sh <iface> <ip1> <ip2> <ip3>}"; shift
[ "$#" -eq 3 ] || { echo "need exactly 3 egress IPs"; exit 1; }
IPS=("$1" "$2" "$3" "$1" "$2" "$3")
CIDS=(172.28.0.11 172.28.0.12 172.28.0.13 172.28.0.21 172.28.0.22 172.28.0.23)
for i in 0 1 2 3 4 5; do
  ip="${IPS[$i]}"; cid="${CIDS[$i]}"
  ip addr add "$ip/32" dev "$IFACE" 2>/dev/null || echo "alias $ip already present"
  # delete stale attempts, then INSERT at the top: docker's own MASQUERADE for the
  # bridge subnet would otherwise match first and egress via the primary IP
  while iptables -t nat -D POSTROUTING -s "$cid" -j SNAT --to-source "$ip" 2>/dev/null; do :; done
  iptables -t nat -I POSTROUTING 1 -s "$cid" -j SNAT --to-source "$ip"
  echo "container ($cid) -> egress $ip"
done
echo "done. 验证：各容器 docker exec <c> curl -s https://api.ipify.org 应返回其绑定 IP"
