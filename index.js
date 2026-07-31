import { TelegramClient, Api } from "telegram";
import { Button } from "telegram/tl/custom/button.js";
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

  // کاربران فعال ۷ روز اخیر
  const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
  stats.week = Object.values(stats.users).filter((u) => {
    return (u.firstSeen || now) > weekAgo || u.lastSeen === today;
  }).length;

  saveStats();
}

function getUptime() {
  const diff = Date.now() - startTime;
  const days = Math.floor(diff / 86400000);
  const hours = Math.floor((diff % 86400000) / 3600000);
  return `${days} روز ${hours} ساعت`;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function bar(pct) {
  const filled = Math.min(10, Math.round(pct / 10));
  return "█".repeat(filled) + "░".repeat(10 - filled);
}

function fmtSize(bytes) {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(1)} KB`;
  return `${bytes} B`;
}

function fmtSpeed(bytesPerSec) {
  if (bytesPerSec >= 1e9) return `${(bytesPerSec / 1e9).toFixed(1)} GB/s`;
  if (bytesPerSec >= 1e6) return `${(bytesPerSec / 1e6).toFixed(1)} MB/s`;
  if (bytesPerSec >= 1e3) return `${(bytesPerSec / 1e3).toFixed(1)} KB/s`;
  return `${Math.round(bytesPerSec)} B/s`;
}

function getExtension(filename) {
  const ext = filename.split(".").pop();
  return ext === filename ? "" : ext;
}

function buildDownloadMsg(fileName, pct, totalBytes, speed = 0, eta = "") {
  const done = Math.floor((totalBytes * pct) / 100);
  const lines = [
    `⬇️ <b>در حال دانلود...</b>`,
    ``,
    `\( {bar(pct)}  <b> \){pct}%</b>`,
    `💾 ${fmtSize(done)} / ${fmtSize(totalBytes)}`,
  ];

  if (speed > 0) lines.push(`⚡ ${fmtSpeed(speed)}`);
  if (eta) lines.push(`⏱ باقی مانده: ${eta}`);
  lines.push(`📄 <code>${fileName}</code>`);

  return lines.join("\n");
}

function buildUploadMsg(fileName, pct, totalBytes, speed = 0, eta = "") {
  const done = Math.floor((totalBytes * pct) / 100);
  const lines = [
    `✅ دانلود کامل شد`,
    `⬆️ <b>در حال آپلود...</b>`,
    ``,
    `\( {bar(pct)}  <b> \){pct}%</b>`,
    `💾 ${fmtSize(done)} / ${fmtSize(totalBytes)}`,
  ];

  if (speed > 0) lines.push(`⚡ ${fmtSpeed(speed)}`);
  if (eta) lines.push(`⏱ باقی مانده: ${eta}`);
  lines.push(`📄 <code>${fileName}</code>`);

  return lines.join("\n");
}

async function del(client, chatId, ids, delay = 0) {
  if (delay) {
    setTimeout(() => client.deleteMessages(chatId, ids, { revoke: true }).catch(() => {}), delay);
  } else {
    await client.deleteMessages(chatId, ids, { revoke: true }).catch(() => {});
  }
}

// ─── Styled Button Helper ────────────────────────────────────────────────────

function styledButton(text, data, style = null) {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data));

  const btn = new Api.KeyboardButtonCallback({
    text,
    data: payload,
  });

  // فقط اگر نسخه GramJS از KeyboardButtonStyle پشتیبانی کند
  if (style && (style === "primary" || style === "success" || style === "danger")) {
    try {
      if (Api.KeyboardButtonStyle) {
        btn.style = new Api.KeyboardButtonStyle({
          bgPrimary: style === "primary" || undefined,
          bgSuccess: style === "success" || undefined,
          bgDanger:  style === "danger"  || undefined,
        });
      }
    } catch {
      // نسخه‌های قدیمی‌تر → دکمه بدون رنگ
    }
  }

  return btn;
}

// ─── State machine ───────────────────────────────────────────────────────────

const userState = new Map();
const processingFiles = new Map();
const k = (id) => String(id);

const STATE_TIMEOUT_MS = 15 * 60 * 1000; // ۱۵ دقیقه

function setUserState(key, data) {
  const prev = userState.get(key);
  if (prev?.timeoutId) clearTimeout(prev.timeoutId);

  const timeoutId = setTimeout(() => {
    userState.delete(key);
  }, STATE_TIMEOUT_MS);

  userState.set(key, { ...data, timeoutId });
}

function clearUserState(key) {
  const state = userState.get(key);
  if (state?.timeoutId) clearTimeout(state.timeoutId);
  userState.delete(key);
}

// ─── Keyboards ───────────────────────────────────────────────────────────────

const MAIN_KB = [[
  styledButton("📖 راهنما", "help"),
  styledButton("ℹ️ درباره", "about"),
]];

const CANCEL_KB = [[
  styledButton("❌ لغو", "cancel", "danger"),
]];

const DONE_KB = [[
  styledButton("🔄 فایل دیگه", "another", "primary"),
]];

const BACK_KB = [[
  styledButton("🔙 بازگشت", "back_start"),
]];

const CONFIRM_KB = (originalName, newName) => [[
  styledButton("✅ تایید", `confirm_${newName}`, "success"),
  styledButton("✏️ ویرایش", "edit", "primary"),
  styledButton("❌ لغو", "cancel", "danger"),
]];

const CANCEL_PROCESS_KB = [[
  styledButton("⛔ لغو پردازش", "cancel_process", "danger"),
]];

// ─── Static messages ──────────────────────────────────────────────────────────

const WELCOME = `🎬 <b>ربات تغییر نام فایل</b>
فایل ویدیویی خود را ارسال کنید.
📦 پشتیبانی تا <b>۲ گیگابایت</b> — بدون محدودیت!`;

const HELP = `📖 <b>راهنما</b>

۱. فایل را به صورت <b>Document</b> ارسال کنید
۲. نام جدید را تایپ کنید
۳. فایل با نام جدید دریافت کنید ✅

💡 <b>نکات:</b>
• اگر فقط نام بدون پسوند بنویسید، پسوند فایل حفظ می‌شود
• مثال: <code>Avatar</code> → <code>Avatar.mkv</code>
• مثال: <code>Movie.2026.720p.x265.mkv</code> → نام کامل`;

const ABOUT = `ℹ️ <b>درباره ربات</b>
⚡ پروتکل: MTProto — بدون محدودیت ۲۰MB
📦 حداکثر: ۲ گیگابایت (۴GB برای پرمیوم)
🔒 فایل‌ها بلافاصله بعد از ارسال حذف می‌شن
🟢 آپتایم: ${getUptime()}`;

// ─── Bot entry point ─────────────────────────────────────────────────────────

export async function startBot() {
  console.log("🔵 startBot() called - Starting bot initialization...");

  if (!API_ID || !API_HASH || !BOT_TOKEN) {
    console.error("❌ Missing credentials!");
    logger.warn("Missing Telegram credentials — bot not started");
    return;
  }

  console.log("✅ All credentials present. Loading session...");

  let sessionStr = "";
  try {
    sessionStr = fs.readFileSync(SESSION_FILE, "utf-8").trim();
    console.log("📂 Session file loaded successfully");
  } catch {
    console.log("📝 No existing session found, creating new one");
  }

  const client = new TelegramClient(
    new StringSession(sessionStr),
    API_ID,
    API_HASH,
    { connectionRetries: 5 },
  );

  console.log("🔄 Connecting to Telegram...");
  await client.start({ botAuthToken: BOT_TOKEN });
  console.log("✅ Bot started successfully!");

  try {
    const saved = client.session.save();
    fs.writeFileSync(SESSION_FILE, saved, "utf-8");
    console.log("💾 Session saved to file");
  } catch {
    console.log("⚠️ Could not save session (non-fatal)");
  }

  logger.info("Telegram bot started (GramJS MTProto — no size limit)");
  console.log("🤖 Bot is now listening for messages...");

  // ── Message handler ───────────────────────────────────────────────────────

  client.addEventHandler(async (event) => {
    const msg = event.message;
    if (!msg?.isPrivate) return;

    const chatId = msg.chatId;
    const key = k(chatId);
    const text = msg.message ?? "";
    const isAdmin = chatId === ADMIN_ID;

    // Check if user is banned
    if (bannedUsers.includes(Number(chatId)) && !isAdmin) {
      await client.sendMessage(chatId, { message: "🚫 شما توسط ادمین مسدود شده‌اید." });
      return;
    }

    // Update user stats
    updateUserStats(Number(chatId));

    // ── Admin commands ──────────────────────────────────────────────────────
    if (isAdmin) {
      if (text.startsWith("/ban ")) {
        const userId = parseInt(text.split(" ")[1]);
        if (userId) {
          if (!bannedUsers.includes(userId)) {
            bannedUsers.push(userId);
            saveBanned();
            await client.sendMessage(chatId, { message: `✅ کاربر ${userId} مسدود شد.` });
          }
        }
        return;
      }
      if (text.startsWith("/unban ")) {
        const userId = parseInt(text.split(" ")[1]);
        if (userId) {
          bannedUsers = bannedUsers.filter((id) => id !== userId);
          saveBanned();
          await client.sendMessage(chatId, { message: `✅ کاربر ${userId} آزاد شد.` });
        }
        return;
      }
      if (text === "/stats") {
        const totalUsers = Object.keys(stats.users).length;
        await client.sendMessage(chatId, {
          message:
            `📊 <b>آمار ربات</b>\n\n` +
            `✅ فایل‌های پردازش‌شده: <b>${stats.total}</b>\n` +
            `💾 حجم کل: <b>${fmtSize(stats.totalBytes)}</b>\n` +
            `👥 کاربران امروز: <b>${stats.today || 0}</b>\n` +
            `👥 کاربران هفته: <b>${stats.week || 0}</b>\n` +
            `👥 کاربران کل: <b>${totalUsers}</b>\n` +
            `🟢 آپتایم: <b>${getUptime()}</b>\n` +
            `🚫 کاربران مسدود: <b>${bannedUsers.length}</b>`,
          parseMode: "html",
        });
        return;
      }
      if (text === "/ping") {
        await client.sendMessage(chatId, { message: "🟢 ربات آنلاین است." });
        return;
      }
    }

    // ── /start ──────────────────────────────────────────────────────────────
    if (text.startsWith("/start")) {
      setUserState(key, { stage: "idle" });
      await client.sendMessage(chatId, {
        message: WELCOME,
        parseMode: "html",
        buttons: MAIN_KB,
      });
      return;
    }

    // ── Incoming document ──────────────────────────────────────────────────
    let doc =
      msg.document ??
      (msg.media instanceof Api.MessageMediaDocument ? msg.media.document : undefined);

    if (doc) {
      const fnAttr = doc.attributes?.find((a) => a instanceof Api.DocumentAttributeFilename);
      const originalName = fnAttr?.fileName ?? `file_${msg.id}`;
      const fileSize = Number(doc.size ?? 0);

      // Delete old messages
      const state = userState.get(key);
      if (state?.promptMsgId) {
        await del(client, chatId, [state.promptMsgId]);
      }
      if (state?.confirmMsgId) {
        await del(client, chatId, [state.confirmMsgId]);
      }

      const prompt = await client.sendMessage(chatId, {
        message:
          `📦 <b>${originalName}</b>\n` +
          `💾 ${fmtSize(fileSize)}\n\n` +
          `✏️ نام جدید را ارسال کنید:`,
        parseMode: "html",
        buttons: CANCEL_KB,
      });

      setUserState(key, {
        stage: "awaiting_name",
        messageId: msg.id,
        promptMsgId: prompt.id,
        fileName: originalName,
        fileSize,
        originalName,
      });
      return;
    }

    // ── Text → new filename ──────────────────────────────────────────────
    if (text && !text.startsWith("/")) {
      const state = userState.get(key);

      if (!state || state.stage !== "awaiting_name") {
        const tip = await client.sendMessage(chatId, {
          message: "⚠️ ابتدا یک فایل ارسال کنید.",
          buttons: [[styledButton("📖 راهنما", "help")]],
        });
        setTimeout(() => del(client, chatId, [tip.id, msg.id]), 4000);
        return;
      }

      const { messageId, promptMsgId, fileName: originalName, fileSize } = state;
      let newFileName = text.trim();

      // حفظ پسوند
      const ext = getExtension(originalName);
      if (ext && !newFileName.includes(".")) {
        newFileName = `\( {newFileName}. \){ext}`;
      }

      await del(client, chatId, [msg.id, promptMsgId]);

      // نمایش پیش‌نمایش
      const confirmMsg = await client.sendMessage(chatId, {
        message:
          `📝 <b>پیش‌نمایش نام جدید</b>\n\n` +
          `نام فعلی:\n<code>${originalName}</code>\n\n` +
          `نام جدید:\n<code>${newFileName}</code>`,
        parseMode: "html",
        buttons: CONFIRM_KB(originalName, newFileName),
      });

      setUserState(key, {
        ...state,
        stage: "confirming",
        newFileName,
        confirmMsgId: confirmMsg.id,
      });
      return;
    }
  }, new NewMessage({}));

  // ── Callback query handler ──────────────────────────────────────────────

  client.addEventHandler(async (event) => {
    const data = event.data?.toString() ?? "";
    const chatId = event.query.userId;
    const key = k(chatId);
    const state = userState.get(key);

    await event.answer().catch(() => {});

    switch (true) {
      case data === "help":
        await client.sendMessage(chatId, {
          message: HELP,
          parseMode: "html",
          buttons: BACK_KB,
        });
        break;

      case data === "about":
        await client.sendMessage(chatId, {
          message: ABOUT,
          parseMode: "html",
          buttons: BACK_KB,
        });
        break;

      case data === "back_start":
        setUserState(key, { stage: "idle" });
        await client.sendMessage(chatId, {
          message: WELCOME,
          parseMode: "html",
          buttons: MAIN_KB,
        });
        break;

      case data === "edit":
        if (state?.stage === "confirming") {
          await del(client, chatId, [state.confirmMsgId]);
          const prompt = await client.sendMessage(chatId, {
            message:
              `✏️ نام جدید را ویرایش کنید:\n\n` +
              `نام قبلی: <code>${state.newFileName}</code>`,
            parseMode: "html",
            buttons: CANCEL_KB,
          });
          setUserState(key, {
            ...state,
            stage: "awaiting_name",
            promptMsgId: prompt.id,
          });
        }
        break;

      case data === "cancel_process": {
        const processData = processingFiles.get(key);
        if (processData) {
          processingFiles.set(key, { ...processData, cancelled: true });
          await client.editMessage(chatId, {
            message: processData.statusMsgId,
            text: "⛔ پردازش لغو شد.",
          }).catch(() => {});
          await client.sendMessage(chatId, {
            message: "❌ پردازش لغو شد. فایل جدیدی ارسال کنید.",
            buttons: MAIN_KB,
          });
          clearUserState(key);
        }
        break;
      }

      case data === "cancel": {
        if (state?.stage === "awaiting_name" || state?.stage === "confirming") {
          if (state.promptMsgId) await del(client, chatId, [state.promptMsgId]);
          if (state.confirmMsgId) await del(client, chatId, [state.confirmMsgId]);
        }
        clearUserState(key);
        await client.sendMessage(chatId, {
          message: "❌ لغو شد. فایل جدیدی ارسال کنید:",
          parseMode: "html",
          buttons: MAIN_KB,
        });
        break;
      }

      case data === "another":
        setUserState(key, { stage: "idle" });
        await client.sendMessage(chatId, {
          message: WELCOME,
          parseMode: "html",
          buttons: MAIN_KB,
        });
        break;

      case data.startsWith("confirm_"): {
        if (state?.stage !== "confirming") break;

        const newFileName = data.replace("confirm_", "");
        const { messageId, fileName: originalName, fileSize } = state;

        await del(client, chatId, [state.confirmMsgId]);
        setUserState(key, { stage: "processing" });

        const statusMsg = await client.sendMessage(chatId, {
          message: buildDownloadMsg(newFileName, 0, fileSize),
          parseMode: "html",
          buttons: CANCEL_PROCESS_KB,
        });

        const tmpPath = path.join(
          os.tmpdir(),
          `tg_dl_\( {Date.now()}_ \){Math.random().toString(36).slice(2)}`,
        );
        const renamedPath = path.join(os.tmpdir(), newFileName);

        processingFiles.set(key, {
          statusMsgId: statusMsg.id,
          cancelled: false,
          tmpPath,
          renamedPath,
        });

        let lastProgressUpdate = 0;
        let lastBytes = 0;
        let lastTime = Date.now();

        try {
          const [origMsg] = await client.getMessages(chatId, { ids: [messageId] });
          if (!origMsg?.media) throw new Error("Media not found");

          // ── Download ──
          await client.downloadMedia(origMsg.media, {
            outputFile: tmpPath,
            progressCallback: async (downloaded, total) => {
              const now = Date.now();
              if (now - lastProgressUpdate < 2000) return;
              lastProgressUpdate = now;

              if (processingFiles.get(key)?.cancelled) {
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
                eta = `\( {min}: \){String(sec).padStart(2, "0")}`;
              }

              await client.editMessage(chatId, {
                message: statusMsg.id,
                text: buildDownloadMsg(newFileName, pct, totalNum, speed, eta),
                parseMode: "html",
                buttons: CANCEL_PROCESS_KB,
              }).catch(() => {});
            },
          });

          if (processingFiles.get(key)?.cancelled) {
            throw new Error("Cancelled by user");
          }

          fs.renameSync(tmpPath, renamedPath);

          // ── Upload ──
          lastProgressUpdate = 0;
          lastBytes = 0;
          lastTime = Date.now();

          await client.editMessage(chatId, {
            message: statusMsg.id,
            text: buildUploadMsg(newFileName, 0, fileSize),
            parseMode: "html",
            buttons: CANCEL_PROCESS_KB,
          }).catch(() => {});

          await client.sendFile(chatId, {
            file: renamedPath,
            caption:
              `✅ <b>تغییر نام انجام شد!</b>\n` +
              `📄 <code>${newFileName}</code>\n` +
              `💾 ${fmtSize(fileSize)}`,
            parseMode: "html",
            forceDocument: true,
            attributes: [new Api.DocumentAttributeFilename({ fileName: newFileName })],
            progressCallback: async (progress) => {
              const now = Date.now();
              if (now - lastProgressUpdate < 2000) return;
              lastProgressUpdate = now;

              if (processingFiles.get(key)?.cancelled) {
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
                eta = `\( {min}: \){String(sec).padStart(2, "0")}`;
              }

              await client.editMessage(chatId, {
                message: statusMsg.id,
                text: buildUploadMsg(newFileName, pct, fileSize, speed, eta),
                parseMode: "html",
                buttons: CANCEL_PROCESS_KB,
              }).catch(() => {});
            },
          });

          // Update stats
          stats.total++;
          stats.totalBytes += fileSize;
          saveStats();

          await del(client, chatId, [statusMsg.id]);

          await client.sendMessage(chatId, {
            message:
              `✅ <b>کامل شد!</b>\n` +
              `📄 <code>${newFileName}</code>\n` +
              `💾 ${fmtSize(fileSize)}`,
            parseMode: "html",
            buttons: DONE_KB,
          });

          if (chatId !== ADMIN_ID) {
            await client.sendMessage(ADMIN_ID, {
              message:
                `🔔 <b>فایل جدید پردازش شد</b>\n` +
                `👤 کاربر: <code>${chatId}</code>\n` +
                `📄 <code>${newFileName}</code>\n` +
                `💾 ${fmtSize(fileSize)}`,
              parseMode: "html",
            }).catch(() => {});
          }

          clearUserState(key);
          processingFiles.delete(key);
        } catch (err) {
          if (err.message === "Cancelled by user") {
            // قبلاً پیام لغو فرستاده شده
          } else {
            console.error("❌ Error processing file:", err);
            logger.error({ err }, "Error renaming file");
            await client.editMessage(chatId, {
              message: statusMsg.id,
              text: "❌ خطا در پردازش فایل. دوباره امتحان کنید.",
            }).catch(() => {});
          }
          clearUserState(key);
          processingFiles.delete(key);
        } finally {
          // پاک‌سازی تضمینی فایل‌های موقت
          for (const p of [tmpPath, renamedPath]) {
            try {
              if (fs.existsSync(p)) fs.unlinkSync(p);
            } catch {}
          }
          // Auto-delete status message after 5 minutes
          setTimeout(() => del(client, chatId, [statusMsg.id]), 300000);
        }
        break;
      }
    }
  }, new CallbackQuery({}));

  // Notify admin that bot is online
  console.log("📢 Sending online notification to admin...");
  await client.sendMessage(ADMIN_ID, {
    message:
      `🟢 <b>ربات آنلاین شد.</b>\n\n` +
      `دستورات ادمین:\n` +
      `/stats — آمار کامل\n` +
      `/ping — وضعیت\n` +
      `/ban [userId] — مسدود کردن کاربر\n` +
      `/unban [userId] — آزاد کردن کاربر`,
    parseMode: "html",
  }).catch((err) => {
    console.error("⚠️ Could not notify admin:", err.message);
  });

  console.log("🎯 Bot is fully ready and listening!");
}

// ─── Start the bot ──────────────────────────────────────────────────────────

console.log("🚀 Starting bot application...");
startBot()
  .then(() => {
    console.log("✅ Bot started successfully!");

    // ─── Keep alive ──────────────────────────────────────────────────────────
    console.log("🔄 Keeping process alive...");

    setInterval(() => {
      // Keep alive
    }, 10000);

    process.stdin.resume();

    process.on("SIGINT", () => {
      console.log("👋 Received SIGINT. Exiting gracefully...");
      saveStats();
      process.exit(0);
    });

    process.on("SIGTERM", () => {
      console.log("👋 Received SIGTERM. Exiting gracefully...");
      saveStats();
      process.exit(0);
    });

    console.log("✅ Bot is running and will stay alive!");
  })
  .catch((err) => {
    console.error("💥 Fatal error:", err);
    process.exit(1);
  });
