# claudeproxy 部署手册（VPS）

## 0. 前置

- VPS：Linux，Node ≥ 22（`node -v` 确认；内置 SQLite 需要）
- 出口干净（这是你选 VPS 的原因，不赘述）

## 1. 安装 claude code 并登录（一次性，SSH 交互）

```bash
npm install -g @anthropic-ai/claude-code   # 或官方原生安装脚本

claude /login
```

无头机器的登录流程：
1. 终端打印一个 `https://claude.com/oauth/authorize?...` 链接
2. 复制到**本地浏览器**打开，登录你的账号并授权
3. 浏览器页面给出一串授权码 → 粘贴回 SSH 终端
4. 凭证写入 `~/.claude/`（Linux 无 Keychain，存 `.credentials.json`）

验证：`claude -p "hi"` 有正常回复即成功。之后 token 自动续期，不再需要交互。
（本地 Mac 上是否登出互不影响：同一账号多设备登录是正常形态。）

## 2. 部署 claudeproxy

```bash
git clone https://github.com/ccq1818/claudeproxy && cd claudeproxy
npm install

# 前台试跑（凭证自动复用第 1 步的登录）
CLAUDE_LOCAL_API_KEY=换成你的固定key node server.mjs

# 另一个 SSH 窗口验证
curl -H "x-api-key: 首次启动打印的key" http://127.0.0.1:8466/v1/messages \
  -H 'content-type: application/json' \
  -d '{"model":"sonnet","messages":[{"role":"user","content":"ping"}]}'
```

## 3. 常驻（systemd）

```bash
sudo cp deploy/claudeproxy.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now claudeproxy
```

（unit 文件假设部署在 `/opt/claudeproxy`，key 写在 `/etc/claudeproxy.env`，自行对照修改。）

## 4. 安全暴露（二选一）

**方案 A：SSH 隧道（推荐，零新增面）**
```bash
# 本地常驻隧道
autossh -M 0 -f -N -L 8466:127.0.0.1:8466 你的vps
```
facade 保持只绑 127.0.0.1，key 都可以不设。

**方案 B：公网 + TLS + key（caddy 反代）**
```bash
# deploy/Caddyfile 示例：域名 A 记录指向 VPS，caddy 自动签证书
```
必须 TLS（固定 key 走明文 HTTP 可被嗅探）。

## 5. 本地客户端配置

`~/.claude/settings.json` 的 `env` 块（claude 自己的机制，只对 claude 进程生效）：

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8466",
    "ANTHROPIC_API_KEY": "你的固定key",
    "DISABLE_TELEMETRY": "1",
    "DISABLE_ERROR_REPORTING": "1",
    "DISABLE_GROWTHBOOK": "1",
    "DISABLE_AUTOUPDATER": "1",
    "DISABLE_UPDATES": "1",
    "DISABLE_BUG_COMMAND": "1",
    "DO_NOT_TRACK": "1"
  }
}
```

## 6. 上线后第一件事：真机压测

mock 环境验证的是协议，不是全部真实行为。拿真实编码会话压：
连续工具调用、长会话（观察后段延迟——会话回放成本）、`/compact`、粘贴图片、并行子代理。
出问题看 `journalctl -u claudeproxy -f`。

## 本地/云端一键切换（可选）

两边跑同一个 claudeproxy、**同一个 key**（config.json 拷贝过去，或两边同设 `CLAUDE_LOCAL_API_KEY`）、同一个本地端口。
客户端的 `BASE_URL`/`ANTHROPIC_API_KEY` 永远不变，切换的只是 127.0.0.1:8466 背后是谁：

```bash
./deploy/switch.sh vps     # 断本地 facade，接 SSH 隧道 -> VPS 直连出口
./deploy/switch.sh local   # 断隧道，起本地 facade -> 本地 clash 出口
./deploy/switch.sh status  # 查看当前状态
```

说明：VPS 上**不需要**再装 clash——如果你本地 clash 的出口就是这台 VPS（如 vultr-经日本），
那账号的 IP 历史本就一直是这个 IP，VPS 直连反而是最一致的形态；再套一层代理才会打破一致性。

## 运维备忘

- OAuth 过期兜底：`claude -p hi` 报未登录时，SSH 上去重跑 `claude /login`
- 回滚：`git log` 之外，v2.3 备份实现见仓库 release / 本地 `server.v2.3.mjs.bak`
- 日志：stdout 进 journald；`/health` 可探活（含活跃 worker 数）
