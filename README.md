# claude-local-api v2.3

把本机的 Claude Code 会话（官方 Agent SDK 驱动）封装成 **Anthropic Messages API 兼容**的本地 HTTP 入口，仅供本机应用调用。认证自动使用本机 Claude Code 登录态（Keychain OAuth）或 `ANTHROPIC_API_KEY`。

## 持久化（v2.3 新增）

会话亲和映射通过 SQLite（node:sqlite，零依赖）**写透持久化**到 `affinity.db`，facade 重启后自动回灌——进行中的对话重启后仍恢复原云端会话，1 小时窗口内的上游 prompt 缓存照常命中（已实测：重启前后同会话 ID、历史原生递增）。路径可用 `CLAUDE_LOCAL_AFFINITY_DB` 自定义。

## 会话亲和（v2.2，核心特性）

云端会话的生命周期**完全跟随调用方的真实对话**：同一对话的多轮请求（含工具往返）自动复用同一个云端会话——会话 ID、历史增长、prompt 缓存前缀的行为与本地直连使用**完全一致**；开新对话才开新会话。分组键优先级：`x-claude-session-id`（本扩展头）→ `x-claude-code-session-id`（本地 claude 原生自带）→ 首条消息指纹兜底。对话历史分叉/参数变更时自动降级为新会话，绝不串话。

## 访问认证（v2.1 新增）

- **零配置（默认）**：首次启动自动生成 `sk-cpx-` 前缀的随机 key，打印到控制台并保存到 `config.json`（权限 600，已 gitignore）；之后启动自动复用。
- **自定义**：设 `CLAUDE_LOCAL_API_KEY` 环境变量覆盖自动生成。
- 校验方式：`Authorization: Bearer <key>` 或 `x-api-key: <key>`（常量时间比对，`/health` 开放探活）；客户端侧即 `ANTHROPIC_API_KEY=<key>` + `ANTHROPIC_BASE_URL`，零额外适配。

> **TLS 警告**：固定 key 若走明文 HTTP 公网传输可被嗅探。公网暴露必须在前面加 TLS
> （caddy/nginx 反代或 Cloudflare），或继续用 SSH 隧道（`ssh -L 8466:127.0.0.1:8466 vps`，
> 此时可不开 key）。二选一，不要裸奔。

## 启动

```bash
node server.mjs        # http://127.0.0.1:8466，仅绑定回环地址，无访问校验
```

## 支持的 Messages API 能力（均已本地实测）

| 能力 | 状态 | 说明 |
|------|------|------|
| `messages[]` 多轮文本 | ✅ | 无会话头时展平为转录；带会话头时只发最新消息 |
| `system` | ✅ | 完全替换会话默认提示词，无 Claude Code 人格残留 |
| `stream: true` | ✅ | SSE 事件序列原样转发 |
| `model` | ✅ | sonnet/opus/haiku 别名透传，响应回显真实模型 |
| **图片输入** | ✅ | 最新一条 user 消息的 image 块原生透传（多模态） |
| **function calling** | ✅ | `tools[]` → 模型调用时返回 `tool_use` + `stop_reason:"tool_use"`；执行后带 `tool_result` 块 + 响应头 `x-claude-session-id` 再次请求即恢复同一会话 |
| `temperature` / `top_p` / `top_k` / `stop_sequences` | ✅ | 经 `CLAUDE_CODE_EXTRA_BODY` 注入，已验证进入出站请求体 |
| `max_tokens` | ⚠️ best-effort | 注入出站体，但会话自身预算可能覆盖 |
| `thinking` | ⚠️ best-effort | enabled→设置思考预算；disabled 透传但不保证生效（会话默认 adaptive thinking，对质量有利） |
| `usage` 统计 | ✅ | 真实 token 用量 |
| `tool_choice` / `response_format` | ❌ | 暂不支持 |
| `count_tokens` / batches 等端点 | ❌ | 暂未实现 |

## 会话连续性（可选）

每个响应都带 `x-claude-session-id` 响应头和 `session_id` 字段。调用方把它放在后续请求的请求头里，即可复用同一会话——多轮对话不再重发历史（更快更省），function calling 的第二步**必须**带它。

## 行为说明

- 工具桥接原理：caller 的 `tools[]` 注册为 SDK 内存 MCP 工具；模型首次调用即中断查询、把 `tool_use` 返回给调用方执行；`tool_result` 通过会话恢复原生回传。JSON Schema→Zod 转换覆盖 string/number/boolean/array/object/enum + required 常用子集。
- 内置工具（Bash/文件等）默认全部禁用且不进请求体；`CLAUDE_LOCAL_TOOLS=1` 开启。
- 隔离模式：不加载设置文件和 CLAUDE.md/AGENTS.md，请求体保持在 KB 级。
- 无会话头时每请求冷启动一个 CLI 子进程（3~5 秒）；带会话头复用会话。
- 用量计入本机登录账号，受其订阅额度/限流约束。

## 环境变量

`PORT`(8466)、`HOST`(127.0.0.1)、`CLAUDE_LOCAL_API_KEY`(设了才启用认证)、`CLAUDE_LOCAL_CWD`(./sandbox)、`CLAUDE_LOCAL_MODEL`、`CLAUDE_LOCAL_TOOLS`、`CLAUDE_LOCAL_PERMISSION_MODE`、`CLAUDE_LOCAL_TIMEOUT_MS`(300000)、`CLAUDE_LOCAL_MAX_CONCURRENCY`(4)、`CLAUDE_LOCAL_KEEP_TRAFFIC`(默认关闭子进程遥测/开关拉取/更新检查等非模型流量；设 `1` 恢复 CLI 默认行为)、`CLAUDE_LOCAL_AFFINITY_MAX`(64)、`CLAUDE_LOCAL_AFFINITY_TTL_MS`(3600000)
