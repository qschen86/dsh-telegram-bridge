# dsh-telegram-bridge

DSH host 插件：通过 Telegram 机器人推送通知，并支持在 Telegram 上回复继续推进会话。

## 功能

- **会话完成通知**：agent 完成一轮（回到 idle）后，向 Telegram 发送通知。所有通知
  统一模板，按固定字段顺序：**侧边栏 icon 名称（工作区标题，如「日历待办」）→ 会话 id →
  会话名（session/title 事件）→ 通知类型（✅ 会话结束 / 🔐 需要授权 / ❓ 需要确认 /
  ⏰ 日程提醒 / ℹ️ 其他）→ 通知内容概要**；**回复该消息即可继续会话**。
  已通知的回合基线持久化在 state.json（宿主重启不丢失）；发送失败不推进基线，
  下次 idle 自动重试，避免静默丢通知。其他插件经 telegramBridge.sendAll(text, {type, sessionId})
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

1. 在 Telegram 找 @BotFather 创建机器人，拿到 token。
2. 编辑 ~/.dsh/profiles/web/package.json，在 dependencies 和 dsh.profile.bundles 中加入本插件（与本仓库其他插件一致，用 link: 引用）。
3. cd ~/.dsh/profiles/web && pnpm install
4. 设置环境变量后重启 dsh web：
   - DSH_TELEGRAM_BOT_TOKEN：机器人 token（必填）
   - DSH_TELEGRAM_ALLOWED_CHATS：允许的 chat id（逗号分隔）；留空则首个发送 /start 的 chat 自动授权并持久化
   - DSH_TELEGRAM_APPROVAL_DEFAULT：ask（默认，网页审批）/ allowed-once / rejected
   - DSH_TELEGRAM_PREFIX：命令前缀（默认 /）
5. 在 Telegram 里给机器人发 /start，然后 /status 查看状态。

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

首次安装后把 `data/config.example.json` 复制为 `data/config.json` 并填写
`botToken`（@BotFather 创建）与 `allowedChats`（授权 chat id 列表，空 = 仅本机
管理员账号）；也可用环境变量 `DSH_TELEGRAM_BOT_TOKEN` 提供 token。二者都不填时
插件不激活。
