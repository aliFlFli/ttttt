import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { NewMessage } from "telegram/events/index.js";
import { CallbackQuery } from "telegram/events/CallbackQuery.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { logger } from "./lib/logger.js";

const API_ID    = parseInt(process.env["TELEGRAM_API_ID"]  ?? "0", 10);
const API_HASH  = process.env["TELEGRAM_API_HASH"]  ?? "";
const BOT_TOKEN = process.env["TELEGRAM_BOT_TOKEN"] ?? "";
const ADMIN_ID  = 155824019n;
const SESSION_FILE = path.join(os.tmpdir(), "tg_gramjs_session.txt");
const STATS_FILE = path.join(os.tmpdir(), "stats.json");
const BANNED_FILE = path.join(os.tmpdir(), "banned.json");
const CONFIG_FILE = path.join(os.tmpdir(), "bot_config.json");

let botConfig = loadConfig();
function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
  } catch {
    return { maxFileSize: 2 * 1024 * 1024 * 1024 };
  }
}
function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(botConfig, null, 2));
  } catch {}
}

let stats = loadStats();
let bannedUsers = loadBanned();
const startTime = Date.now();

function loadStats() {
  try {
    return JSON.parse(fs.readFileSync(STATS_FILE, "utf-8"));
  } catch {
    return { total: 0, totalBytes: 0, users: {}, today: 0, week: 0 };
  }
}
function saveStats() {
  try {
    fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));
  } catch {}
}
function loadBanned() {
  try {
    return JSON.parse(fs.readFileSync(BANNED_FILE, "utf-8"));
  } catch {
    return [];
  }
}
function saveBanned() {
  try {
    fs.writeFileSync(BANNED_FILE, JSON.stringify(bannedUsers, null, 2));
  } catch {}
}

function updateUserStats(userId) {
  const today = new Date().toDateString();
  const now = Date.now();
  if (!stats.users[userId]) {
    stats.users[userId] = { lastSeen: today, count: 0, firstSeen: now };
  }
  if (stats.users[userId].lastSeen !== today) {
    stats.users[userId].lastSeen = today;
    stats.today = (stats.today || 0) + 1;
  }
  stats.users[userId].count++;
  const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
  stats.week = Object.values(stats.users).filter(function (u) {
    return (u.firstSeen || now) > weekAgo || u.lastSeen === today;
  }).length;
  saveStats();
}

function getUptime() {
  const diff = Date.now() - startTime;
  const days = Math.floor(diff / 86400000);
  const hours = Math.floor((diff % 86400000) / 3600000);
  return days + " روز " + hours + " ساعت";
}

const userLang = new Map();

const T = {
  fa: {
    welcome: "🎬 <b>ربات تغییر نام فایل</b>\nفایل ویدیویی خود را ارسال کنید.\n📦 پشتیبانی تا <b>۲ گیگابایت</b> — بدون محدودیت!\n\n💡 چند فایل بفرستید و بعد لیست نام‌ها را خط‌به‌خط ارسال کنید.",
    help: "📖 <b>راهنما</b>\n\n۱. یک یا چند فایل Document بفرستید\n۲. نام جدید را تایپ کنید (برای چند فایل: هر نام در یک خط)\n۳. تأیید کنید و فایل را دریافت کنید ✅\n\n💡 اگر پسوند ننویسید، پسوند اصلی حفظ می‌شود.\n🌐 زبان: /lang fa یا /lang en",
    about: function () {
      return "ℹ️ <b>درباره ربات</b>\n⚡ پروتکل: MTProto\n📦 حداکثر: " + fmtSize(botConfig.maxFileSize) + "\n🔒 فایل‌ها بعد از ارسال حذف می‌شوند\n🟢 آپتایم: " + getUptime();
    },
    sendFileFirst: "⚠️ ابتدا یک فایل ارسال کنید.",
    banned: "🚫 شما توسط ادمین مسدود شده‌اید.",
    cancelled: "❌ لغو شد. فایل جدیدی ارسال کنید:",
    processCancelled: "⛔ پردازش لغو شد.",
    processCancelledHint: "❌ پردازش لغو شد. فایل جدیدی ارسال کنید.",
    enterName: "✏️ نام جدید را ارسال کنید:",
    enterNamesBatch: "✏️ نام‌های جدید را خط‌به‌خط ارسال کنید (",
    preview: "📝 <b>پیش‌نمایش نام جدید</b>\n\n",
    previewBatch: "📝 <b>پیش‌نمایش نام‌های جدید</b>\n\n",
    currentName: "نام فعلی:\n",
    newName: "نام جدید:\n",
    downloading: "⬇️ <b>در حال دانلود...</b>",
    uploading: "⬆️ <b>در حال آپلود...</b>",
    downloadDone: "✅ دانلود کامل شد",
    done: "✅ <b>کامل شد!</b>",
    errorProcess: "❌ خطا در پردازش فایل. دوباره امتحان کنید.",
    langSet: "✅ زبان روی فارسی تنظیم شد.",
    langSetEn: "✅ Language set to English.",
    tooBig: "⚠️ حجم فایل بیشتر از حد مجاز است.",
    online: "🟢 ربات آنلاین است.",
  },
  en: {
    welcome: "🎬 <b>File Rename Bot</b>\nSend your video file.\n📦 Up to <b>2 GB</b> — no Bot API limit!\n\n💡 Send multiple files, then send new names (one per line).",
    help: "📖 <b>Help</b>\n\n1. Send one or more Document files\n2. Type the new name (for multiple: one name per line)\n3. Confirm and receive the file ✅\n\n💡 Extension is kept if you omit it.\n🌐 Language: /lang fa or /lang en",
    about: function () {
      return "ℹ️ <b>About</b>\n⚡ Protocol: MTProto\n📦 Max size: " + fmtSize(botConfig.maxFileSize) + "\n🔒 Files are deleted after sending\n🟢 Uptime: " + getUptime();
    },
    sendFileFirst: "⚠️ Please send a file first.",
    banned: "🚫 You have been banned by the admin.",
    cancelled: "❌ Cancelled. Send a new file:",
    processCancelled: "⛔ Process cancelled.",
    processCancelledHint: "❌ Process cancelled. Send a new file.",
    enterName: "✏️ Send the new name:",
    enterNamesBatch: "✏️ Send new names, one per line (",
    preview: "📝 <b>Name preview</b>\n\n",
    previewBatch: "📝 <b>Names preview</b>\n\n",
    currentName: "Current:\n",
    newName: "New:\n",
    downloading: "⬇️ <b>Downloading...</b>",
    uploading: "⬆️ <b>Uploading...</b>",
    downloadDone: "✅ Download complete",
    done: "✅ <b>Done!</b>",
    errorProcess: "❌ Error processing file. Try again.",
    langSet: "✅ Language set to فارسی.",
    langSetEn: "✅ Language set to English.",
    tooBig: "⚠️ File is larger than the allowed limit.",
    online: "🟢 Bot is online.",
  },
};

function t(key, lang) {
  const L = T[lang] || T.fa;
  const v = L[key];
  return typeof v === "function" ? v() : v;
}

function getLang(key) {
  return userLang.get(key) || "fa";
}

function bar(pct) {
  const filled = Math.min(10, Math.round(pct / 10));
  return "█".repeat(filled) + "░".repeat(10 - filled);
}
function fmtSize(bytes) {
  if (bytes >= 1e9) return (bytes / 1e9).toFixed(2) + " GB";
  if (bytes >= 1e6) return (bytes / 1e6).toFixed(1) + " MB";
  if (bytes >= 1e3) return (bytes / 1e3).toFixed(1) + " KB";
  return bytes + " B";
}
function fmtSpeed(bytesPerSec) {
  if (bytesPerSec >= 1e9) return (bytesPerSec / 1e9).toFixed(1) + " GB/s";
  if (bytesPerSec >= 1e6) return (bytesPerSec / 1e6).toFixed(1) + " MB/s";
  if (bytesPerSec >= 1e3) return (bytesPerSec / 1e3).toFixed(1) + " KB/s";
  return Math.round(bytesPerSec) + " B/s";
}
function getExtension(filename) {
  const parts = filename.split(".");
  return parts.length > 1 ? parts.pop() : "";
}

function buildDownloadMsg(fileName, pct, totalBytes, speed, eta, lang) {
  const done = Math.floor((totalBytes * pct) / 100);
  let msg = t("downloading", lang) + "\n\n";
  msg += bar(pct) + "  <b>" + pct + "%</b>\n";
  msg += "💾 " + fmtSize(done) + " / " + fmtSize(totalBytes) + "\n";
  if (speed) msg += "⚡ " + fmtSpeed(speed) + "\n";
  if (eta) msg += "⏱ " + eta + "\n";
  msg += "📄 <code>" + fileName + "</code>";
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
  msg += "📄 <code>" + fileName + "</code>";
  return msg;
}

async function del(client, chatId, ids, delay) {
  if (!ids || !ids.length) return;
  if (delay) {
    setTimeout(function () {
      client.deleteMessages(chatId, ids, { revoke: true }).catch(function () {});
    }, delay);
  } else {
    await client.deleteMessages(chatId, ids, { revoke: true }).catch(function () {});
  }
}

function autoDelete(client, chatId, msgId, ms) {
  if (!msgId) return;
  setTimeout(function () {
    client.deleteMessages(chatId, [msgId], { revoke: true }).catch(function () {});
  }, ms || 5 * 60 * 1000);
}

async function notifyAdminError(client, err, context) {
  try {
    const text =
      "⚠️ <b>Bot Error</b>\n" +
      "📍 " + (context || "-") + "\n" +
      "<code>" + String(err && err.message ? err.message : err).slice(0, 800) + "</code>";
    await client.sendMessage(ADMIN_ID, { message: text, parseMode: "html" });
  } catch {}
  logger.error({ err: err, context: context }, "Bot error");
}

function makeButton(text, data) {
  return new Api.KeyboardButtonCallback({
    text: text,
    data: Buffer.from(String(data)),
  });
}

const userState = new Map();
const processingFiles = new Map();
const abortFlags = new Map();

function k(id) {
  return String(id);
}

const STATE_TIMEOUT_MS = 15 * 60 * 1000;

function setUserState(key, data) {
  const prev = userState.get(key);
  if (prev && prev.timeoutId) clearTimeout(prev.timeoutId);
  const timeoutId = setTimeout(function () {
    userState.delete(key);
  }, STATE_TIMEOUT_MS);
  userState.set(key, Object.assign({}, data, { timeoutId: timeoutId }));
}
function clearUserState(key) {
  const state = userState.get(key);
  if (state && state.timeoutId) clearTimeout(state.timeoutId);
  userState.delete(key);
  abortFlags.delete(key);
}

function MAIN_KB(lang) {
  return [[
    makeButton(lang === "en" ? "📖 Help" : "📖 راهنما", "help"),
    makeButton(lang === "en" ? "ℹ️ About" : "ℹ️ درباره", "about"),
  ]];
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

async function processOneFile(client, chatId, key, lang, item, statusMsgId) {
  const newFileName = item.newName;
  const messageId = item.messageId;
  const fileSize = item.fileSize;

  const tmpPath = path.join(os.tmpdir(), "tg_dl_" + Date.now() + "_" + Math.random().toString(36).slice(2));
  const renamedPath = path.join(os.tmpdir(), newFileName);

  abortFlags.set(key, false);
  processingFiles.set(key, {
    statusMsgId: statusMsgId,
    cancelled: false,
    tmpPath: tmpPath,
    renamedPath: renamedPath,
  });

  let lastProgressUpdate = 0;
  let lastBytes = 0;
  let lastTime = Date.now();

  function isCancelled() {
    return abortFlags.get(key) === true ||
      (processingFiles.get(key) && processingFiles.get(key).cancelled);
  }

  try {
    const messages = await client.getMessages(chatId, { ids: [messageId] });
    const origMsg = messages[0];
    if (!origMsg || !origMsg.media) throw new Error("Media not found");

    await client.editMessage(chatId, {
      message: statusMsgId,
      text: buildDownloadMsg(newFileName, 0, fileSize, 0, "", lang),
      parseMode: "html",
      buttons: CANCEL_PROCESS_KB(lang),
    }).catch(function () {});

    await client.downloadMedia(origMsg.media, {
      outputFile: tmpPath,
      progressCallback: async function (downloaded, total) {
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
        }).catch(function () {});
      },
    });

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
    }).catch(function () {});

    await client.sendFile(chatId, {
      file: renamedPath,
      caption:
        t("done", lang) + "\n" +
        "📄 <code>" + newFileName + "</code>\n" +
        "💾 " + fmtSize(fileSize),
      parseMode: "html",
      forceDocument: true,
      attributes: [new Api.DocumentAttributeFilename({ fileName: newFileName })],
      progressCallback: async function (progress) {
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
        }).catch(function () {});
      },
    });

    stats.total++;
    stats.totalBytes += fileSize;
    saveStats();

    if (chatId !== ADMIN_ID) {
      await client.sendMessage(ADMIN_ID, {
        message:
          "🔔 <b>File processed</b>\n" +
          "👤 <code>" + chatId + "</code>\n" +
          "📄 <code>" + newFileName + "</code>\n" +
          "💾 " + fmtSize(fileSize),
        parseMode: "html",
      }).catch(function () {});
    }

    return true;
  } catch (err) {
    if (err.message === "Cancelled by user") {
      return false;
    }
    await notifyAdminError(client, err, "processOneFile:" + newFileName);
    throw err;
  } finally {
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch {}
    try { if (fs.existsSync(renamedPath)) fs.unlinkSync(renamedPath); } catch {}
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
  try {
    sessionStr = fs.readFileSync(SESSION_FILE, "utf-8").trim();
  } catch {}

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
    fs.writeFileSync(SESSION_FILE, client.session.save(), "utf-8");
  } catch {}

  logger.info("Telegram bot started");

  client.addEventHandler(async function (event) {
    const msg = event.message;
    if (!msg || !msg.isPrivate) return;

    const chatId = msg.chatId;
    const key = k(chatId);
    const text = msg.message || "";
    const isAdmin = chatId === ADMIN_ID;
    const lang = getLang(key);

    if (bannedUsers.includes(Number(chatId)) && !isAdmin) {
      await client.sendMessage(chatId, { message: t("banned", lang) });
      return;
    }

    updateUserStats(Number(chatId));

    if (text.startsWith("/lang")) {
      const parts = text.trim().split(/\s+/);
      const code = (parts[1] || "").toLowerCase();
      if (code === "en") {
        userLang.set(key, "en");
        await client.sendMessage(chatId, { message: t("langSetEn", "en"), buttons: MAIN_KB("en") });
      } else {
        userLang.set(key, "fa");
        await client.sendMessage(chatId, { message: t("langSet", "fa"), buttons: MAIN_KB("fa") });
      }
      return;
    }

    if (isAdmin) {
      if (text.startsWith("/ban ")) {
        const userId = parseInt(text.split(" ")[1]);
        if (userId && !bannedUsers.includes(userId)) {
          bannedUsers.push(userId);
          saveBanned();
          await client.sendMessage(chatId, { message: "User " + userId + " banned." });
        }
        return;
      }
      if (text.startsWith("/unban ")) {
        const userId = parseInt(text.split(" ")[1]);
        if (userId) {
          bannedUsers = bannedUsers.filter(function (id) { return id !== userId; });
          saveBanned();
          await client.sendMessage(chatId, { message: "User " + userId + " unbanned." });
        }
        return;
      }
      if (text === "/banlist") {
        const list = bannedUsers.length
          ? bannedUsers.map(function (id) { return "• <code>" + id + "</code>"; }).join("\n")
          : "Empty.";
        await client.sendMessage(chatId, { message: "<b>Banned</b>\n\n" + list, parseMode: "html" });
        return;
      }
      if (text === "/stats") {
        const totalUsers = Object.keys(stats.users).length;
        await client.sendMessage(chatId, {
          message:
            "<b>Stats</b>\n\n" +
            "Files: <b>" + stats.total + "</b>\n" +
            "Size: <b>" + fmtSize(stats.totalBytes) + "</b>\n" +
            "Today: <b>" + (stats.today || 0) + "</b>\n" +
            "Week: <b>" + (stats.week || 0) + "</b>\n" +
            "Users: <b>" + totalUsers + "</b>\n" +
            "Uptime: <b>" + getUptime() + "</b>\n" +
            "Banned: <b>" + bannedUsers.length + "</b>\n" +
            "Max size: <b>" + fmtSize(botConfig.maxFileSize) + "</b>",
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
        const ids = Object.keys(stats.users);
        let ok = 0, fail = 0;
        await client.sendMessage(chatId, { message: "Sending to " + ids.length + " users..." });
        for (let i = 0; i < ids.length; i++) {
          try {
            await client.sendMessage(ids[i], { message: body, parseMode: "html" });
            ok++;
          } catch {
            fail++;
          }
          await new Promise(function (r) { setTimeout(r, 50); });
        }
        await client.sendMessage(chatId, { message: "OK: " + ok + " | Fail: " + fail });
        return;
      }
      if (text === "/users") {
        const entries = Object.entries(stats.users)
          .sort(function (a, b) { return (b[1].count || 0) - (a[1].count || 0); })
          .slice(0, 20);
        let msg = "<b>Top users</b>\n\n";
        entries.forEach(function (pair, idx) {
          msg += (idx + 1) + ". <code>" + pair[0] + "</code> — " + (pair[1].count || 0) + "\n";
        });
        await client.sendMessage(chatId, { message: msg, parseMode: "html" });
        return;
      }
      if (text.startsWith("/setlimit ")) {
        const gb = parseFloat(text.split(" ")[1]);
        if (!gb || gb <= 0) {
          await client.sendMessage(chatId, { message: "Example: /setlimit 2" });
          return;
        }
        botConfig.maxFileSize = Math.floor(gb * 1024 * 1024 * 1024);
        saveConfig();
        await client.sendMessage(chatId, { message: "Max size: " + fmtSize(botConfig.maxFileSize) });
        return;
      }
      if (text === "/cleanup") {
        let cleaned = 0;
        userState.forEach(function (_, ukey) {
          clearUserState(ukey);
          cleaned++;
        });
        processingFiles.clear();
        abortFlags.clear();
        try {
          const files = fs.readdirSync(os.tmpdir());
          files.forEach(function (f) {
            if (f.indexOf("tg_dl_") === 0) {
              try { fs.unlinkSync(path.join(os.tmpdir(), f)); cleaned++; } catch {}
            }
          });
        } catch {}
        await client.sendMessage(chatId, { message: "Cleanup done. Items: " + cleaned });
        return;
      }
    }

    if (text.startsWith("/start")) {
      setUserState(key, { stage: "idle", pendingFiles: [] });
      await client.sendMessage(chatId, {
        message: t("welcome", lang),
        parseMode: "html",
        buttons: MAIN_KB(lang),
      });
      return;
    }

    let doc = msg.document;
    if (!doc && msg.media instanceof Api.MessageMediaDocument) {
      doc = msg.media.document;
    }

    if (doc) {
      const fnAttr = doc.attributes && doc.attributes.find(function (a) {
        return a instanceof Api.DocumentAttributeFilename;
      });
      const originalName = (fnAttr && fnAttr.fileName) || ("file_" + msg.id);
      const fileSize = Number(doc.size || 0);

      if (fileSize > botConfig.maxFileSize) {
        const m = await client.sendMessage(chatId, { message: t("tooBig", lang) });
        autoDelete(client, chatId, m.id, 15000);
        return;
      }

      let state = userState.get(key) || { stage: "idle", pendingFiles: [] };
      if (!state.pendingFiles) state.pendingFiles = [];

      if (state.promptMsgId) await del(client, chatId, [state.promptMsgId]);
      if (state.confirmMsgId) await del(client, chatId, [state.confirmMsgId]);

      state.pendingFiles.push({
        messageId: msg.id,
        originalName: originalName,
        fileSize: fileSize,
      });

      const count = state.pendingFiles.length;
      const prompt = await client.sendMessage(chatId, {
        message:
          "📦 <b>" + originalName + "</b>\n" +
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
      if (!state || state.stage !== "awaiting_name" || !state.pendingFiles || !state.pendingFiles.length) {
        const tip = await client.sendMessage(chatId, {
          message: t("sendFileFirst", lang),
          buttons: [[makeButton(lang === "en" ? "📖 Help" : "📖 راهنما", "help")]],
        });
        autoDelete(client, chatId, tip.id, 4000);
        autoDelete(client, chatId, msg.id, 4000);
        return;
      }

      const lines = text.split("\n").map(function (l) { return l.trim(); }).filter(Boolean);
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

      const items = files.map(function (f, i) {
        let newName = lines[i];
        const ext = getExtension(f.originalName);
        if (ext && newName.indexOf(".") === -1) newName = newName + "." + ext;
        return {
          messageId: f.messageId,
          originalName: f.originalName,
          fileSize: f.fileSize,
          newName: newName,
        };
      });

      await del(client, chatId, [msg.id, state.promptMsgId]);

      let previewText = (items.length > 1 ? t("previewBatch", lang) : t("preview", lang));
      items.forEach(function (it, idx) {
        if (items.length > 1) previewText += "<b>#" + (idx + 1) + "</b>\n";
        previewText += t("currentName", lang) + "<code>" + it.originalName + "</code>\n";
        previewText += t("newName", lang) + "<code>" + it.newName + "</code>\n\n";
      });

      const token = "b" + Date.now().toString(36);
      const confirmMsg = await client.sendMessage(chatId, {
        message: previewText,
        parseMode: "html",
        buttons: CONFIRM_KB(token, lang),
      });

      setUserState(key, {
        stage: "confirming",
        items: items,
        confirmToken: token,
        confirmMsgId: confirmMsg.id,
      });
      return;
    }
  }, new NewMessage({}));

  client.addEventHandler(async function (event) {
    const data = (event.data && event.data.toString()) || "";
    const chatId = event.query.userId;
    const key = k(chatId);
    const state = userState.get(key);
    const lang = getLang(key);

    await event.answer().catch(function () {});

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
      const m = await client.sendMessage(chatId, {
        message: t("about", lang),
        parseMode: "html",
        buttons: BACK_KB(lang),
      });
      autoDelete(client, chatId, m.id, 10 * 60 * 1000);
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
        const pendingFiles = state.items.map(function (it) {
          return {
            messageId: it.messageId,
            originalName: it.originalName,
            fileSize: it.fileSize,
          };
        });
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
          pendingFiles: pendingFiles,
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
        }).catch(function () {});
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

    if (data.startsWith("confirm_")) {
      if (!state || state.stage !== "confirming" || !state.items) return;
      const token = data.replace("confirm_", "");
      if (state.confirmToken && state.confirmToken !== token) return;

      await del(client, chatId, [state.confirmMsgId]);
      setUserState(key, { stage: "processing", items: state.items });

      const statusMsg = await client.sendMessage(chatId, {
        message: buildDownloadMsg(state.items[0].newName, 0, state.items[0].fileSize, 0, "", lang),
        parseMode: "html",
        buttons: CANCEL_PROCESS_KB(lang),
      });

      try {
        for (let i = 0; i < state.items.length; i++) {
          if (abortFlags.get(key)) break;
          const item = state.items[i];
          if (state.items.length > 1) {
            await client.editMessage(chatId, {
              message: statusMsg.id,
              text:
                (lang === "en" ? "📦 File " : "📦 ") +
                (i + 1) + "/" + state.items.length + "\n" +
                buildDownloadMsg(item.newName, 0, item.fileSize, 0, "", lang),
              parseMode: "html",
              buttons: CANCEL_PROCESS_KB(lang),
            }).catch(function () {});
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
        }).catch(function () {});
        await notifyAdminError(client, err, "confirm batch");
        autoDelete(client, chatId, statusMsg.id, 60 * 1000);
      }

      clearUserState(key);
    }
  }, new CallbackQuery({}));

  await client.sendMessage(ADMIN_ID, {
    message:
      "<b>Bot online.</b>\n\n" +
      "Admin commands:\n" +
      "/stats\n/ping\n/ban [id]\n/unban [id]\n/banlist\n" +
      "/broadcast [text]\n/users\n/setlimit [GB]\n/cleanup",
    parseMode: "html",
  }).catch(function (err) {
    console.error("Admin notify failed:", err.message);
  });

  console.log("Bot is fully ready!");
}

console.log("Starting bot...");
startBot()
  .then(function () {
    console.log("Bot running");
    setInterval(function () {}, 10000);
    process.stdin.resume();
    process.on("SIGINT", function () { saveStats(); process.exit(0); });
    process.on("SIGTERM", function () { saveStats(); process.exit(0); });
  })
  .catch(function (err) {
    console.error("Fatal:", err);
    process.exit(1);
  });
