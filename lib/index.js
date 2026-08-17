// dsh-telegram-bridge — host half.
// Out-of-tree plugin: loads from the profile's own node_modules, where in-box
// @deepseek-ai/* packages are not ESM-resolvable, so only node: builtins are
// imported and all framework surfaces arrive through ctx services
// (ctx.get("agents") / ctx.get("apiProxy") / ctx.get("userQuestions")) plus
// ctx.on events. The Telegram Bot API is reached with the global fetch
// (Node >= 18), long-polling getUpdates — no public URL / webhook required.
//
// Capabilities:
//   1. Conversation finished (agent went idle after real activity) -> Telegram
//      message with a short summary; replying to it continues that session.
//   2. Needs confirmation:
//      - ask_user_question tool -> Telegram message with the question and its
//        options; answering on Telegram (option number/label, or
//        'custom: <text>') resolves the question and the agent continues.
//      - sandbox approvals -> Telegram message with the tool and reason;
//        per-session auto-decision via /approve or DSH_TELEGRAM_APPROVAL_DEFAULT
//        (default "ask" = decide on the web GUI).
//   3. Any Telegram message can be routed to a session: replying to a
//      notification, /s <n|id> <text>, or the last active session.
//
// Config (environment):
//   DSH_TELEGRAM_BOT_TOKEN        required; token from @BotFather
//   DSH_TELEGRAM_ALLOWED_CHATS    optional comma-separated numeric chat ids;
//                                 when empty the first chat that /start's is
//                                 allowed and persisted in data/state.json
//   DSH_TELEGRAM_APPROVAL_DEFAULT ask|allowed-once|rejected (default ask)
//   DSH_TELEGRAM_PREFIX           optional command prefix (default "/")

import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const name = "telegram-bridge";
export const inject = [];

const TG_API = "https://api.telegram.org/bot";
const POLL_TIMEOUT = 55; // seconds, telegram getUpdates long-poll
const FETCH_POLL_MS = 70_000;
const FETCH_SHORT_MS = 20_000;
const MAX_TEXT = 3900; // telegram hard limit is 4096
const SUMMARY_CHARS = 900;
const TITLE_CHARS = 60;
const QUESTION_OPTIONS_MAX = 8;
const MESSAGE_SESSION_CAP = 500; // persisted reply-to routing entries kept

const OUTCOMES = ["allowed-once", "rejected", "cancelled", "unavailable"];
const APPROVAL_PREFS = new Set(["ask", "allowed-once", "rejected"]);

function env(name, fallback = "") {
  const value = process.env[name];
  return value === undefined || value.trim() === "" ? fallback : value.trim();
}

let TOKEN = "";
const COMMAND_PREFIX = env("DSH_TELEGRAM_PREFIX", "/");
const APPROVAL_DEFAULT = APPROVAL_PREFS.has(env("DSH_TELEGRAM_APPROVAL_DEFAULT"))
  ? env("DSH_TELEGRAM_APPROVAL_DEFAULT")
  : "ask";
const ALLOWED_INIT = env("DSH_TELEGRAM_ALLOWED_CHATS")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "data");
const STATE_FILE = join(DATA_DIR, "state.json");
const CONFIG_FILE = join(DATA_DIR, "config.json");

/** Optional data/config.json: {"botToken": "...", "allowedChats": [...]}. */
function loadConfigFile() {
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    return {};
  }
}

function loadState() {
  try {
    const raw = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    // Persisted notification message-id -> session-id map, so reply-to keeps
    // routing across host restarts (the in-memory map alone loses it).
    const rawMap = raw.messageSessions && typeof raw.messageSessions === "object" ? raw.messageSessions : {};
    const messageSessions = {};
    let kept = 0;
    for (const key of Object.keys(rawMap)) {
      if (kept >= MESSAGE_SESSION_CAP) break;
      const sid = rawMap[key];
      if (/^\d+$/.test(key) && typeof sid === "string" && sid !== "") {
        messageSessions[key] = sid;
        kept += 1;
      }
    }
    return {
      allowedChats: Array.isArray(raw.allowedChats) ? raw.allowedChats.map(String).filter(Boolean) : [],
      approvalPrefs: raw.approvalPrefs && typeof raw.approvalPrefs === "object" ? raw.approvalPrefs : {},
      messageSessions,
      notifiedTurns: raw.notifiedTurns && typeof raw.notifiedTurns === "object" ? raw.notifiedTurns : {}
    };
  } catch {
    return { allowedChats: [], approvalPrefs: {}, messageSessions: {}, notifiedTurns: {} };
  }
}

function saveState(state) {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    const tmp = STATE_FILE + ".tmp";
    writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
    renameSync(tmp, STATE_FILE);
  } catch (e) {
    // non-fatal
  }
}

// ── telegram transport ───────────────────────────────────────────────────────
async function tgCall(method, body, timeoutMs = FETCH_SHORT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(TG_API + TOKEN + "/" + method, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal
    });
    let json = {};
    try {
      json = await response.json();
    } catch {
      throw new Error("telegram " + method + ": non-JSON response (HTTP " + response.status + ")");
    }
    if (json.ok !== true) {
      throw new Error("telegram " + method + ": " + (json.description || "HTTP " + response.status));
    }
    return json.result;
  } finally {
    clearTimeout(timer);
  }
}

async function tgSend(chatId, text, extra = {}) {
  if (!TOKEN) return null;
  const safe = String(text).slice(0, MAX_TEXT);
  try {
    return await tgCall("sendMessage", {
      chat_id: chatId,
      text: safe,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...extra
    });
  } catch (e) {
    return null;
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────
function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function textOf(blocks) {
  if (!Array.isArray(blocks)) return "";
  return blocks
    .filter((b) => b && typeof b === "object" && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join(" ")
    .trim();
}

function sessionTitle(session) {
  // Prefer the session's own title (session/title events, last one wins —
  // the provider-generated title), not the first user message.
  let title = "";
  for (const event of session.events) {
    if (event.type !== "session/title") continue;
    const t = event.data && event.data.title;
    if (typeof t === "string" && t.trim() !== "") title = t.trim();
  }
  if (title) return title.slice(0, TITLE_CHARS);
  for (const event of session.events) {
    if (event.type !== "user/message") continue;
    const text = textOf(event.data && event.data.content);
    if (text) return text.slice(0, TITLE_CHARS);
  }
  return session.id;
}

/** Text of the last assistant message (content lives at data.message.content). */
function assistantTextOf(event) {
  return textOf(event.data && event.data.message && event.data.message.content);
}

/** Summary of the turn that just ended: assistant texts after the last turn/start. */
function lastTurnAssistantText(session) {
  let startIndex = 0;
  for (let i = session.events.length - 1; i >= 0; i -= 1) {
    if (session.events[i].type === "turn/start") { startIndex = i; break; }
  }
  for (let i = session.events.length - 1; i >= startIndex; i -= 1) {
    const event = session.events[i];
    if (event.type !== "assistant/message") continue;
    const text = assistantTextOf(event);
    if (text) return text;
  }
  // fallback: the final message may not be flushed yet when idle fires
  for (let i = session.events.length - 1; i >= 0; i -= 1) {
    const event = session.events[i];
    if (event.type !== "assistant/message") continue;
    const text = assistantTextOf(event);
    if (text) return text;
  }
  return "";
}

function countTurns(session) {
  let n = 0;
  for (const event of session.events) if (event.type === "turn/end") n += 1;
  return n;
}

/** Epoch-ms of the session's latest event that carries one, or null. */
function latestEventTime(session) {
  if (!session || !Array.isArray(session.events)) return null;
  for (let i = session.events.length - 1; i >= 0; i -= 1) {
    const event = session.events[i];
    const t = event && event.time;
    if (typeof t === "number" && Number.isFinite(t) && t > 1e12) return t;
  }
  return null;
}

function tagOf(sessionId) {
  return "#sess:" + sessionId;
}

function parseTag(text) {
  const match = /#sess:([A-Za-z0-9._-]+)/.exec(String(text || ""));
  return match ? match[1] : null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── apply ────────────────────────────────────────────────────────────────────
export function apply(ctx) {
  const fileConfig = loadConfigFile();
  TOKEN = String(fileConfig.botToken || "").trim() || env("DSH_TELEGRAM_BOT_TOKEN");
  if (!TOKEN) {
    ctx.logger.warn("telegram-bridge: no bot token. Set DSH_TELEGRAM_BOT_TOKEN env or write data/config.json with {\"botToken\": \"...\"} and restart.");
    return;
  }

  // Anchor for the first-sighting heuristic: sessions whose latest activity
  // predates this bridge instance (loaded from disk on host restart) are not
  // notified; sessions active after this moment (new or resumed) are.
  const PLUGIN_START_TS = Date.now();

  const loaded = loadState();
  const fileAllowed = Array.isArray(fileConfig.allowedChats) ? fileConfig.allowedChats.map(String).filter(Boolean) : [];
  const state = {
    allowedChats: [...new Set([...loaded.allowedChats, ...fileAllowed, ...ALLOWED_INIT])],
    approvalPrefs: loaded.approvalPrefs,
    messageSessions: loaded.messageSessions || {},
    notifiedTurns: loaded.notifiedTurns || {}
  };
  saveState(state);

  const pendingQuestions = new Map(); // sessionId -> entry
  const pendingApprovals = new Map(); // sessionId -> { id, toolName, callId, reason }
  const msgSession = new Map(Object.entries(state.messageSessions)); // telegram messageId -> sessionId

  /** Record a notification message id -> session id, persisted across restarts. */
  function mapMessage(messageId, sessionId) {
    const key = String(messageId);
    msgSession.set(key, sessionId);
    const kept = [...msgSession.entries()].slice(-MESSAGE_SESSION_CAP);
    const next = {};
    for (const [k, v] of kept) next[k] = v;
    state.messageSessions = next;
    saveState(state);
  }
  const lastActive = new Map(); // sessionId -> timestamp


  // Programmatic bridge for other plugins (e.g. dsh-calendar-todo reminders):
  // send a Telegram message to every allowed chat, or to one chat id.
  ctx.provide("telegramBridge", {
    ready: () => TOKEN !== "",
    sendAll: (text, extra) => {
      const e = extra || {};
      const { type, sessionId, ...telegramExtra } = e;
      let body = text;
      if (type) {
        const typeLine = TYPE_LINES[type] || ("ℹ️ " + String(type));
        body = typeLine + "\n\n" + String(text);
      }
      return tgSendAll(body, telegramExtra).then((ids) => {
        if (sessionId && ids.length > 0) for (const mid of ids) mapMessage(mid, sessionId);
        return ids;
      });
    },
    send: (chatId, text, extra) => {
      const e = extra || {};
      const { type, sessionId, ...telegramExtra } = e;
      let body = text;
      if (type) {
        const typeLine = TYPE_LINES[type] || ("ℹ️ " + String(type));
        body = typeLine + "\n\n" + String(text);
      }
      return tgSend(String(chatId), body, telegramExtra).then((result) => {
        if (sessionId && result && result.message_id !== undefined) mapMessage(result.message_id, sessionId);
        return result;
      });
    },
    chats: () => [...state.allowedChats]
  });

  let pollStarted = false;
  let pollStopped = false;
  let pollRunning = false;
  let pollErrorStreak = 0;
  let wrappedAsk = null;

  const allowed = (chatId) =>
    state.allowedChats.length === 0 || state.allowedChats.includes(String(chatId));

  function approvalPrefFor(sessionId) {
    const pref = state.approvalPrefs[sessionId];
    return APPROVAL_PREFS.has(pref) ? pref : APPROVAL_DEFAULT;
  }

  // ── notification senders ───────────────────────────────────────────────────
  async function tgSendAll(text, extra = {}) {
    const ids = [];
    for (const chatId of state.allowedChats) {
      const result = await tgSend(chatId, text, extra);
      if (result && result.message_id !== undefined) ids.push(result.message_id);
    }
    return ids;
  }

  /** Notification type labels (Telegram-visible, replyable). */
  const TYPE_LINES = {
    "会话结束": "✅ 会话结束",
    "需要授权": "🔐 需要授权",
    "需要确认": "❓ 需要确认",
    "日程提醒": "⏰ 日程提醒"
  };

  /** Sidebar icon / owning app label for a session: its workspace title
   *  (e.g. the calendar app registers "日历待办"), falling back to the
   *  session cwd's folder name, then "DSH". */
  function appLabelFor(session) {
    const cwd = session && (session.cwd || (session.header && session.header.cwd));
    try {
      const registry = ctx.get("workspaceRegistry");
      if (registry && typeof registry.list === "function" && cwd) {
        for (const ws of registry.list()) {
          if (ws && ws.path === cwd && ws.title && String(ws.title).trim() !== "") {
            return String(ws.title).slice(0, 24);
          }
        }
      }
    } catch (e) { /* non-fatal */ }
    if (cwd) {
      const seg = String(cwd).split(/[\\/]/).filter(Boolean).pop();
      if (seg) return seg.slice(0, 24);
    }
    return "DSH";
  }

  /** Uniform header: icon name / session id / session name / type line. */
  function renderHeader(session, typeLine) {
    return [
      "🏷 " + escapeHtml(appLabelFor(session)),
      "🆔 " + escapeHtml(session && session.id ? session.id : "?"),
      "📌 " + escapeHtml(sessionTitle(session)),
      typeLine
    ].join("\n");
  }

  /** Persisted per-session notified-turn baseline (survives process restarts). */
  function notifiedBaseline(sessionId) {
    const v = state.notifiedTurns[sessionId];
    return typeof v === "number" && Number.isFinite(v) ? v : undefined;
  }
  function recordNotified(sessionId, turns) {
    state.notifiedTurns[sessionId] = turns;
    const keys = Object.keys(state.notifiedTurns);
    if (keys.length > 500) {
      for (const k of keys.slice(0, keys.length - 500)) delete state.notifiedTurns[k];
    }
    saveState(state);
  }

  function notifyIdle(agent) {
    const session = agent.session;
    const sessionId = agent.id;
    const turns = countTurns(session);
    const baseline = notifiedBaseline(sessionId);
    let shouldNotify = false;
    if (baseline === undefined) {
      // First sighting. A session whose latest activity predates this bridge
      // instance (loaded from disk on host restart, with older turns) only
      // gets its baseline recorded — notifying about its history would be
      // noise. A session active AFTER the bridge started is either
      // brand-new or was resumed: its just-finished turn is live work and
      // must be notified — including a new session's very first turn.
      const lastTs = latestEventTime(session);
      if (lastTs === null || lastTs <= PLUGIN_START_TS) {
        recordNotified(sessionId, turns);
        return;
      }
      shouldNotify = true;
    } else {
      shouldNotify = turns > baseline;
    }
    if (!shouldNotify) return;
    if (pendingQuestions.has(sessionId) || pendingApprovals.has(sessionId)) return;

    const summary = escapeHtml(lastTurnAssistantText(session).slice(0, SUMMARY_CHARS));
    const tag = tagOf(sessionId);
    const lines = [
      renderHeader(session, TYPE_LINES["会话结束"]),
      summary ? "" : null,
      summary ? summary : null,
      "",
      "<code>" + tag + "</code>",
      "— 回复此消息即可继续推进"
    ].filter((l) => l !== null);
    void tgSendAll(lines.join("\n")).then((ids) => {
      for (const mid of ids) mapMessage(mid, sessionId);
      // advance the baseline only after a real delivery, so a failed send
      // retries on the next idle instead of being silently dropped
      if (ids.length > 0) recordNotified(sessionId, turns);
    });
  }

  async function notifyQuestion(sessionId, request) {
    const agents = ctx.get("agents");
    const agent = agents ? agents.get(sessionId) : undefined;
    const session = agent ? agent.session : undefined;
    const q = request.questions && request.questions[0];
    if (!q) return;
    const lines = [
      session ? renderHeader(session, TYPE_LINES["需要确认"]) : ("❓ 需要确认\n🆔 " + escapeHtml(sessionId)),
      "",
      escapeHtml(String(q.question))
    ];
    if (q.header) lines.push("\n<b>" + escapeHtml(String(q.header)) + "</b>");
    if (Array.isArray(q.options) && q.options.length > 0) {
      lines.push("");
      q.options.slice(0, QUESTION_OPTIONS_MAX).forEach((opt, i) => {
        lines.push((i + 1) + ". " + escapeHtml(String(opt && opt.label !== undefined ? opt.label : opt)));
      });
    }
    lines.push("", "<code>" + tagOf(sessionId) + "</code>");
    lines.push("回复此消息：选项编号 / 文字，或 <code>custom: 你的回答</code>");
    const ids = await tgSendAll(lines.join("\n"));
    for (const id of ids) mapMessage(id, sessionId);
  }

  async function notifyApproval(sessionId, entry) {
    const agents = ctx.get("agents");
    const agent = agents ? agents.get(sessionId) : undefined;
    const session = agent ? agent.session : undefined;
    const pref = approvalPrefFor(sessionId);
    const lines = [
      session ? renderHeader(session, TYPE_LINES["需要授权"]) : ("🔐 需要授权\n🆔 " + escapeHtml(sessionId)),
      "",
      "工具：" + escapeHtml(String(entry.toolName !== undefined ? entry.toolName : "?")),
      entry.reason ? "原因：" + escapeHtml(String(entry.reason)) : null,
      "",
      pref === "ask"
        ? "请在网页批准，或回复 <code>/approve &lt;编号&gt; allow|deny</code> 设置自动审批策略"
        : "本会话自动策略：" + pref + "（回复 <code>/approve &lt;编号&gt; ask</code> 可改回人工）",
      "<code>" + tagOf(sessionId) + "</code>"
    ].filter((l) => l !== null);
    const ids = await tgSendAll(lines.join("\n"));
    for (const id of ids) mapMessage(id, sessionId);
  }

  // ── event subscriptions ────────────────────────────────────────────────────
  const disposers = [];

  // conversation finished: agent turned idle after real activity
  disposers.push(ctx.on("agent/status", ({ agent, status }) => {
    try {
      if (status !== "idle" || !agent || !agent.session) return;
      notifyIdle(agent);
    } catch (e) {
      ctx.logger.warn("telegram-bridge: agent/status handler failed: " + String((e && e.message) || e));
    }
  }));

  // approvals: watch audit events; auto-decide when a preference is set
  disposers.push(ctx.on("session/event", (session, event) => {
    try {
    const sessionId = session && session.id;
    if (!sessionId) return;
    if (event.type === "approval/asked") {
      const data = event.data || {};
      const entry = {
        id: data.id,
        toolName: data.toolName,
        callId: data.callId,
        reason: data.reason
      };
      pendingApprovals.set(sessionId, entry);
      const pref = approvalPrefFor(sessionId);
      if (pref !== "ask") {
        try {
          session.append("approval/decided", { id: data.id, outcome: pref });
        } catch (e) {
          ctx.logger.warn("telegram-bridge: auto-approval append failed: " + String((e && e.message) || e));
        }
      }
      void notifyApproval(sessionId, entry);
    } else if (event.type === "approval/decided") {
      const current = pendingApprovals.get(sessionId);
      if (current && current.id === event.data.id) pendingApprovals.delete(sessionId);
    }
    } catch (e) {
      ctx.logger.warn("telegram-bridge: session/event handler failed: " + String((e && e.message) || e));
    }
  }));

  // approval decisions logged beforehand (auto-decide): the api-proxy handler
  // runs first in the waterfall; for an already-decided id it defers via
  // next() and this listener returns the logged outcome.
  disposers.push(ctx.on("approval/request", (req, next) => {
    try {
      if (req.signal && req.signal.aborted) return Promise.resolve("cancelled");
      const session = req.agent && req.agent.session;
      if (!session) return next();
      const decided = new Map();
      for (const event of session.events) {
        if (event.type === "approval/decided") decided.set(event.data.id, event.data.outcome);
      }
      for (let i = session.events.length - 1; i >= 0; i -= 1) {
        const event = session.events[i];
        if (event.type !== "approval/asked") continue;
        if ((req.callId !== undefined ? req.callId : null) !== (event.data.callId !== undefined ? event.data.callId : null)) continue;
        const outcome = decided.get(event.data.id);
        if (outcome === undefined) return next();
        return Promise.resolve(OUTCOMES.indexOf(outcome) >= 0 ? outcome : "unavailable");
      }
      return next();
    } catch (e) {
      ctx.logger.warn("telegram-bridge: approval/request handler failed: " + String((e && e.message) || e));
      return next();
    }
  }));

  // ── ask_user_question interception ─────────────────────────────────────────
  function settleQuestion(sessionId, entry, answer) {
    if (entry.resolved) return;
    entry.resolved = true;
    if (sessionId && pendingQuestions.get(sessionId) === entry) pendingQuestions.delete(sessionId);
    entry.resolve(answer);
  }

  function wrapQuestionProvider() {
    const svc = ctx.get("userQuestions");
    const provider = svc && svc.provider;
    if (!svc || !provider || typeof provider.ask !== "function") return;
    if (provider.ask === wrappedAsk) return;
    const original = provider.ask.bind(provider);
    wrappedAsk = async (request) => {
      const sessionId = request && request.agent ? request.agent.id : undefined;
      const entry = { request, resolved: false, resolve: null, reject: null };
      const promise = new Promise((resolve, reject) => {
        entry.resolve = resolve;
        entry.reject = reject;
      });
      if (sessionId) {
        pendingQuestions.set(sessionId, entry);
        void notifyQuestion(sessionId, request);
      }
      original(request).then(
        (answer) => settleQuestion(sessionId, entry, answer),
        (error) => {
          if (sessionId && pendingQuestions.get(sessionId) === entry) {
            pendingQuestions.delete(sessionId);
            entry.resolved = true;
            entry.reject(error);
          }
        }
      );
      return promise;
    };
    provider.ask = wrappedAsk;
    ctx.logger.info("telegram-bridge: ask_user_question bridge installed");
  }

  const providerTimer = setInterval(() => {
    try {
      wrapQuestionProvider();
    } catch (e) {
      ctx.logger.warn("telegram-bridge: provider wrap failed: " + String((e && e.message) || e));
    }
  }, 1000);
  disposers.push(() => clearInterval(providerTimer));

  // ── telegram long-poll loop ────────────────────────────────────────────────
  async function pollLoop() {
    if (pollRunning) return;
    pollRunning = true;
    let offset = 0;
    try {
      const me = await tgCall("getMe");
      ctx.logger.info("telegram-bridge: connected as @" + ((me && me.username) || "?"));
    } catch (e) {
      ctx.logger.warn("telegram-bridge: cannot reach Telegram (" + String((e && e.message) || e) + "); retrying");
    }
    while (!pollStopped) {
      try {
        const updates = await tgCall("getUpdates", {
          timeout: POLL_TIMEOUT,
          offset,
          allowed_updates: ["message"]
        }, FETCH_POLL_MS);
        pollErrorStreak = 0;
        for (const update of updates || []) {
          if (!update.message) continue;
          offset = Math.max(offset, update.update_id + 1);
          try {
            await handleMessage(update.message);
          } catch (e) {
            ctx.logger.warn("telegram-bridge: update handling failed: " + String((e && e.message) || e));
          }
        }
      } catch (e) {
        pollErrorStreak += 1;
        if (pollErrorStreak <= 2 || pollErrorStreak % 12 === 0) {
          ctx.logger.warn("telegram-bridge: getUpdates error: " + String((e && e.message) || e));
        }
        if (pollErrorStreak >= 60) {
          ctx.logger.warn("telegram-bridge: repeated Telegram failures; poll loop paused. Restart to retry.");
          pollStopped = true;
          break;
        }
        await sleep(3000);
      }
    }
    pollRunning = false;
  }

  // ── message handling ───────────────────────────────────────────────────────
  async function handleMessage(message) {
    const chatId = String(message.chat && message.chat.id !== undefined ? message.chat.id : "");
    const text = String(message.text || "").trim();
    if (!chatId || !text) return;

    if (text === COMMAND_PREFIX + "start") {
      if (!state.allowedChats.includes(chatId)) {
        state.allowedChats.push(chatId);
        saveState(state);
      }
      await tgSend(chatId,
        "👋 已连接 DSH Telegram 桥接。\n\n" +
        "· 会话完成 / 需要确认时我会在这里通知\n" +
        "· 回复通知消息即可继续会话 / 回答问题 / 审批\n\n" +
        "命令：" + COMMAND_PREFIX + "help / list / s / q / approve / status"
      );
      return;
    }
    if (!allowed(chatId)) {
      await tgSend(chatId, "未授权。请先发送 " + COMMAND_PREFIX + "start 注册。");
      return;
    }

    if (text === COMMAND_PREFIX + "help") {
      await tgSend(chatId, helpText());
      return;
    }
    if (text === COMMAND_PREFIX + "status") {
      const agents = ctx.get("agents");
      const lines = [
        "📡 DSH Telegram 桥接",
        "· Telegram: ✅ 已连接",
        "· 轮询: " + (pollRunning ? "运行中" : "停止"),
        "· 授权 chat: " + (state.allowedChats.join(", ") || "无"),
        "· 待回答问题: " + pendingQuestions.size,
        "· 待审批: " + pendingApprovals.size,
        "· 活动会话: " + (agents ? agents.roots().length : 0),
        "· 审批默认策略: " + APPROVAL_DEFAULT
      ];
      await tgSend(chatId, lines.join("\n"));
      return;
    }
    if (text === COMMAND_PREFIX + "list") {
      await cmdList(chatId);
      return;
    }

    const lower = text.toLowerCase();
    if (lower.startsWith(COMMAND_PREFIX + "s ")) {
      await cmdSend(chatId, text.slice((COMMAND_PREFIX + "s ").length).trim());
      return;
    }
    if (lower.startsWith(COMMAND_PREFIX + "q ")) {
      await cmdQuestion(chatId, text.slice((COMMAND_PREFIX + "q ").length).trim());
      return;
    }
    if (lower.startsWith(COMMAND_PREFIX + "approve ")) {
      await cmdApprove(chatId, text.slice((COMMAND_PREFIX + "approve ").length).trim());
      return;
    }

    // routing: reply-to a notification > embedded tag > sole pending question
    // > sole discoverable session > last active
    let sessionId = null;
    const replied = message.reply_to_message;
    if (replied && replied.message_id !== undefined) {
      sessionId = msgSession.get(String(replied.message_id)) || null;
      if (!sessionId) sessionId = parseTag(replied.text); // notification body carries #sess:
      if (sessionId) mapMessage(replied.message_id, sessionId); // remember for future replies
    }
    if (!sessionId) sessionId = parseTag(text);

    if (replied && replied.message_id !== undefined && sessionId) {
      const entry = pendingQuestions.get(sessionId);
      if (entry) {
        await answerQuestion(chatId, sessionId, entry, text);
        return;
      }
      const approval = pendingApprovals.get(sessionId);
      if (approval) {
        const word = lower.trim();
        if (word === "allow" || word === "deny") {
          await setApprovalPref(chatId, sessionId, word === "allow" ? "allowed-once" : "rejected", true);
          return;
        }
      }
      // Reply to a question notification whose question is already gone
      // (answered elsewhere, or the session was interrupted): don't feed the
      // bare answer into the session as a prompt — tell the user instead.
      if (replied.text && String(replied.text).trim().startsWith("❓")) {
        await tgSend(chatId, "该会话已没有待回答的确认（可能已在网页或其他渠道回答，或会话已中断/取消）。如需重新操作，请直接发送新的指令。");
        return;
      }
      await sendToSession(chatId, sessionId, text);
      return;
    }

    if (sessionId) {
      await sendToSession(chatId, sessionId, text);
      return;
    }

    // No reply-to and no tag: if exactly ONE question is waiting anywhere, the
    // message is almost certainly its answer (the notification said "回复此消
    // 息" and the user typed the bare answer). Resolve it instead of erroring.
    const lonePending = [...pendingQuestions.entries()].filter(([, e]) => e && !e.resolved);
    if (lonePending.length === 1) {
      await answerQuestion(chatId, lonePending[0][0], lonePending[0][1], text);
      return;
    }

    // Exactly one discoverable session: route there (the session id was
    // already in the notification; a single-session harness is unambiguous).
    if (!sessionId) {
      const items = await sessionItems();
      if (items.length === 1) {
        sessionId = items[0].sessionId;
        await sendToSession(chatId, sessionId, text);
        return;
      }
    }

    let best = null;
    let bestTs = 0;
    for (const [sid, ts] of lastActive) {
      if (ts > bestTs) {
        bestTs = ts;
        best = sid;
      }
    }
    if (best) {
      await sendToSession(chatId, best, text);
      return;
    }
    await tgSend(chatId,
      "没有可路由的会话。\n" +
      "· 直接回复通知消息即可路由到对应会话\n" +
      "· 发送 " + COMMAND_PREFIX + "list 查看会话，再发送 " + COMMAND_PREFIX + "s <编号> <内容>\n" +
      "· 消息中带上 <code>#sess:会话id</code> 也可路由"
    );
  }

  function helpText() {
    return [
      "🤖 DSH Telegram 桥接",
      "",
      COMMAND_PREFIX + "list — 列出会话",
      COMMAND_PREFIX + "s <编号|会话id> <内容> — 向会话发消息",
      COMMAND_PREFIX + "q <编号> <答案> — 回答问题通知",
      COMMAND_PREFIX + "approve <编号> allow|deny|ask — 会话审批策略",
      COMMAND_PREFIX + "status — 状态",
      "",
      "直接回复通知消息：继续会话 / 回答问题 / allow|deny 审批",
      "普通消息发往最近活跃的会话"
    ].join("\n");
  }

  async function sessionItems() {
    const api = ctx.get("apiProxy");
    if (!api) return [];
    try {
      const res = await api.sessions.list({ rpcId: crypto.randomUUID(), payload: {} });
      const items = res && res.result && res.result.ok ? res.result.value.items : [];
      return Array.isArray(items) ? items : [];
    } catch {
      return [];
    }
  }

  async function resolveTarget(target) {
    const agents = ctx.get("agents");
    if (agents && agents.get(target)) return target;
    const items = await sessionItems();
    for (const item of items) {
      if (item.sessionId === target) return target;
    }
    const idx = Number(target);
    if (Number.isInteger(idx) && idx >= 1 && idx <= items.length) {
      return items[idx - 1].sessionId;
    }
    return null;
  }

  async function cmdList(chatId) {
    const items = await sessionItems();
    if (items.length === 0) {
      await tgSend(chatId, "没有会话。");
      return;
    }
    const lines = ["📋 会话列表（" + items.length + "）", ""];
    items.forEach((item, i) => {
      const title = String(item.title !== undefined ? item.title : (item.sessionId || "?"));
      const running = item.running ? " ▶" : "";
      lines.push((i + 1) + ". " + escapeHtml(title.slice(0, 40)) + running);
    });
    lines.push("", "发送 " + COMMAND_PREFIX + "s <编号> <内容> 向会话发消息");
    await tgSend(chatId, lines.join("\n"));
  }

  async function cmdSend(chatId, arg) {
    const space = arg.indexOf(" ");
    if (space <= 0) {
      await tgSend(chatId, "用法：" + COMMAND_PREFIX + "s <编号> <内容>");
      return;
    }
    const target = arg.slice(0, space).trim();
    const content = arg.slice(space + 1).trim();
    const sessionId = await resolveTarget(target);
    if (!sessionId) {
      await tgSend(chatId, "找不到会话：" + target);
      return;
    }
    await sendToSession(chatId, sessionId, content);
  }

  async function cmdQuestion(chatId, arg) {
    const space = arg.indexOf(" ");
    if (space <= 0) {
      await tgSend(chatId, "用法：" + COMMAND_PREFIX + "q <编号> <答案>");
      return;
    }
    const target = arg.slice(0, space).trim();
    const answer = arg.slice(space + 1).trim();
    const sessionId = await resolveTarget(target);
    if (!sessionId) {
      await tgSend(chatId, "找不到会话：" + target);
      return;
    }
    const entry = pendingQuestions.get(sessionId);
    if (!entry) {
      await tgSend(chatId, "该会话当前没有待回答的问题。");
      return;
    }
    await answerQuestion(chatId, sessionId, entry, answer);
  }

  async function cmdApprove(chatId, arg) {
    const parts = arg.trim().split(/\s+/);
    if (parts.length < 2) {
      await tgSend(chatId, "用法：" + COMMAND_PREFIX + "approve <编号> allow|deny|ask");
      return;
    }
    const sessionId = await resolveTarget(parts[0]);
    if (!sessionId) {
      await tgSend(chatId, "找不到会话：" + parts[0]);
      return;
    }
    const mode = parts[1].toLowerCase() === "allow" ? "allowed-once"
      : parts[1].toLowerCase() === "deny" ? "rejected"
      : parts[1].toLowerCase() === "ask" ? "ask" : null;
    if (!mode) {
      await tgSend(chatId, "策略必须是 allow / deny / ask。");
      return;
    }
    await setApprovalPref(chatId, sessionId, mode, false);
  }

  async function setApprovalPref(chatId, sessionId, mode, immediate) {
    state.approvalPrefs[sessionId] = mode;
    saveState(state);
    let extra = "";
    if (immediate) {
      const pending = pendingApprovals.get(sessionId);
      if (pending) {
        const agents = ctx.get("agents");
        const agent = agents ? agents.get(sessionId) : undefined;
        const session = agent ? agent.session : null;
        if (session) {
          try {
            session.append("approval/decided", {
              id: pending.id,
              outcome: mode === "allowed-once" ? "allowed-once" : mode === "rejected" ? "rejected" : "cancelled"
            });
            pendingApprovals.delete(sessionId);
            extra = "（已对当前待审批项生效）";
          } catch (e) {
            extra = "（当前待审批项可能已转交网页处理）";
          }
        }
      }
    }
    await tgSend(chatId, "会话 #" + sessionId + " 审批策略已设为 " + mode + extra);
  }

  async function answerQuestion(chatId, sessionId, entry, text) {
    const request = entry.request;
    const questions = request.questions;
    if (!questions || questions.length === 0) return;
    const question = questions[0];
    const raw = String(text).trim();
    let answer;

    if (raw.toLowerCase().startsWith("custom:")) {
      answer = { id: question.id, selected: [], custom: raw.slice("custom:".length).trim() };
    } else {
      const options = Array.isArray(question.options) ? question.options : [];
      const idx = Number(raw);
      let selected = [];
      if (Number.isInteger(idx) && idx >= 1 && idx <= options.length) {
        selected = [String(options[idx - 1].label !== undefined ? options[idx - 1].label : options[idx - 1])];
      } else {
        const parts = question.multiSelect === true
          ? raw.split(/[,，]/).map((s) => s.trim()).filter(Boolean)
          : [raw];
        selected = parts.map((part) => {
          const match = options.find((opt) => String(opt.label !== undefined ? opt.label : opt) === part);
          return match ? String(match.label !== undefined ? match.label : match) : part;
        }).filter(Boolean);
        if (selected.length === 0) selected = [raw];
      }
      answer = { id: question.id, selected };
    }

    settleQuestion(sessionId, entry, { answers: [answer] });
    const short = raw.slice(0, 200);
    await tgSend(chatId, "✅ 已提交回答：" + short);
    const title = sessionTitleSafe(sessionId);
    void tgSendAll("✅ 问题已在 Telegram 回答（" + escapeHtml(title) + "）：" + escapeHtml(short));
  }

  function sessionTitleSafe(sessionId) {
    const agents = ctx.get("agents");
    const agent = agents ? agents.get(sessionId) : undefined;
    const session = agent ? agent.session : null;
    return session ? sessionTitle(session) : sessionId;
  }

  async function sendToSession(chatId, sessionId, text) {
    const api = ctx.get("apiProxy");
    const agents = ctx.get("agents");
    const agent = agents ? agents.get(sessionId) : undefined;
    if (!api) {
      await tgSend(chatId, "apiProxy 未就绪，请稍后再试。");
      return;
    }
    try {
      const res = await api.sessions.prompt({
        rpcId: crypto.randomUUID(),
        payload: {
          sessionId,
          mode: "followup",
          content: [{ type: "text", text }]
        }
      });
      const result = res && res.result;
      if (result && result.ok) {
        lastActive.set(sessionId, Date.now());
        await tgSend(chatId, "📨 已发送到会话 #" + sessionId + (agent && agent.status === "idle" ? "，开始处理…" : "，已排入队列…"));
      } else {
        const error = (result && result.error) || {};
        await tgSend(chatId, "❌ 发送失败：" + escapeHtml(String(error.message !== undefined ? error.message : JSON.stringify(error))));
      }
    } catch (e) {
      await tgSend(chatId, "❌ 发送失败：" + escapeHtml(String((e && e.message) || e)));
    }
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────
  const pollTimer = setInterval(() => {
    if (!pollStarted && !pollStopped) {
      pollStarted = true;
      void pollLoop();
    }
  }, 500);

  return () => {
    pollStopped = true;
    clearInterval(pollTimer);
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        // ignore
      }
    }
  };
}