import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { NewMessage } from "telegram/events/index.js";
import { CallbackQuery } from "telegram/events/CallbackQuery.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { logger } from "./lib/logger.js";

// ─── Config ─────────────────────────────────────────────────────────────────

const API_ID    = parseInt(process.env["TELEGRAM_API_ID"]  ?? "0", 10);
const API_HASH  = process.env["TELEGRAM_API_HASH"]  ?? "";
const BOT_TOKEN = process.env["TELEGRAM_BOT_TOKEN"] ?? "";
const ADMIN_ID  = 155824019n;
const SESSION_FILE = path.join(os.tmpdir(), "tg_gramjs_session.txt");
const STATS_FILE = path.join(os.tmpdir(), "stats.json");
const BANNED_FILE = path.join(os.tmpdir(), "banned.json");

// ─── Stats ───────────────────────────────────────────────────────────────────

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

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

function buildDownloadMsg(fileName, pct, totalBytes, speed, eta) {
  const done = Math.floor((totalBytes * pct) / 100);
  let msg = "⬇️ <b>در حال دانلود...</b>\n\n";
  msg += bar(pct) + "  <b>" + pct + "%</b>\n";
  msg += "💾 " + fmtSize(done) + " / " + fmtSize(totalBytes) + "\n";
  if (speed) msg += "⚡ " + fmtSpeed(speed) + "\n";
  if (eta) msg += "⏱ باقی مانده: " + eta + "\n";
  msg += "📄 <code>" + fileName + "</code>";
  return msg;
}

function buildUploadMsg(fileName, pct, totalBytes, speed, eta) {
  const done = Math.floor((totalBytes * pct) / 100);
  let msg = "✅ دانلود کامل شد\n";
  msg += "⬆️ <b>در حال آپلود...</b>\n\n";
  msg += bar(pct) + "  <b>" + pct + "%</b>\n";
  msg += "💾 " + fmtSize(done) + " / " + fmtSize(totalBytes) + "\n";
  if (speed) msg += "⚡ " + fmtSpeed(speed) + "\n";
  if (eta) msg += "⏱ باقی مانده: " + eta + "\n";
  msg += "📄 <code>" + fileName + "</code>";
  return msg;
}

async function del(client, chatId, ids, delay) {
  if (delay) {
    setTimeout(function () {
      client.deleteMessages(chatId, ids, { revoke: true }).catch(function () {});
    }, delay);
  } else {
    await client.deleteMessages(chatId, ids, { revoke: true }).catch(function () {});
  }
}

// ─── Button helper ───────────────────────────────────────────────────────────

function makeButton(text, data) {
  return new Api.KeyboardButtonCallback({
    text: text,
    data: Buffer.from(String(data)),
  });
}

// ─── State ───────────────────────────────────────────────────────────────────

const userState = new Map();
const processingFiles = new Map();

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
}

// ─── Keyboards ───────────────────────────────────────────────────────────────

const MAIN_KB = [[
  makeButton("📖 راهنما", "help"),
  makeButton("ℹ️ درباره", "about"),
]];

const CANCEL_KB = [[
  makeButton("❌ لغو", "cancel"),
]];

const DONE_KB = [[
  makeButton("🔄 فایل دیگه", "another"),
]];

const BACK_KB = [[
  makeButton("🔙 بازگشت", "back_start"),
]];

function CONFIRM_KB(newName) {
  return [[
    makeButton("✅ تایید", "confirm_" + newName),
    makeButton("✏️ ویرایش", "edit"),
    makeButton("❌ لغو", "cancel"),
  ]];
}

const CANCEL_PROCESS_KB = [[
  makeButton("⛔ لغو پردازش", "cancel_process"),
]];

// ─── Messages ────────────────────────────────────────────────────────────────

const WELCOME =
  "🎬 <b>ربات تغییر نام فایل</b>\n" +
  "فایل ویدیویی خود را ارسال کنید.\n" +
  "📦 پشتیبانی تا <b>۲ گیگابایت</b> — بدون محدودیت!";

const HELP =
  "📖 <b>راهنما</b>\n\n" +
  "۱. فایل را به صورت <b>Document</b> ارسال کنید\n" +
  "۲. نام جدید را تایپ کنید\n" +
  "۳. فایل با نام جدید دریافت کنید ✅\n\n" +
  "💡 <b>نکات:</b>\n" +
  "• اگر فقط نام بدون پسوند بنویسید، پسوند فایل حفظ می‌شود\n" +
  "• مثال: <code>Avatar</code> → <code>Avatar.mkv</code>\n" +
  "• مثال: <code>Movie.2026.720p.x265.mkv</code> → نام کامل";

function getAbout() {
  return (
    "ℹ️ <b>درباره ربات</b>\n" +
    "⚡ پروتکل: MTProto — بدون محدودیت ۲۰MB\n" +
    "📦 حداکثر: ۲ گیگابایت (۴GB برای پرمیوم)\n" +
    "🔒 فایل‌ها بلافاصله بعد از ارسال حذف می‌شن\n" +
    "🟢 آپتایم: " + getUptime()
  );
}

// ─── Bot ─────────────────────────────────────────────────────────────────────

export async function startBot() {
  console.log("🔵 startBot() called");

  if (!API_ID || !API_HASH || !BOT_TOKEN) {
    console.error("❌ Missing credentials!");
    logger.warn("Missing Telegram credentials — bot not started");
    return;
  }

  let sessionStr = "";
  try {
    sessionStr = fs.readFileSync(SESSION_FILE, "utf-8").trim();
    console.log("📂 Session loaded");
  } catch {
    console.log("📝 No existing session");
  }

  const client = new TelegramClient(
    new StringSession(sessionStr),
    API_ID,
    API_HASH,
    { connectionRetries: 5 }
  );

  console.log("🔄 Connecting...");
  await client.start({ botAuthToken: BOT_TOKEN });
  console.log("✅ Bot started");

  try {
    fs.writeFileSync(SESSION_FILE, client.session.save(), "utf-8");
  } catch {}

  logger.info("Telegram bot started (GramJS)");

  // ── Message handler ───────────────────────────────────────────────────────

  client.addEventHandler(async function (event) {
    const msg = event.message;
    if (!msg || !msg.isPrivate) return;

    const chatId = msg.chatId;
    const key = k(chatId);
    const text = msg.message || "";
    const isAdmin = chatId === ADMIN_ID;

    if (bannedUsers.includes(Number(chatId)) && !isAdmin) {
      await client.sendMessage(chatId, { message: "🚫 شما توسط ادمین مسدود شده‌اید." });
      return;
    }

    updateUserStats(Number(chatId));

    // Admin commands
    if (isAdmin) {
      if (text.startsWith("/ban ")) {
        const userId = parseInt(text.split(" ")[1]);
        if (userId && !bannedUsers.includes(userId)) {
          bannedUsers.push(userId);
          saveBanned();
          await client.sendMessage(chatId, { message: "✅ کاربر " + userId + " مسدود شد." });
        }
        return;
      }
      if (text.startsWith("/unban ")) {
        const userId = parseInt(text.split(" ")[1]);
        if (userId) {
          bannedUsers = bannedUsers.filter(function (id) { return id !== userId; });
          saveBanned();
          await client.sendMessage(chatId, { message: "✅ کاربر " + userId + " آزاد شد." });
        }
        return;
      }
      if (text === "/stats") {
        const totalUsers = Object.keys(stats.users).length;
        await client.sendMessage(chatId, {
          message:
            "📊 <b>آمار ربات</b>\n\n" +
            "✅ فایل‌های پردازش‌شده: <b>" + stats.total + "</b>\n" +
            "💾 حجم کل: <b>" + fmtSize(stats.totalBytes) + "</b>\n" +
            "👥 کاربران امروز: <b>" + (stats.today || 0) + "</b>\n" +
            "👥 کاربران هفته: <b>" + (stats.week || 0) + "</b>\n" +
            "👥 کاربران کل: <b>" + totalUsers + "</b>\n" +
            "🟢 آپتایم: <b>" + getUptime() + "</b>\n" +
            "🚫 کاربران مسدود: <b>" + bannedUsers.length + "</b>",
          parseMode: "html",
        });
        return;
      }
      if (text === "/ping") {
        await client.sendMessage(chatId, { message: "🟢 ربات آنلاین است." });
        return;
      }
    }

    // /start
    if (text.startsWith("/start")) {
      setUserState(key, { stage: "idle" });
      await client.sendMessage(chatId, {
        message: WELCOME,
        parseMode: "html",
        buttons: MAIN_KB,
      });
      return;
    }

    // Document
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

      const state = userState.get(key);
      if (state && state.promptMsgId) await del(client, chatId, [state.promptMsgId]);
      if (state && state.confirmMsgId) await del(client, chatId, [state.confirmMsgId]);

      const prompt = await client.sendMessage(chatId, {
        message:
          "📦 <b>" + originalName + "</b>\n" +
          "💾 " + fmtSize(fileSize) + "\n\n" +
          "✏️ نام جدید را ارسال کنید:",
        parseMode: "html",
        buttons: CANCEL_KB,
      });

      setUserState(key, {
        stage: "awaiting_name",
        messageId: msg.id,
        promptMsgId: prompt.id,
        fileName: originalName,
        fileSize: fileSize,
        originalName: originalName,
      });
      return;
    }

    // Text = new filename
    if (text && !text.startsWith("/")) {
      const state = userState.get(key);

      if (!state || state.stage !== "awaiting_name") {
        const tip = await client.sendMessage(chatId, {
          message: "⚠️ ابتدا یک فایل ارسال کنید.",
          buttons: [[makeButton("📖 راهنما", "help")]],
        });
        setTimeout(function () {
          del(client, chatId, [tip.id, msg.id]);
        }, 4000);
        return;
      }

      let newFileName = text.trim();
      const ext = getExtension(state.originalName);
      if (ext && newFileName.indexOf(".") === -1) {
        newFileName = newFileName + "." + ext;
      }

      await del(client, chatId, [msg.id, state.promptMsgId]);

      const confirmMsg = await client.sendMessage(chatId, {
        message:
          "📝 <b>پیش‌نمایش نام جدید</b>\n\n" +
          "نام فعلی:\n<code>" + state.originalName + "</code>\n\n" +
          "نام جدید:\n<code>" + newFileName + "</code>",
        parseMode: "html",
        buttons: CONFIRM_KB(newFileName),
      });

      setUserState(key, {
        stage: "confirming",
        messageId: state.messageId,
        fileName: state.fileName,
        fileSize: state.fileSize,
        originalName: state.originalName,
        newFileName: newFileName,
        confirmMsgId: confirmMsg.id,
      });
      return;
    }
  }, new NewMessage({}));

  // ── Callback handler ──────────────────────────────────────────────────────

  client.addEventHandler(async function (event) {
    const data = (event.data && event.data.toString()) || "";
    const chatId = event.query.userId;
    const key = k(chatId);
    const state = userState.get(key);

    await event.answer().catch(function () {});

    if (data === "help") {
      await client.sendMessage(chatId, {
        message: HELP,
        parseMode: "html",
        buttons: BACK_KB,
      });
      return;
    }

    if (data === "about") {
      await client.sendMessage(chatId, {
        message: getAbout(),
        parseMode: "html",
        buttons: BACK_KB,
      });
      return;
    }

    if (data === "back_start") {
      setUserState(key, { stage: "idle" });
      await client.sendMessage(chatId, {
        message: WELCOME,
        parseMode: "html",
        buttons: MAIN_KB,
      });
      return;
    }

    if (data === "edit") {
      if (state && state.stage === "confirming") {
        await del(client, chatId, [state.confirmMsgId]);
        const prompt = await client.sendMessage(chatId, {
          message:
            "✏️ نام جدید را ویرایش کنید:\n\n" +
            "نام قبلی: <code>" + state.newFileName + "</code>",
          parseMode: "html",
          buttons: CANCEL_KB,
        });
        setUserState(key, {
          stage: "awaiting_name",
          messageId: state.messageId,
          fileName: state.fileName,
          fileSize: state.fileSize,
          originalName: state.originalName,
          promptMsgId: prompt.id,
        });
      }
      return;
    }

    if (data === "cancel_process") {
      const processData = processingFiles.get(key);
      if (processData) {
        processingFiles.set(key, Object.assign({}, processData, { cancelled: true }));
        await client.editMessage(chatId, {
          message: processData.statusMsgId,
          text: "⛔ پردازش لغو شد.",
        }).catch(function () {});
        await client.sendMessage(chatId, {
          message: "❌ پردازش لغو شد. فایل جدیدی ارسال کنید.",
          buttons: MAIN_KB,
        });
        clearUserState(key);
      }
      return;
    }

    if (data === "cancel") {
      if (state && (state.stage === "awaiting_name" || state.stage === "confirming")) {
        if (state.promptMsgId) await del(client, chatId, [state.promptMsgId]);
        if (state.confirmMsgId) await del(client, chatId, [state.confirmMsgId]);
      }
      clearUserState(key);
      await client.sendMessage(chatId, {
        message: "❌ لغو شد. فایل جدیدی ارسال کنید:",
        parseMode: "html",
        buttons: MAIN_KB,
      });
      return;
    }

    if (data === "another") {
      setUserState(key, { stage: "idle" });
      await client.sendMessage(chatId, {
        message: WELCOME,
        parseMode: "html",
        buttons: MAIN_KB,
      });
      return;
    }

    if (data.startsWith("confirm_")) {
      if (!state || state.stage !== "confirming") return;

      const newFileName = data.replace("confirm_", "");
      const messageId = state.messageId;
      const fileSize = state.fileSize;

      await del(client, chatId, [state.confirmMsgId]);
      setUserState(key, { stage: "processing" });

      const statusMsg = await client.sendMessage(chatId, {
        message: buildDownloadMsg(newFileName, 0, fileSize, 0, ""),
        parseMode: "html",
        buttons: CANCEL_PROCESS_KB,
      });

      const tmpPath = path.join(os.tmpdir(), "tg_dl_" + Date.now() + "_" + Math.random().toString(36).slice(2));
      const renamedPath = path.join(os.tmpdir(), newFileName);

      processingFiles.set(key, {
        statusMsgId: statusMsg.id,
        cancelled: false,
        tmpPath: tmpPath,
        renamedPath: renamedPath,
      });

      let lastProgressUpdate = 0;
      let lastBytes = 0;
      let lastTime = Date.now();

      try {
        const messages = await client.getMessages(chatId, { ids: [messageId] });
        const origMsg = messages[0];
        if (!origMsg || !origMsg.media) throw new Error("Media not found");

        // Download
        await client.downloadMedia(origMsg.media, {
          outputFile: tmpPath,
          progressCallback: async function (downloaded, total) {
            const now = Date.now();
            if (now - lastProgressUpdate < 2000) return;
            lastProgressUpdate = now;

            if (processingFiles.get(key) && processingFiles.get(key).cancelled) {
              throw new Error("Cancelled by user");
            }

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
              const min = Math.floor(remainingSec / 60);
              const sec = remainingSec % 60;
              eta = min + ":" + String(sec).padStart(2, "0");
            }

            await client.editMessage(chatId, {
              message: statusMsg.id,
              text: buildDownloadMsg(newFileName, pct, totalNum, speed, eta),
              parseMode: "html",
              buttons: CANCEL_PROCESS_KB,
            }).catch(function () {});
          },
        });

        if (processingFiles.get(key) && processingFiles.get(key).cancelled) {
          throw new Error("Cancelled by user");
        }

        fs.renameSync(tmpPath, renamedPath);

        // Upload
        lastProgressUpdate = 0;
        lastBytes = 0;
        lastTime = Date.now();

        await client.editMessage(chatId, {
          message: statusMsg.id,
          text: buildUploadMsg(newFileName, 0, fileSize, 0, ""),
          parseMode: "html",
          buttons: CANCEL_PROCESS_KB,
        }).catch(function () {});

        await client.sendFile(chatId, {
          file: renamedPath,
          caption:
            "✅ <b>تغییر نام انجام شد!</b>\n" +
            "📄 <code>" + newFileName + "</code>\n" +
            "💾 " + fmtSize(fileSize),
          parseMode: "html",
          forceDocument: true,
          attributes: [new Api.DocumentAttributeFilename({ fileName: newFileName })],
          progressCallback: async function (progress) {
            const now = Date.now();
            if (now - lastProgressUpdate < 2000) return;
            lastProgressUpdate = now;

            if (processingFiles.get(key) && processingFiles.get(key).cancelled) {
              throw new Error("Cancelled by user");
            }

            const pct = Math.min(99, Math.floor(progress * 100));
            const uploaded = progress * fileSize;

            const elapsed = (now - lastTime) / 1000;
            const speed = elapsed > 0 ? (uploaded - lastBytes) / elapsed : 0;
            lastBytes = uploaded;
            lastTime = now;

            let eta = "";
            if (speed > 0) {
              const remainingSec = Math.ceil((fileSize - uploaded) / speed);
              const min = Math.floor(remainingSec / 60);
              const sec = remainingSec % 60;
              eta = min + ":" + String(sec).padStart(2, "0");
            }

            await client.editMessage(chatId, {
              message: statusMsg.id,
              text: buildUploadMsg(newFileName, pct, fileSize, speed, eta),
              parseMode: "html",
              buttons: CANCEL_PROCESS_KB,
            }).catch(function () {});
          },
        });

        stats.total++;
        stats.totalBytes += fileSize;
        saveStats();

        await del(client, chatId, [statusMsg.id]);

        await client.sendMessage(chatId, {
          message:
            "✅ <b>کامل شد!</b>\n" +
            "📄 <code>" + newFileName + "</code>\n" +
            "💾 " + fmtSize(fileSize),
          parseMode: "html",
          buttons: DONE_KB,
        });

        if (chatId !== ADMIN_ID) {
          await client.sendMessage(ADMIN_ID, {
            message:
              "🔔 <b>فایل جدید پردازش شد</b>\n" +
              "👤 کاربر: <code>" + chatId + "</code>\n" +
              "📄 <code>" + newFileName + "</code>\n" +
              "💾 " + fmtSize(fileSize),
            parseMode: "html",
          }).catch(function () {});
        }

        clearUserState(key);
        processingFiles.delete(key);
      } catch (err) {
        if (err.message !== "Cancelled by user") {
          console.error("❌ Error:", err);
          logger.error({ err: err }, "Error renaming file");
          await client.editMessage(chatId, {
            message: statusMsg.id,
            text: "❌ خطا در پردازش فایل. دوباره امتحان کنید.",
          }).catch(function () {});
        }
        clearUserState(key);
        processingFiles.delete(key);
      } finally {
        try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch {}
        try { if (fs.existsSync(renamedPath)) fs.unlinkSync(renamedPath); } catch {}
        setTimeout(function () {
          del(client, chatId, [statusMsg.id]);
        }, 300000);
      }
    }
  }, new CallbackQuery({}));

  // Notify admin
  await client.sendMessage(ADMIN_ID, {
    message:
      "🟢 <b>ربات آنلاین شد.</b>\n\n" +
      "دستورات ادمین:\n" +
      "/stats — آمار کامل\n" +
      "/ping — وضعیت\n" +
      "/ban [userId] — مسدود کردن\n" +
      "/unban [userId] — آزاد کردن",
    parseMode: "html",
  }).catch(function (err) {
    console.error("⚠️ Could not notify admin:", err.message);
  });

  console.log("🎯 Bot is fully ready!");
}

// ─── Start ───────────────────────────────────────────────────────────────────

console.log("🚀 Starting bot...");
startBot()
  .then(function () {
    console.log("✅ Bot running");
    setInterval(function () {}, 10000);
    process.stdin.resume();

    process.on("SIGINT", function () {
      saveStats();
      process.exit(0);
    });
    process.on("SIGTERM", function () {
      saveStats();
      process.exit(0);
    });
  })
  .catch(function (err) {
    console.error("💥 Fatal error:", err);
    process.exit(1);
  });
