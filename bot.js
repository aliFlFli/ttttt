import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { NewMessage } from "telegram/events/index.js";
import { CallbackQuery } from "telegram/events/CallbackQuery.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { logger } from "./lib/logger.js";
import { openDb, makeStore } from "./lib/db.js";
import { JobQueue } from "./lib/queue.js";
import { t, setUptimeFn } from "./lib/i18n.js";
import {
  escapeHtml,
  sanitizeFileName,
  sanitizeCategoryName,
  fmtSize,
  fmtSpeed,
  getExtension,
  bar,
  normalizeId,
  RateLimiter,
  withRetry,
} from "./lib/utils.js";

const API_ID    = parseInt(process.env["TELEGRAM_API_ID"]  ?? "0", 10);
const API_HASH  = process.env["TELEGRAM_API_HASH"]  ?? "";
const BOT_TOKEN = process.env["TELEGRAM_BOT_TOKEN"] ?? "";
const ADMIN_ID  = normalizeId(process.env["TELEGRAM_ADMIN_ID"] ?? "155824019");

// How many files can be downloaded/uploaded at the same time across all users.
const QUEUE_CONCURRENCY = parseInt(process.env["QUEUE_CONCURRENCY"] ?? "2", 10);
// Anti-spam: max files a user may submit within the rolling window below.
const RATE_LIMIT_MAX_FILES = parseInt(process.env["RATE_LIMIT_MAX_FILES"] ?? "8", 10);
const RATE_LIMIT_WINDOW_MS = parseInt(process.env["RATE_LIMIT_WINDOW_MS"] ?? "60000", 10);

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), "data");
try {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
} catch {}

const SESSION_FILE = path.join(DATA_DIR, "tg_gramjs_session.txt");

let BOT_USERNAME = "Bot";

// --- Persistence (SQLite) -------------------------------------------------
const db = openDb(DATA_DIR);
const store = makeStore(db);

// --- Job queue for downloads/uploads --------------------------------------
const fileQueue = new JobQueue(QUEUE_CONCURRENCY);

// --- Anti-spam rate limiter ------------------------------------------------
const rateLimiter = new RateLimiter(RATE_LIMIT_MAX_FILES, RATE_LIMIT_WINDOW_MS);

function cloneAttributes(originalAttrs, newFileName) {
  const result = [];
  let hasFilename = false;

  for (const attr of originalAttrs || []) {
    const cn = (attr.className || (attr.constructor && attr.constructor.name) || "").toString();

    if (cn.includes("DocumentAttributeFilename") || attr instanceof Api.DocumentAttributeFilename) {
      result.push(new Api.DocumentAttributeFilename({ fileName: newFileName }));
      hasFilename = true;
      continue;
    }

    if (cn.includes("DocumentAttributeVideo") || attr instanceof Api.DocumentAttributeVideo) {
      result.push(new Api.DocumentAttributeVideo({
        roundMessage: !!attr.roundMessage,
        supportsStreaming: attr.supportsStreaming !== false,
        nosound: !!attr.nosound,
        duration: attr.duration || 0,
        w: attr.w || 0,
        h: attr.h || 0,
        preloadPrefixSize: attr.preloadPrefixSize,
        videoStartTs: attr.videoStartTs,
        videoCodec: attr.videoCodec,
      }));
      continue;
    }

    if (cn.includes("DocumentAttributeAudio") || attr instanceof Api.DocumentAttributeAudio) {
      result.push(new Api.DocumentAttributeAudio({
        voice: !!attr.voice,
        duration: attr.duration || 0,
        title: attr.title,
        performer: attr.performer,
        waveform: attr.waveform,
      }));
      continue;
    }

    if (cn.includes("DocumentAttributeAnimated") || attr instanceof Api.DocumentAttributeAnimated) {
      result.push(new Api.DocumentAttributeAnimated());
      continue;
    }

    if (cn.includes("DocumentAttributeHasStickers") || attr instanceof Api.DocumentAttributeHasStickers) {
      result.push(new Api.DocumentAttributeHasStickers());
      continue;
    }

    try {
      result.push(attr);
    } catch {}
  }

  if (!hasFilename) {
    result.push(new Api.DocumentAttributeFilename({ fileName: newFileName }));
  }
  return result;
}

const startTime = Date.now();
const userState = new Map();
const processingFiles = new Map();
const abortFlags = new Map();
const STATE_TIMEOUT_MS = 15 * 60 * 1000;

function setUserState(key, data) {
  const prev = userState.get(key);
  if (prev && prev.timeoutId) clearTimeout(prev.timeoutId);
  const timeoutId = setTimeout(() => userState.delete(key), STATE_TIMEOUT_MS);
  userState.set(key, Object.assign({}, data, { timeoutId }));
}
function clearUserState(key) {
  const state = userState.get(key);
  if (state && state.timeoutId) clearTimeout(state.timeoutId);
  userState.delete(key);
  abortFlags.delete(key);
}

function getUptime() {
  const diff = Date.now() - startTime;
  const days = Math.floor(diff / 86400000);
  const hours = Math.floor((diff % 86400000) / 3600000);
  return days + " روز " + hours + " ساعت";
}
setUptimeFn(getUptime);

function getLang(userId) {
  const u = store.getUser(userId, ADMIN_ID);
  return u.lang || "fa";
}

function buildDownloadMsg(fileName, pct, totalBytes, speed, eta, lang) {
  const done = Math.floor((totalBytes * pct) / 100);
  let msg = t("downloading", lang) + "\n\n";
  msg += bar(pct) + "  <b>" + pct + "%</b>\n";
  msg += "💾 " + fmtSize(done) + " / " + fmtSize(totalBytes) + "\n";
  if (speed) msg += "⚡ " + fmtSpeed(speed) + "\n";
  if (eta) msg += "⏱ " + eta + "\n";
  msg += "📄 <code>" + escapeHtml(fileName) + "</code>";
  return msg;
}
function buildUploadMsg(fileName, pct, totalBytes, speed, eta, lang) {
  const done = Math.floor((totalBytes * pct) / 100);
  let msg = t("downloadDone", lang) + "\n";
  msg += t("uploading", lang) + "\n\n";
  msg += bar(pct) + "  <b>" + pct + "%</b>\n";
  msg += "💾 " + fmtSize(done) + " / " + fmtSize(totalBytes) + "\n";
  if (speed) msg += "⚡ " + fmtSpeed(speed) + "\n";
  if (eta) msg += "⏱ " + eta + "\n";
  msg += "📄 <code>" + escapeHtml(fileName) + "</code>";
  return msg;
}

async function del(client, chatId, ids, delay) {
  if (!ids || !ids.length) return;
  if (delay) {
    setTimeout(() => {
      client.deleteMessages(chatId, ids, { revoke: true }).catch(() => {});
    }, delay);
  } else {
    await client.deleteMessages(chatId, ids, { revoke: true }).catch(() => {});
  }
}

function autoDelete(client, chatId, msgId, ms) {
  if (!msgId) return;
  setTimeout(() => {
    client.deleteMessages(chatId, [msgId], { revoke: true }).catch(() => {});
  }, ms || 5 * 60 * 1000);
}

async function notifyAdminError(client, err, context) {
  try {
    const text =
      "⚠️ <b>Bot Error</b>\n" +
      "📍 " + escapeHtml(context || "-") + "\n" +
      "<code>" + escapeHtml(String(err && err.message ? err.message : err).slice(0, 800)) + "</code>";
    await client.sendMessage(ADMIN_ID, { message: text, parseMode: "html" });
  } catch {}
  logger.error({ err, context }, "Bot error");
}

function makeButton(text, data) {
  return new Api.KeyboardButtonCallback({
    text,
    data: Buffer.from(String(data)),
  });
}

function LANG_KB() {
  return [[
    makeButton("🇮🇷 فارسی", "setlang_fa"),
    makeButton("🇬🇧 English", "setlang_en"),
  ]];
}
function MAIN_KB(lang) {
  return [
    [
      makeButton(lang === "en" ? "📖 Help" : "📖 راهنما", "help"),
      makeButton(lang === "en" ? "ℹ️ About" : "ℹ️ درباره", "about"),
    ],
    [
      makeButton(lang === "en" ? "👤 Profile" : "👤 پروفایل", "profile"),
      makeButton(lang === "en" ? "⭐ Premium" : "⭐ پریمیوم", "premium"),
    ],
    [
      makeButton(t("myFiles", lang), "myfiles"),
    ],
    [
      makeButton(lang === "en" ? "🌐 Language" : "🌐 زبان", "change_lang"),
    ],
  ];
}
function PREMIUM_KB(lang, refCount) {
  const rows = [];
  if (refCount >= 3) {
    rows.push([makeButton(lang === "en" ? "🥈 Activate Silver" : "🥈 فعال‌سازی نقره‌ای", "activate_silver")]);
  }
  if (refCount >= 5) {
    rows.push([makeButton(lang === "en" ? "🥇 Activate Gold" : "🥇 فعال‌سازی طلایی", "activate_gold")]);
  }
  rows.push([makeButton(lang === "en" ? "🔙 Back" : "🔙 بازگشت", "back_start")]);
  return rows;
}
function CANCEL_KB(lang) {
  return [[makeButton(lang === "en" ? "❌ Cancel" : "❌ لغو", "cancel")]];
}
function DONE_KB(lang) {
  return [[makeButton(lang === "en" ? "🔄 Another file" : "🔄 فایل دیگه", "another")]];
}
function BACK_KB(lang) {
  return [[makeButton(lang === "en" ? "🔙 Back" : "🔙 بازگشت", "back_start")]];
}
function CONFIRM_KB(token, lang) {
  return [[
    makeButton(lang === "en" ? "✅ Confirm" : "✅ تایید", "confirm_" + token),
    makeButton(lang === "en" ? "✏️ Edit" : "✏️ ویرایش", "edit"),
    makeButton(lang === "en" ? "❌ Cancel" : "❌ لغو", "cancel"),
  ]];
}
function CANCEL_PROCESS_KB(lang) {
  return [[makeButton(lang === "en" ? "⛔ Cancel process" : "⛔ لغو پردازش", "cancel_process")]];
}
function APPROVE_KB(userId) {
  return [[
    makeButton("✅ Approve", "approve_" + userId),
    makeButton("❌ Reject", "reject_" + userId),
  ]];
}
function CATEGORY_PICK_KB(lang, categories, token) {
  const rows = [];
  for (const cat of categories.slice(0, 8)) {
    rows.push([makeButton("📁 " + cat.name + " (" + cat.file_count + ")", "cat_" + token + "_" + cat.id)]);
  }
  rows.push([
    makeButton(t("newCategory", lang), "catnew_" + token),
    makeButton(t("noCategory", lang), "catnone_" + token),
  ]);
  return rows;
}
function MYFILES_CATEGORY_KB(lang, categories, uncategorizedCount) {
  const rows = [];
  for (const cat of categories) {
    rows.push([makeButton("📁 " + cat.name + " (" + cat.file_count + ")", "browsecat_" + cat.id)]);
  }
  if (uncategorizedCount > 0) {
    rows.push([makeButton(t("uncategorized", lang) + " (" + uncategorizedCount + ")", "browsecat_none")]);
  }
  rows.push([makeButton(lang === "en" ? "🔙 Back" : "🔙 بازگشت", "back_start")]);
  return rows;
}

async function processOneFile(client, chatId, key, lang, item, statusMsgId) {
  const newFileName = item.newName;
  const messageId = item.messageId;
  const fileSize = item.fileSize;

  const tmpPath = path.join(os.tmpdir(), "tg_dl_" + Date.now() + "_" + Math.random().toString(36).slice(2));
  const renamedPath = path.join(os.tmpdir(), "tg_out_" + Date.now() + "_" + Math.random().toString(36).slice(2) + "_" + newFileName);

  abortFlags.set(key, false);
  processingFiles.set(key, { statusMsgId, cancelled: false, tmpPath, renamedPath });

  let lastProgressUpdate = 0;
  let lastBytes = 0;
  let lastTime = Date.now();

  function isCancelled() {
    return abortFlags.get(key) === true ||
      (processingFiles.get(key) && processingFiles.get(key).cancelled);
  }

  const cleanup = () => {
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch {}
    try { if (fs.existsSync(renamedPath)) fs.unlinkSync(renamedPath); } catch {}
  };

  try {
    const messages = await client.getMessages(chatId, { ids: [messageId] });
    const origMsg = messages[0];
    if (!origMsg || !origMsg.media) throw new Error("Media not found");

    const origDoc = origMsg.media.document;
    const originalAttrs = (origDoc && origDoc.attributes) ? origDoc.attributes : [];
    const newAttributes = cloneAttributes(originalAttrs, newFileName);

    await client.editMessage(chatId, {
      message: statusMsgId,
      text: buildDownloadMsg(newFileName, 0, fileSize, 0, "", lang),
      parseMode: "html",
      buttons: CANCEL_PROCESS_KB(lang),
    }).catch(() => {});

    // Download with retry: transient network errors get a couple of retries
    // (starting the download over) instead of failing the whole job outright.
    await withRetry(
      async (attempt) => {
        if (attempt > 0) {
          await client.editMessage(chatId, {
            message: statusMsgId,
            text: t("retrying", lang) + "\n" + buildDownloadMsg(newFileName, 0, fileSize, 0, "", lang),
            parseMode: "html",
            buttons: CANCEL_PROCESS_KB(lang),
          }).catch(() => {});
        }
        lastProgressUpdate = 0;
        lastBytes = 0;
        lastTime = Date.now();
        await client.downloadMedia(origMsg.media, {
          outputFile: tmpPath,
          progressCallback: async (downloaded, total) => {
            if (isCancelled()) throw new Error("Cancelled by user");
            const now = Date.now();
            if (now - lastProgressUpdate < 2000) return;
            lastProgressUpdate = now;

            const totalNum = Number(total) || fileSize;
            const downloadedNum = Number(downloaded);
            const pct = totalNum > 0 ? Math.min(99, Math.floor((downloadedNum / totalNum) * 100)) : 0;
            const elapsed = (now - lastTime) / 1000;
            const speed = elapsed > 0 ? (downloadedNum - lastBytes) / elapsed : 0;
            lastBytes = downloadedNum;
            lastTime = now;

            let eta = "";
            if (speed > 0) {
              const remainingSec = Math.ceil((totalNum - downloadedNum) / speed);
              eta = Math.floor(remainingSec / 60) + ":" + String(remainingSec % 60).padStart(2, "0");
            }

            await client.editMessage(chatId, {
              message: statusMsgId,
              text: buildDownloadMsg(newFileName, pct, totalNum, speed, eta, lang),
              parseMode: "html",
              buttons: CANCEL_PROCESS_KB(lang),
            }).catch(() => {});
          },
        });
      },
      { retries: 2, baseDelayMs: 2000, shouldRetry: (err) => err.message !== "Cancelled by user" }
    );

    if (isCancelled()) throw new Error("Cancelled by user");
    fs.renameSync(tmpPath, renamedPath);

    lastProgressUpdate = 0;
    lastBytes = 0;
    lastTime = Date.now();

    await client.editMessage(chatId, {
      message: statusMsgId,
      text: buildUploadMsg(newFileName, 0, fileSize, 0, "", lang),
      parseMode: "html",
      buttons: CANCEL_PROCESS_KB(lang),
    }).catch(() => {});

    await withRetry(
      async (attempt) => {
        if (attempt > 0) {
          await client.editMessage(chatId, {
            message: statusMsgId,
            text: t("retrying", lang) + "\n" + buildUploadMsg(newFileName, 0, fileSize, 0, "", lang),
            parseMode: "html",
            buttons: CANCEL_PROCESS_KB(lang),
          }).catch(() => {});
        }
        lastProgressUpdate = 0;
        lastBytes = 0;
        lastTime = Date.now();
        await client.sendFile(chatId, {
          file: renamedPath,
          caption:
            t("done", lang) + "\n" +
            "📄 <code>" + escapeHtml(newFileName) + "</code>\n" +
            "💾 " + fmtSize(fileSize),
          parseMode: "html",
          forceDocument: true,
          attributes: newAttributes,
          progressCallback: async (progress) => {
            if (isCancelled()) throw new Error("Cancelled by user");
            const now = Date.now();
            if (now - lastProgressUpdate < 2000) return;
            lastProgressUpdate = now;

            const pct = Math.min(99, Math.floor(progress * 100));
            const uploaded = progress * fileSize;
            const elapsed = (now - lastTime) / 1000;
            const speed = elapsed > 0 ? (uploaded - lastBytes) / elapsed : 0;
            lastBytes = uploaded;
            lastTime = now;

            let eta = "";
            if (speed > 0) {
              const remainingSec = Math.ceil((fileSize - uploaded) / speed);
              eta = Math.floor(remainingSec / 60) + ":" + String(remainingSec % 60).padStart(2, "0");
            }

            await client.editMessage(chatId, {
              message: statusMsgId,
              text: buildUploadMsg(newFileName, pct, fileSize, speed, eta, lang),
              parseMode: "html",
              buttons: CANCEL_PROCESS_KB(lang),
            }).catch(() => {});
          },
        });
      },
      { retries: 2, baseDelayMs: 2000, shouldRetry: (err) => err.message !== "Cancelled by user" }
    );

    store.incStat("files_total", 1);
    store.incStat("bytes_total", fileSize);

    const u = store.getUser(chatId, ADMIN_ID);
    u.count++;
    u.total_bytes += fileSize;
    store.ensureDailyReset(u);
    u.daily_bytes += fileSize;
    store.saveUser(u);

    store.recordFile({
      userId: chatId,
      categoryId: item.categoryId ?? null,
      originalName: item.originalName,
      newName: newFileName,
      size: fileSize,
    });

    if (normalizeId(chatId) !== ADMIN_ID) {
      await client.sendMessage(ADMIN_ID, {
        message:
          "🔔 <b>File processed</b>\n" +
          "👤 <code>" + escapeHtml(chatId) + "</code>\n" +
          "📄 <code>" + escapeHtml(newFileName) + "</code>\n" +
          "💾 " + fmtSize(fileSize),
        parseMode: "html",
      }).catch(() => {});
    }

    return true;
  } catch (err) {
    if (err.message === "Cancelled by user") return false;
    await notifyAdminError(client, err, "processOneFile:" + newFileName);
    throw err;
  } finally {
    cleanup();
    processingFiles.delete(key);
  }
}

export async function startBot() {
  console.log("startBot() called");

  if (!API_ID || !API_HASH || !BOT_TOKEN) {
    console.error("Missing credentials!");
    logger.warn("Missing Telegram credentials");
    return;
  }

  let sessionStr = "";
  try { sessionStr = fs.readFileSync(SESSION_FILE, "utf-8").trim(); } catch {}

  const client = new TelegramClient(
    new StringSession(sessionStr),
    API_ID,
    API_HASH,
    { connectionRetries: 10, retryDelay: 2000 }
  );

  let reconnecting = false;
  async function ensureConnected() {
    if (reconnecting) return;
    try {
      if (!client.connected) {
        reconnecting = true;
        console.log("Reconnecting...");
        await client.connect();
        console.log("Reconnected");
      }
    } catch (e) {
      console.error("Reconnect failed:", e.message);
      await notifyAdminError(client, e, "reconnect");
    } finally {
      reconnecting = false;
    }
  }
  setInterval(ensureConnected, 30000);

  console.log("Connecting...");
  await client.start({ botAuthToken: BOT_TOKEN });
  console.log("Bot started");

  try {
    const me = await client.getMe();
    BOT_USERNAME = me.username || "Bot";
    console.log("Bot username:", BOT_USERNAME);
  } catch (e) {
    console.error("getMe failed:", e.message);
  }

  try {
    fs.writeFileSync(SESSION_FILE, client.session.save(), "utf-8");
  } catch {}

  store.getUser(ADMIN_ID, ADMIN_ID);
  logger.info("Telegram bot started");

  async function doApprove(client, targetId) {
    const target = store.getUser(targetId, ADMIN_ID);
    target.status = "approved";
    store.saveUser(target);

    if (target.referred_by) {
      const refId = target.referred_by;
      store.addReferral(refId, String(targetId));
      const refCount = store.countReferrals(refId);
      const ref = store.getUser(refId, ADMIN_ID);
      const refLang = ref.lang || "fa";

      await client.sendMessage(refId, {
        message:
          t("newReferral", refLang) +
          "👤 <code>" + escapeHtml(targetId) + "</code>\n" +
          "👥 " + (refLang === "en" ? "Total: " : "مجموع: ") + refCount,
        parseMode: "html",
      }).catch(() => {});

      let reward = null;
      if (refCount >= 5 && ref.premium_tier !== "gold") {
        ref.status = "premium";
        ref.premium_tier = "gold";
        ref.premium_until = Date.now() + 30 * 24 * 60 * 60 * 1000;
        ref.premium_limit = 15 * 1024 * 1024 * 1024;
        store.saveUser(ref);
        reward = { tier: "gold", days: 30, limitGB: 15 };
      } else if (refCount >= 3 && !ref.premium_tier) {
        ref.status = "premium";
        ref.premium_tier = "silver";
        ref.premium_until = Date.now() + 15 * 24 * 60 * 60 * 1000;
        ref.premium_limit = 10 * 1024 * 1024 * 1024;
        store.saveUser(ref);
        reward = { tier: "silver", days: 15, limitGB: 10 };
      }

      if (reward) {
        const tierName = reward.tier === "gold" ? "طلایی (Gold)" : "نقره‌ای (Silver)";
        await client.sendMessage(refId, {
          message: "🎉 پریمیوم " + tierName + " فعال شد!\n" +
            reward.limitGB + " گیگابایت روزانه / " + reward.days + " روز",
        }).catch(() => {});
      }
    }

    await client.sendMessage(targetId, {
      message: t("approved", target.lang || "fa"),
      buttons: MAIN_KB(target.lang || "fa"),
    }).catch(() => {});
  }

  client.addEventHandler(async (event) => {
    const msg = event.message;
    if (!msg || !msg.isPrivate) return;

    const chatId = normalizeId(msg.chatId);
    const key = chatId;
    const text = msg.message || "";
    const isAdmin = chatId === ADMIN_ID;
    const u = store.getUser(chatId, ADMIN_ID);
    const lang = getLang(chatId);

    if ((u.status === "banned" || store.isBanned(chatId)) && !isAdmin) {
      await client.sendMessage(chatId, { message: t("banned", lang) });
      return;
    }

    u.last_seen = new Date().toDateString();
    store.saveUser(u);

    if (isAdmin) {
      if (text.startsWith("/ban ")) {
        const userId = normalizeId(text.split(" ")[1]);
        if (userId && userId !== ADMIN_ID) {
          const target = store.getUser(userId, ADMIN_ID);
          target.status = "banned";
          store.saveUser(target);
          store.ban(userId);
          await client.sendMessage(chatId, { message: "User " + userId + " banned." });
        }
        return;
      }
      if (text.startsWith("/unban ")) {
        const userId = normalizeId(text.split(" ")[1]);
        if (userId) {
          const target = store.getUser(userId, ADMIN_ID);
          target.status = "approved";
          store.saveUser(target);
          store.unban(userId);
          await client.sendMessage(chatId, { message: "User " + userId + " unbanned." });
        }
        return;
      }
      if (text === "/banlist") {
        const list = store.listBanned();
        const body = list.length
          ? list.map(id => "• <code>" + escapeHtml(id) + "</code>").join("\n")
          : "Empty.";
        await client.sendMessage(chatId, { message: "<b>Banned</b>\n\n" + body, parseMode: "html" });
        return;
      }
      if (text === "/stats") {
        const allUsers = store.allUsers();
        const totalUsers = allUsers.length;
        const pendingCount = allUsers.filter(x => x.status === "pending").length;
        const premiumCount = allUsers.filter(x => store.isPremium(x)).length;
        const cfg = store.getBotConfig();
        await client.sendMessage(chatId, {
          message:
            "<b>Stats</b>\n\n" +
            "Files: <b>" + store.getStat("files_total") + "</b>\n" +
            "Size: <b>" + fmtSize(store.getStat("bytes_total")) + "</b>\n" +
            "Users: <b>" + totalUsers + "</b>\n" +
            "Pending: <b>" + pendingCount + "</b>\n" +
            "Premium: <b>" + premiumCount + "</b>\n" +
            "Banned: <b>" + store.listBanned().length + "</b>\n" +
            "Queue: <b>" + fileQueue.running + " running / " + fileQueue.pending + " waiting</b>\n" +
            "Uptime: <b>" + getUptime() + "</b>\n" +
            "Max size: <b>" + fmtSize(cfg.maxFileSize) + "</b>",
          parseMode: "html",
        });
        return;
      }
      if (text === "/ping") {
        await client.sendMessage(chatId, { message: t("online", lang) });
        return;
      }
      if (text.startsWith("/broadcast ")) {
        const body = text.slice("/broadcast ".length).trim();
        if (!body) {
          await client.sendMessage(chatId, { message: "Write message after command." });
          return;
        }
        const ids = store.allUsers().map(x => x.id);
        let ok = 0, fail = 0;
        await client.sendMessage(chatId, { message: "Sending to " + ids.length + " users..." });
        for (const id of ids) {
          try {
            await client.sendMessage(id, { message: body, parseMode: "html" });
            ok++;
          } catch (e) {
            fail++;
            // Respect Telegram flood-wait instead of hammering through it.
            const waitSec = e && e.seconds ? e.seconds : null;
            if (waitSec) await new Promise(r => setTimeout(r, (waitSec + 1) * 1000));
          }
          await new Promise(r => setTimeout(r, 50));
        }
        await client.sendMessage(chatId, { message: "OK: " + ok + " | Fail: " + fail });
        return;
      }
      if (text === "/users") {
        const entries = store.allUsers()
          .sort((a, b) => (b.count || 0) - (a.count || 0))
          .slice(0, 20);
        let m = "<b>Top users</b>\n\n";
        entries.forEach((row, idx) => {
          m += (idx + 1) + ". <code>" + escapeHtml(row.id) + "</code> — " + (row.count || 0) + " (" + escapeHtml(row.status) + ")\n";
        });
        await client.sendMessage(chatId, { message: m, parseMode: "html" });
        return;
      }
      if (text === "/pending") {
        const pending = store.allUsers().filter(x => x.status === "pending");
        if (!pending.length) {
          await client.sendMessage(chatId, { message: "No pending users." });
          return;
        }
        let m = "<b>Pending users</b>\n\n";
        pending.slice(0, 30).forEach((row) => {
          m += "• <code>" + escapeHtml(row.id) + "</code>\n";
        });
        await client.sendMessage(chatId, { message: m, parseMode: "html" });
        return;
      }
      if (text.startsWith("/approve ")) {
        const userId = normalizeId(text.split(" ")[1]);
        if (userId) {
          await doApprove(client, userId);
          await client.sendMessage(chatId, { message: "Approved " + userId });
        }
        return;
      }
      if (text.startsWith("/reject ")) {
        const userId = normalizeId(text.split(" ")[1]);
        if (userId) {
          const target = store.getUser(userId, ADMIN_ID);
          target.status = "banned";
          store.saveUser(target);
          await client.sendMessage(userId, { message: t("rejected", target.lang || "fa") }).catch(() => {});
          await client.sendMessage(chatId, { message: "Rejected " + userId });
        }
        return;
      }
      if (text.startsWith("/premium ")) {
        const parts = text.split(/\s+/);
        const userId = normalizeId(parts[1]);
        const days = parseInt(parts[2]) || 30;
        const limitGB = parseFloat(parts[3]) || 15;
        if (userId) {
          const target = store.getUser(userId, ADMIN_ID);
          target.status = "premium";
          target.premium_tier = limitGB >= 15 ? "gold" : "silver";
          target.premium_until = Date.now() + days * 24 * 60 * 60 * 1000;
          target.premium_limit = Math.floor(limitGB * 1024 * 1024 * 1024);
          store.saveUser(target);
          await client.sendMessage(chatId, { message: "Premium set for " + userId + " (" + days + "d / " + limitGB + "GB)" });
          await client.sendMessage(userId, {
            message: "⭐ Premium activated for " + days + " days (" + limitGB + " GB daily)",
          }).catch(() => {});
        }
        return;
      }
      if (text.startsWith("/setlimit ")) {
        const gb = parseFloat(text.split(" ")[1]);
        if (!gb || gb <= 0) {
          await client.sendMessage(chatId, { message: "Example: /setlimit 2" });
          return;
        }
        store.setMaxFileSize(Math.floor(gb * 1024 * 1024 * 1024));
        await client.sendMessage(chatId, { message: "Max size: " + fmtSize(store.getBotConfig().maxFileSize) });
        return;
      }
      if (text === "/cleanup") {
        let cleaned = 0;
        userState.forEach((_, ukey) => { clearUserState(ukey); cleaned++; });
        processingFiles.clear();
        abortFlags.clear();
        try {
          const files = fs.readdirSync(os.tmpdir());
          files.forEach(f => {
            if (f.indexOf("tg_dl_") === 0 || f.indexOf("tg_out_") === 0) {
              try { fs.unlinkSync(path.join(os.tmpdir(), f)); cleaned++; } catch {}
            }
          });
        } catch {}
        await client.sendMessage(chatId, { message: "Cleanup done. Items: " + cleaned });
        return;
      }
      if (text === "/export") {
        // CSV export of all users for the admin (id, status, counts, etc.)
        const rows = store.allUsers();
        const header = "id,status,lang,count,total_bytes,daily_bytes,premium_tier,premium_until,first_seen,last_seen\n";
        const csvEscape = (v) => {
          const s = String(v ?? "");
          return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
        };
        const body = rows.map(r => [
          r.id, r.status, r.lang, r.count, r.total_bytes, r.daily_bytes,
          r.premium_tier, r.premium_until, r.first_seen, r.last_seen,
        ].map(csvEscape).join(",")).join("\n");
        const csvPath = path.join(os.tmpdir(), "users_export_" + Date.now() + ".csv");
        fs.writeFileSync(csvPath, header + body, "utf-8");
        await client.sendFile(chatId, {
          file: csvPath,
          caption: "📊 Users export (" + rows.length + " rows)",
          forceDocument: true,
        });
        try { fs.unlinkSync(csvPath); } catch {}
        return;
      }
    }

    if (text.startsWith("/start")) {
      const parts = text.trim().split(/\s+/);
      const payload = parts[1] || "";

      if (payload.startsWith("ref_") && u.status === "pending" && !u.referred_by) {
        const refId = normalizeId(payload.slice(4));
        if (refId && refId !== chatId && store.getUser(refId, ADMIN_ID)) {
          u.referred_by = refId;
          store.saveUser(u);
        }
      }

      // Admin: never wipe premium on /start
      if (isAdmin) {
        if (!u.lang) u.lang = "fa";
        if (u.status !== "premium") u.status = "approved";
        store.saveUser(u);
        setUserState(key, { stage: "idle", pendingFiles: [] });
        await client.sendMessage(chatId, {
          message: t("welcome", u.lang),
          parseMode: "html",
          buttons: MAIN_KB(u.lang),
        });
        return;
      }

      if (!u.lang) {
        await client.sendMessage(chatId, {
          message: "🌐 Please choose your language:\nلطفاً زبان خود را انتخاب کنید:",
          buttons: LANG_KB(),
        });
        return;
      }

      if (u.status === "pending") {
        await client.sendMessage(chatId, {
          message: t("pending", lang),
          buttons: [[makeButton(lang === "en" ? "🌐 Language" : "🌐 زبان", "change_lang")]],
        });
        return;
      }

      if (u.status === "banned") {
        await client.sendMessage(chatId, { message: t("banned", lang) });
        return;
      }

      // Normal / premium users: welcome only — do NOT touch status or premium fields
      setUserState(key, { stage: "idle", pendingFiles: [] });
      await client.sendMessage(chatId, {
        message: t("welcome", lang),
        parseMode: "html",
        buttons: MAIN_KB(lang),
      });
      return;
    }

    if (u.status !== "approved" && u.status !== "premium" && !isAdmin) {
      if (u.status === "pending") {
        await client.sendMessage(chatId, { message: t("needApproval", lang) });
      }
      return;
    }

    let doc = msg.document;
    if (!doc && msg.media instanceof Api.MessageMediaDocument) {
      doc = msg.media.document;
    }

    if (doc) {
      if (!rateLimiter.allow(chatId)) {
        const waitSec = Math.ceil(rateLimiter.retryAfterMs(chatId) / 1000);
        const m = await client.sendMessage(chatId, {
          message: t("rateLimited", lang) + " (" + waitSec + "s)",
        });
        autoDelete(client, chatId, m.id, 8000);
        return;
      }

      const rawName = (doc.attributes && doc.attributes.find(a => a instanceof Api.DocumentAttributeFilename)) || null;
      const originalName = sanitizeFileName((rawName && rawName.fileName) || ("file_" + msg.id), "file_" + msg.id);
      const fileSize = Number(doc.size || 0);
      const cfg = store.getBotConfig();

      if (fileSize > cfg.maxFileSize) {
        const m = await client.sendMessage(chatId, { message: t("tooBig", lang) });
        autoDelete(client, chatId, m.id, 15000);
        return;
      }

      store.ensureDailyReset(u);
      const limit = store.isPremium(u) ? (u.premium_limit || 10 * 1024 * 1024 * 1024) : cfg.normalDailyLimit;
      if (u.daily_bytes + fileSize > limit) {
        const m = await client.sendMessage(chatId, {
          message: t("limitReached", lang) + "\n\n" +
            "📊 " + fmtSize(u.daily_bytes) + " / " + fmtSize(limit),
          buttons: MAIN_KB(lang),
        });
        autoDelete(client, chatId, m.id, 20000);
        return;
      }

      let state = userState.get(key) || { stage: "idle", pendingFiles: [] };
      if (!state.pendingFiles) state.pendingFiles = [];

      if (state.promptMsgId) await del(client, chatId, [state.promptMsgId]);
      if (state.confirmMsgId) await del(client, chatId, [state.confirmMsgId]);

      state.pendingFiles.push({ messageId: msg.id, originalName, fileSize });

      const count = state.pendingFiles.length;
      const prompt = await client.sendMessage(chatId, {
        message:
          "📦 <b>" + escapeHtml(originalName) + "</b>\n" +
          "💾 " + fmtSize(fileSize) + "\n" +
          (count > 1 ? ("📋 " + count + "\n") : "") +
          "\n" +
          (count > 1
            ? t("enterNamesBatch", lang) + count + "):\n<code>name1\nname2</code>"
            : t("enterName", lang)),
        parseMode: "html",
        buttons: CANCEL_KB(lang),
      });

      setUserState(key, {
        stage: "awaiting_name",
        pendingFiles: state.pendingFiles,
        promptMsgId: prompt.id,
      });
      return;
    }

    if (text && !text.startsWith("/")) {
      const state = userState.get(key);

      // Category name entry (after user tapped "New category").
      if (state && state.stage === "awaiting_category_name" && state.items) {
        const catName = sanitizeCategoryName(text);
        const cat = store.findOrCreateCategory(chatId, catName);
        await startProcessing(client, chatId, key, lang, state.items.map(it => ({ ...it, categoryId: cat.id })));
        return;
      }

      if (!state || state.stage !== "awaiting_name" || !state.pendingFiles || !state.pendingFiles.length) {
        const tip = await client.sendMessage(chatId, {
          message: t("sendFileFirst", lang),
          buttons: [[makeButton(lang === "en" ? "📖 Help" : "📖 راهنما", "help")]],
        });
        autoDelete(client, chatId, tip.id, 4000);
        autoDelete(client, chatId, msg.id, 4000);
        return;
      }

      const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
      const files = state.pendingFiles;

      if (lines.length !== files.length) {
        const tip = await client.sendMessage(chatId, {
          message:
            (lang === "en"
              ? "⚠️ Please send exactly " + files.length + " name(s), one per line."
              : "⚠️ دقیقاً " + files.length + " نام بفرستید (هر نام در یک خط)."),
          buttons: CANCEL_KB(lang),
        });
        autoDelete(client, chatId, tip.id, 8000);
        return;
      }

      const items = files.map((f, i) => {
        const ext = getExtension(f.originalName);
        let candidate = lines[i];
        if (ext && candidate.indexOf(".") === -1) candidate = candidate + "." + ext;
        const newName = sanitizeFileName(candidate, f.originalName);
        return {
          messageId: f.messageId,
          originalName: f.originalName,
          fileSize: f.fileSize,
          newName,
        };
      });

      await del(client, chatId, [msg.id, state.promptMsgId]);

      let previewText = (items.length > 1 ? t("previewBatch", lang) : t("preview", lang));
      items.forEach((it, idx) => {
        if (items.length > 1) previewText += "<b>#" + (idx + 1) + "</b>\n";
        previewText += t("currentName", lang) + "<code>" + escapeHtml(it.originalName) + "</code>\n";
        previewText += t("newName", lang) + "<code>" + escapeHtml(it.newName) + "</code>\n\n";
      });

      const token = "b" + Date.now().toString(36);
      const confirmMsg = await client.sendMessage(chatId, {
        message: previewText,
        parseMode: "html",
        buttons: CONFIRM_KB(token, lang),
      });

      setUserState(key, {
        stage: "confirming",
        items,
        confirmToken: token,
        confirmMsgId: confirmMsg.id,
      });
      return;
    }
  }, new NewMessage({}));

  /**
   * Runs the queued processing loop for a batch of items (already tagged
   * with categoryId if applicable). Handles queue position messaging.
   */
  async function startProcessing(client, chatId, key, lang, items) {
    setUserState(key, { stage: "processing", items });

    const statusMsg = await client.sendMessage(chatId, {
      message: t("queued", lang) + fileQueue.nextPosition(),
      buttons: CANCEL_PROCESS_KB(lang),
    });

    await fileQueue.run(async () => {
      try {
        for (let i = 0; i < items.length; i++) {
          if (abortFlags.get(key)) break;
          const item = items[i];
          if (items.length > 1) {
            await client.editMessage(chatId, {
              message: statusMsg.id,
              text:
                (lang === "en" ? "📦 File " : "📦 ") +
                (i + 1) + "/" + items.length + "\n" +
                buildDownloadMsg(item.newName, 0, item.fileSize, 0, "", lang),
              parseMode: "html",
              buttons: CANCEL_PROCESS_KB(lang),
            }).catch(() => {});
          }
          const ok = await processOneFile(client, chatId, key, lang, item, statusMsg.id);
          if (!ok) break;
        }

        await del(client, chatId, [statusMsg.id]);
        if (!abortFlags.get(key)) {
          const doneMsg = await client.sendMessage(chatId, {
            message: t("done", lang),
            parseMode: "html",
            buttons: DONE_KB(lang),
          });
          autoDelete(client, chatId, doneMsg.id, 5 * 60 * 1000);
        }
      } catch (err) {
        await client.editMessage(chatId, {
          message: statusMsg.id,
          text: t("errorProcess", lang),
        }).catch(() => {});
        await notifyAdminError(client, err, "processing batch");
        autoDelete(client, chatId, statusMsg.id, 60 * 1000);
      } finally {
        clearUserState(key);
      }
    }, (position) => {
      client.editMessage(chatId, {
        message: statusMsg.id,
        text: t("queued", lang) + position,
        buttons: CANCEL_PROCESS_KB(lang),
      }).catch(() => {});
    });
  }

  client.addEventHandler(async (event) => {
    const data = (event.data && event.data.toString()) || "";
    const chatId = normalizeId(event.query.userId);
    const key = chatId;
    const state = userState.get(key);
    const u = store.getUser(chatId, ADMIN_ID);
    const lang = getLang(chatId);
    const isAdmin = chatId === ADMIN_ID;

    await event.answer().catch(() => {});

    if (data === "setlang_fa" || data === "setlang_en") {
      const newLang = data === "setlang_fa" ? "fa" : "en";
      u.lang = newLang;
      store.saveUser(u);

      await client.sendMessage(chatId, { message: t("langSet", newLang) });

      if (isAdmin) {
        if (u.status !== "premium") u.status = "approved";
        store.saveUser(u);
        await client.sendMessage(chatId, {
          message: t("welcome", newLang),
          parseMode: "html",
          buttons: MAIN_KB(newLang),
        });
        return;
      }

      if (u.status === "pending") {
        await client.sendMessage(chatId, { message: t("pending", newLang) });

        const refText = u.referred_by ? "\n🔗 Referred by: <code>" + escapeHtml(u.referred_by) + "</code>" : "";
        await client.sendMessage(ADMIN_ID, {
          message:
            "🆕 <b>New user request</b>\n" +
            "👤 <code>" + escapeHtml(chatId) + "</code>\n" +
            "🌐 " + newLang +
            refText,
          parseMode: "html",
          buttons: APPROVE_KB(chatId),
        }).catch(() => {});
      } else {
        await client.sendMessage(chatId, {
          message: t("welcome", newLang),
          parseMode: "html",
          buttons: MAIN_KB(newLang),
        });
      }
      return;
    }

    if (data === "change_lang") {
      await client.sendMessage(chatId, {
        message: t("chooseLang", lang),
        buttons: LANG_KB(),
      });
      return;
    }

    if (data === "help") {
      const m = await client.sendMessage(chatId, {
        message: t("help", lang),
        parseMode: "html",
        buttons: BACK_KB(lang),
      });
      autoDelete(client, chatId, m.id, 10 * 60 * 1000);
      return;
    }

    if (data === "about") {
      const cfg = store.getBotConfig();
      const m = await client.sendMessage(chatId, {
        message: t("about", lang, cfg.maxFileSize),
        parseMode: "html",
        buttons: BACK_KB(lang),
      });
      autoDelete(client, chatId, m.id, 10 * 60 * 1000);
      return;
    }

    if (data === "myfiles") {
      const categories = store.listCategories(chatId);
      const uncategorized = store.listFiles(chatId, null, 1, 0);
      // We only need to know if there's at least one; do a small count query via listFiles length trick:
      const uncategorizedAll = store.listFiles(chatId, null, 1000, 0);
      if (!categories.length && !uncategorizedAll.length) {
        await client.sendMessage(chatId, {
          message: t("myFilesTitle", lang) + "\n\n" + t("noCategoriesYet", lang),
          parseMode: "html",
          buttons: BACK_KB(lang),
        });
        return;
      }
      await client.sendMessage(chatId, {
        message: t("myFilesTitle", lang),
        parseMode: "html",
        buttons: MYFILES_CATEGORY_KB(lang, categories, uncategorizedAll.length),
      });
      return;
    }

    if (data.startsWith("browsecat_")) {
      const raw = data.replace("browsecat_", "");
      const categoryId = raw === "none" ? null : parseInt(raw, 10);
      const files = store.listFiles(chatId, categoryId, 20, 0);
      let body = t("filesInCategory", lang);
      if (!files.length) {
        body += t("noFilesHere", lang);
      } else {
        files.forEach((f) => {
          body += "📄 <code>" + escapeHtml(f.new_name) + "</code> — " + fmtSize(f.size) + "\n";
        });
      }
      await client.sendMessage(chatId, {
        message: body,
        parseMode: "html",
        buttons: [[makeButton(lang === "en" ? "🔙 Back" : "🔙 بازگشت", "myfiles")]],
      });
      return;
    }

    if (data === "premium") {
      const refCount = store.countReferrals(chatId);
      let body = t("premiumTitle", lang) + t("premiumInfo", lang);
      body += "\n\n👥 " + (lang === "en" ? "Your referrals: " : "زیرمجموعه‌های شما: ") + "<b>" + refCount + "</b>";

      if (store.isPremium(u)) {
        const leftDays = Math.ceil((u.premium_until - Date.now()) / (24 * 60 * 60 * 1000));
        const tierName = u.premium_tier === "gold"
          ? (lang === "en" ? "Gold" : "طلایی")
          : (lang === "en" ? "Silver" : "نقره‌ای");
        body += "\n\n" + t("premiumActive", lang);
        body += "\n⭐ " + tierName + " — " + leftDays + (lang === "en" ? " days left" : " روز باقی‌مانده");
      }

      await client.sendMessage(chatId, {
        message: body,
        parseMode: "html",
        buttons: PREMIUM_KB(lang, refCount),
      });
      return;
    }

    if (data === "activate_silver") {
      if (store.countReferrals(chatId) < 3) {
        await client.sendMessage(chatId, { message: t("premiumNeedMore", lang) });
        return;
      }
      u.status = "premium";
      u.premium_tier = "silver";
      u.premium_until = Date.now() + 15 * 24 * 60 * 60 * 1000;
      u.premium_limit = 10 * 1024 * 1024 * 1024;
      store.saveUser(u);
      await client.sendMessage(chatId, {
        message: t("premiumActivated", lang) + "\n🥈 " + (lang === "en" ? "Silver — 10 GB / 15 days" : "نقره‌ای — ۱۰ گیگ / ۱۵ روز"),
        buttons: MAIN_KB(lang),
      });
      return;
    }

    if (data === "activate_gold") {
      if (store.countReferrals(chatId) < 5) {
        await client.sendMessage(chatId, { message: t("premiumNeedMore", lang) });
        return;
      }
      u.status = "premium";
      u.premium_tier = "gold";
      u.premium_until = Date.now() + 30 * 24 * 60 * 60 * 1000;
      u.premium_limit = 15 * 1024 * 1024 * 1024;
      store.saveUser(u);
      await client.sendMessage(chatId, {
        message: t("premiumActivated", lang) + "\n🥇 " + (lang === "en" ? "Gold — 15 GB / 30 days" : "طلایی — ۱۵ گیگ / ۳۰ روز"),
        buttons: MAIN_KB(lang),
      });
      return;
    }

    if (data === "profile") {
      store.ensureDailyReset(u);
      const cfg = store.getBotConfig();
      const limit = store.isPremium(u) ? (u.premium_limit || 10 * 1024 * 1024 * 1024) : cfg.normalDailyLimit;
      let statusText =
        u.status === "pending" ? t("statusPending", lang) :
        u.status === "banned" ? t("statusBanned", lang) :
        store.isPremium(u) ? t("statusPremium", lang) :
        t("statusApproved", lang);

      let premiumLine = "";
      if (store.isPremium(u)) {
        const leftDays = Math.ceil((u.premium_until - Date.now()) / (24 * 60 * 60 * 1000));
        const tierName = u.premium_tier === "gold"
          ? (lang === "en" ? "Gold" : "طلایی")
          : (lang === "en" ? "Silver" : "نقره‌ای");
        premiumLine = "⭐ " + tierName + " — " + leftDays + (lang === "en" ? " days left\n" : " روز باقی‌مانده\n");
      }

      const refCount = store.countReferrals(chatId);
      const refLink = "https://t.me/" + BOT_USERNAME + "?start=ref_" + chatId;

      const text =
        t("profileTitle", lang) +
        "🆔 <code>" + escapeHtml(chatId) + "</code>\n" +
        "📊 " + statusText + "\n" +
        premiumLine +
        "📁 " + (lang === "en" ? "Files: " : "فایل‌ها: ") + u.count + "\n" +
        "💾 " + (lang === "en" ? "Today: " : "امروز: ") + fmtSize(u.daily_bytes) + " / " + fmtSize(limit) + "\n" +
        "📦 " + (lang === "en" ? "Total: " : "مجموع: ") + fmtSize(u.total_bytes) + "\n" +
        "👥 " + (lang === "en" ? "Referrals: " : "زیرمجموعه‌ها: ") + refCount + "\n\n" +
        t("referralInfo", lang) +
        "<code>" + escapeHtml(refLink) + "</code>";

      await client.sendMessage(chatId, {
        message: text,
        parseMode: "html",
        buttons: BACK_KB(lang),
      });
      return;
    }

    if (data === "back_start") {
      setUserState(key, { stage: "idle", pendingFiles: [] });
      await client.sendMessage(chatId, {
        message: t("welcome", lang),
        parseMode: "html",
        buttons: MAIN_KB(lang),
      });
      return;
    }

    if (data === "edit") {
      if (state && state.stage === "confirming" && state.items) {
        await del(client, chatId, [state.confirmMsgId]);
        const pendingFiles = state.items.map(it => ({
          messageId: it.messageId,
          originalName: it.originalName,
          fileSize: it.fileSize,
        }));
        const prompt = await client.sendMessage(chatId, {
          message:
            (pendingFiles.length > 1
              ? t("enterNamesBatch", lang) + pendingFiles.length + "):"
              : t("enterName", lang)),
          parseMode: "html",
          buttons: CANCEL_KB(lang),
        });
        setUserState(key, {
          stage: "awaiting_name",
          pendingFiles,
          promptMsgId: prompt.id,
        });
      }
      return;
    }

    if (data === "cancel_process") {
      abortFlags.set(key, true);
      const processData = processingFiles.get(key);
      if (processData) {
        processingFiles.set(key, Object.assign({}, processData, { cancelled: true }));
        await client.editMessage(chatId, {
          message: processData.statusMsgId,
          text: t("processCancelled", lang),
        }).catch(() => {});
        try { if (processData.tmpPath && fs.existsSync(processData.tmpPath)) fs.unlinkSync(processData.tmpPath); } catch {}
        try { if (processData.renamedPath && fs.existsSync(processData.renamedPath)) fs.unlinkSync(processData.renamedPath); } catch {}
      }
      const m = await client.sendMessage(chatId, {
        message: t("processCancelledHint", lang),
        buttons: MAIN_KB(lang),
      });
      autoDelete(client, chatId, m.id, 60 * 1000);
      clearUserState(key);
      return;
    }

    if (data === "cancel") {
      if (state && (state.stage === "awaiting_name" || state.stage === "confirming")) {
        if (state.promptMsgId) await del(client, chatId, [state.promptMsgId]);
        if (state.confirmMsgId) await del(client, chatId, [state.confirmMsgId]);
      }
      clearUserState(key);
      await client.sendMessage(chatId, {
        message: t("cancelled", lang),
        parseMode: "html",
        buttons: MAIN_KB(lang),
      });
      return;
    }

    if (data === "another") {
      setUserState(key, { stage: "idle", pendingFiles: [] });
      await client.sendMessage(chatId, {
        message: t("welcome", lang),
        parseMode: "html",
        buttons: MAIN_KB(lang),
      });
      return;
    }

    if (data.startsWith("approve_")) {
      if (!isAdmin) return;
      const targetId = normalizeId(data.replace("approve_", ""));
      await doApprove(client, targetId);
      await client.sendMessage(ADMIN_ID, { message: "✅ Approved " + targetId });
      return;
    }

    if (data.startsWith("reject_")) {
      if (!isAdmin) return;
      const targetId = normalizeId(data.replace("reject_", ""));
      const target = store.getUser(targetId, ADMIN_ID);
      target.status = "banned";
      store.saveUser(target);
      await client.sendMessage(targetId, {
        message: t("rejected", target.lang || "fa"),
      }).catch(() => {});
      await client.sendMessage(ADMIN_ID, { message: "❌ Rejected " + targetId });
      return;
    }

    if (data.startsWith("confirm_")) {
      if (!state || state.stage !== "confirming" || !state.items) return;
      const token = data.replace("confirm_", "");
      if (state.confirmToken && state.confirmToken !== token) return;

      await del(client, chatId, [state.confirmMsgId]);

      // Ask which category/folder to file these under before processing.
      const categories = store.listCategories(chatId);
      const catToken = token;
      const askMsg = await client.sendMessage(chatId, {
        message: t("askCategory", lang),
        buttons: CATEGORY_PICK_KB(lang, categories, catToken),
      });
      setUserState(key, {
        stage: "picking_category",
        items: state.items,
        askCategoryMsgId: askMsg.id,
        catToken,
      });
      return;
    }

    if (data.startsWith("catnone_")) {
      if (!state || state.stage !== "picking_category" || !state.items) return;
      await del(client, chatId, [state.askCategoryMsgId]);
      await startProcessing(client, chatId, key, lang, state.items.map(it => ({ ...it, categoryId: null })));
      return;
    }

    if (data.startsWith("catnew_")) {
      if (!state || state.stage !== "picking_category" || !state.items) return;
      await del(client, chatId, [state.askCategoryMsgId]);
      const prompt = await client.sendMessage(chatId, {
        message: t("enterCategoryName", lang),
        buttons: CANCEL_KB(lang),
      });
      setUserState(key, {
        stage: "awaiting_category_name",
        items: state.items,
        promptMsgId: prompt.id,
      });
      return;
    }

    if (data.startsWith("cat_")) {
      if (!state || state.stage !== "picking_category" || !state.items) return;
      const rest = data.replace("cat_", "");
      const catId = parseInt(rest.slice(rest.lastIndexOf("_") + 1), 10);
      await del(client, chatId, [state.askCategoryMsgId]);
      await startProcessing(client, chatId, key, lang, state.items.map(it => ({ ...it, categoryId: catId })));
      return;
    }
  }, new CallbackQuery({}));

  await client.sendMessage(ADMIN_ID, {
    message:
      "<b>Bot online.</b>\n" +
      "Username: @" + escapeHtml(BOT_USERNAME) + "\n" +
      "Data dir: " + escapeHtml(DATA_DIR) + "\n" +
      "Queue concurrency: " + QUEUE_CONCURRENCY + "\n\n" +
      "Admin commands:\n" +
      "/stats\n/ping\n/pending\n" +
      "/approve [id]\n/reject [id]\n" +
      "/ban [id]\n/unban [id]\n/banlist\n" +
      "/premium [id] [days] [GB]\n" +
      "/broadcast [text]\n/users\n" +
      "/setlimit [GB]\n/cleanup\n/export",
    parseMode: "html",
  }).catch(err => {
    console.error("Admin notify failed:", err.message);
  });

  console.log("Bot is fully ready!");
}

console.log("Starting bot...");
startBot()
  .then(() => {
    console.log("Bot running");
    setInterval(() => {}, 10000);
    process.stdin.resume();
    process.on("SIGINT", () => { process.exit(0); });
    process.on("SIGTERM", () => { process.exit(0); });
  })
  .catch(err => {
    console.error("Fatal:", err);
    process.exit(1);
  });
