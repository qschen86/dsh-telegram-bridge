# dsh-telegram-bridge

DSH host 插件：通过 Telegram 机器人推送通知，并支持在 Telegram 上回复继续推进会话。

## 功能

- **会话完成通知**：agent 完成一轮（回到 idle）后，向 Telegram 发送通知。所有通知
  统一模板，按固定字段顺序：**侧边栏 icon 名称（工作区标题，如「日历待办」）→ 会话 id →
  会话名（session/title 事件）→ 通知类型（✅ 会话结束 / 🔐 需要授权 / ❓ 需要确认 /
  ⏰ 日程提醒 / ℹ️ 其他）→ 通知内容概要**；**回复该消息即可继续会话**。
  已通知的回合基线持久化在 state.json（宿主重启不丢失）；发送失败不推进基线，
  下次 idle 自动重试，避免静默丢通知。首次见到某会话 idle 时：若其最近活动晚于
  桥接启动时刻（新建会话、或重启后恢复的会话），直接推送并建立基线（新会话的第一轮
  完成也会通知）；仅当会话活动全部早于桥接启动（宿主重启加载的历史会话）时才只记基线
  不推送，避免补发旧回合的噪音。其他插件经 telegramBridge.sendAll(text, {type, sessionId})
  发送时可带类型前缀并让回复直达对应会话。
- **需要确认通知**：
  - ask_user_question（模型请求确认）→ 推送问题与选项，在 Telegram 回复选项编号 / 文字 / custom: 内容 即可回答，agent 自动继续。
  - 权限审批（sandbox approval）→ 推送工具名与原因；可回复 /approve <编号> allow|deny 为会话设置自动审批策略（也可用环境变量设全局默认）。
- **Telegram 消息路由**（按优先级）：
  1. 回复通知消息 → 直达对应会话（通知 message id → 会话 id 映射持久化在 state.json，宿主重启后依然有效；即使映射丢失，也会从被回复消息正文里的 #sess: 标签恢复）；
  2. 消息正文带 #sess:<会话id> → 直达该会话；
  3. 全局恰好只有一个待回答的确认问题 → 该消息视为对它的回答；
  4. 恰好只有一个可发现会话 → 路由到该会话；
  5. 最近活跃会话；
  6. 以上都没有时给出明确提示（/list、/s、#sess: 用法）。

## 安装

```bash
dsh plugin --profile web add dsh-telegram-bridge
# 或使用 GitHub Release tarball：
# dsh plugin --profile web add https://github.com/qschen86/dsh-telegram-bridge/releases/download/v0.1.0/dsh-telegram-bridge-0.1.0.tgz
dsh --profile web --dump-config   # 验证条目已加入 bundles
# 重启 dsh web（host 半生效）
```

## 初始化（首次安装）

1. 在 Telegram 找 @BotFather 创建机器人，拿到 token（tg 前缀，如 `123456:ABC...`）。
2. **提供 token**（二选一，config.json 优先）：
   - 把 `data/config.example.json` 复制为 `data/config.json`，填入 `botToken`；或
   - 设置环境变量 `DSH_TELEGRAM_BOT_TOKEN`（注意：环境变量需对 **dsh web 进程**可见——
     launchd 托管时加进 plist 的 `EnvironmentVariables`，只写 `~/.zshrc` 不生效）。
   - 二者都不填时插件不激活（启动日志有警告）。
3. 重启 dsh web 后，在 Telegram 给机器人发 **/start**（未配置授权列表时自动注册当前 chat），
   再发 **/status** 确认桥接状态。
4. 可选环境变量：`DSH_TELEGRAM_ALLOWED_CHATS`（逗号分隔的 chat id，同 config.json
   `allowedChats`）、`DSH_TELEGRAM_APPROVAL_DEFAULT`（ask / allowed-once / rejected）、
   `DSH_TELEGRAM_PREFIX`（命令前缀，默认 /）。

## Telegram 命令

| 命令 | 说明 |
| --- | --- |
| /start | 注册当前 chat（未配置授权列表时） |
| /list | 列出会话（编号） |
| /s <编号|会话id> <内容> | 向指定会话发送消息 |
| /q <编号> <答案> | 回答指定会话的待确认问题 |
| /approve <编号> allow|deny|ask | 设置会话自动审批策略 |
| /status | 桥接状态 |
| /help | 帮助 |

回复通知消息本身即可：**继续会话**（完成通知）、**回答问题**（问题通知，支持选项编号 / 文字 / custom: 内容）、**allow / deny 审批**（审批通知）。如果回复的是问题通知但该确认已失效（已在网页回答，或会话被中断/取消），会收到明确提示而不会把答案当作普通消息发进会话。

## 说明

- 通过 Telegram Bot API getUpdates 长轮询收发，无需公网地址 / webhook。
- 数据（授权 chat、审批策略、通知消息 → 会话 id 映射）持久化在插件 data/state.json（映射最多保留最近 500 条）。
- 会话 id 以 #sess:<id> 标签内嵌在通知消息中；回复消息时会自动用它恢复路由，即使映射表因重启或清理而缺失。

## 配置

`data/config.json`（模板见 `data/config.example.json`）：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `botToken` | 空 | @BotFather 创建的 token；优先于环境变量 `DSH_TELEGRAM_BOT_TOKEN` |
| `allowedChats` | `[]` | 授权 chat id 列表。**空 = 不限制**：任何 chat 发 `/start` 即自动授权并持久化到 `data/state.json`；非空 = 仅列表内的 chat 可交互。想只给自己用就填自己的 chat id |

> 环境变量方式：`DSH_TELEGRAM_BOT_TOKEN` / `DSH_TELEGRAM_ALLOWED_CHATS` /
> `DSH_TELEGRAM_APPROVAL_DEFAULT` / `DSH_TELEGRAM_PREFIX`。二者都不填时插件不激活。
