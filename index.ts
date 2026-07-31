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

// ─── Stats (in-memory) ───────────────────────────────────────────────────────

const stats = { total: 0, totalBytes: 0 };

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

function buildDownloadMsg(fileName, pct, totalBytes) {
  const done = Math.floor((totalBytes * pct) / 100);
  return (
    `⬇️ <b>در حال دانلود...</b>\n\n` +
    `${bar(pct)}  <b>${pct}%</b>\n` +
    `💾 ${fmtSize(done)} / ${fmtSize(totalBytes)}\n\n` +
    `📄 <code>${fileName}</code>`
  );
}

function buildUploadMsg(fileName, pct, totalBytes) {
  const done = Math.floor((totalBytes * pct) / 100);
  return (
    `✅ دانلود کامل شد\n` +
    `⬆️ <b>در حال آپلود...</b>\n\n` +
    `${bar(pct)}  <b>${pct}%</b>\n` +
    `💾 ${fmtSize(done)} / ${fmtSize(totalBytes)}\n\n` +
    `📄 <code>${fileName}</code>`
  );
}

async function del(client, chatId, ids) {
  await client.deleteMessages(chatId, ids, { revoke: true }).catch(() => {});
}

// ─── State machine ───────────────────────────────────────────────────────────

const userState = new Map();
const k = (id) => String(id);

// ─── Keyboards ───────────────────────────────────────────────────────────────

const MAIN_KB = [[
  Button.inline("📖 راهنما", Buffer.from("help")),
  Button.inline("ℹ️ درباره", Buffer.from("about")),
]];
const CANCEL_KB = [[Button.inline("❌ لغو", Buffer.from("cancel"))]];
const DONE_KB   = [[Button.inline("🔄 فایل دیگه", Buffer.from("another"))]];
const BACK_KB   = [[Button.inline("🔙 بازگشت", Buffer.from("back_start"))]];

// ─── Static messages ──────────────────────────────────────────────────────────

const WELCOME = `🎬 <b>ربات تغییر نام فایل</b>
فایل ویدیویی خود را ارسال کنید.
📦 پشتیبانی تا <b>۲ گیگابایت</b> — بدون محدودیت!`;

const HELP = `📖 <b>راهنما</b>

۱. فایل را به صورت <b>Document</b> ارسال کنید
۲. نام جدید را تایپ کنید
۳. فایل با نام جدید دریافت کنید ✅

مثال: <code>@KoreaMixPlus.Boy.Friend.E01.540p.mkv</code>`;

const ABOUT = `ℹ️ <b>درباره ربات</b>
⚡ پروتکل: MTProto — بدون محدودیت ۲۰MB
📦 حداکثر: ۲ گیگابایت (۴GB برای پرمیوم)
🔒 فایل‌ها بلافاصله بعد از ارسال حذف می‌شن`;

// ─── Bot entry point ─────────────────────────────────────────────────────────

export async function startBot() {
  if (!API_ID || !API_HASH || !BOT_TOKEN) {
    logger.warn("Missing Telegram credentials — bot not started");
    return;
  }

  let sessionStr = "";
  try { sessionStr = fs.readFileSync(SESSION_FILE, "utf-8").trim(); } catch { /* no session */ }

  const client = new TelegramClient(
    new StringSession(sessionStr),
    API_ID,
    API_HASH,
    { connectionRetries: 5 },
  );

  await client.start({ botAuthToken: BOT_TOKEN });

  try {
    const saved = client.session.save();
    fs.writeFileSync(SESSION_FILE, saved, "utf-8");
  } catch { /* non-fatal */ }

  logger.info("Telegram bot started (GramJS MTProto — no size limit)");

  // ── Message handler ───────────────────────────────────────────────────────

  client.addEventHandler(async (event) => {
    const msg = event.message;
    if (!msg?.isPrivate) return;

    const chatId = msg.chatId;
    const key = k(chatId);
    const text = msg.message ?? "";
    const isAdmin = chatId === ADMIN_ID;

    // /start
    if (text.startsWith("/start")) {
      userState.set(key, { stage: "idle" });
      await client.sendMessage(chatId, { message: WELCOME, parseMode: "html", buttons: MAIN_KB });
      return;
    }

    // Admin commands
    if (isAdmin) {
      if (text === "/stats") {
        await client.sendMessage(chatId, {
          message:
            `📊 <b>آمار ربات</b>\n\n` +
            `✅ فایل‌های پردازش‌شده: <b>${stats.total}</b>\n` +
            `💾 حجم کل: <b>${fmtSize(stats.totalBytes)}</b>`,
          parseMode: "html",
        });
        return;
      }
      if (text === "/ping") {
        await client.sendMessage(chatId, { message: "🟢 ربات آنلاین است." });
        return;
      }
    }

    // ── Incoming document ────────────────────────────────────────────────────
    let doc =
      msg.document ??
      (msg.media instanceof Api.MessageMediaDocument
        ? msg.media.document
        : undefined);

    if (doc) {
      const fnAttr = doc.attributes?.find(
        (a) =>
          a instanceof Api.DocumentAttributeFilename,
      );
      const originalName = fnAttr?.fileName ?? `file_${msg.id}`;
      const fileSize = Number(doc.size ?? 0);

      const prompt = await client.sendMessage(chatId, {
        message:
          `📦 <b>${originalName}</b>\n` +
          `💾 ${fmtSize(fileSize)}\n\n` +
          `✏️ نام جدید را ارسال کنید:`,
        parseMode: "html",
        buttons: CANCEL_KB,
      });

      userState.set(key, {
        stage: "awaiting_name",
        messageId: msg.id,
        promptMsgId: prompt.id,
        fileName: originalName,
        fileSize,
      });
      return;
    }

    // ── Text → new filename ──────────────────────────────────────────────────
    if (text && !text.startsWith("/")) {
      const state = userState.get(key);

      if (!state || state.stage !== "awaiting_name") {
        const tip = await client.sendMessage(chatId, {
          message: "⚠️ ابتدا یک فایل ارسال کنید.",
          buttons: [[Button.inline("📖 راهنما", Buffer.from("help"))]],
        });
        // Auto-delete hint after 4 seconds
        setTimeout(() => del(client, chatId, [tip.id, msg.id]), 4000);
        return;
      }

      const { messageId, promptMsgId, fileName: originalName, fileSize } = state;
      const newFileName = text.trim();
      userState.set(key, { stage: "processing" });

      // Delete: user's filename message + bot's prompt message
      await del(client, chatId, [msg.id, promptMsgId]);

      const statusMsg = await client.sendMessage(chatId, {
        message: buildDownloadMsg(newFileName, 0, fileSize),
        parseMode: "html",
      });

      const tmpPath    = path.join(os.tmpdir(), `tg_dl_${Date.now()}`);
      const renamedPath = path.join(os.tmpdir(), newFileName);

      try {
        const [origMsg] = await client.getMessages(chatId, { ids: [messageId] });
        if (!origMsg?.media) throw new Error("Media not found");

        // ── Download ─────────────────────────────────────────────────────
        let lastDl = 0;
        await client.downloadMedia(origMsg.media, {
          outputFile: tmpPath,
          progressCallback: async (downloaded, total) => {
            const now = Date.now();
            if (now - lastDl < 2500) return;
            lastDl = now;
            const pct = total > 0n
              ? Math.min(99, Math.floor((Number(downloaded) / Number(total)) * 100))
              : 0;
            await client.editMessage(chatId, {
              message: statusMsg.id,
              text: buildDownloadMsg(newFileName, pct, Number(total) || fileSize),
              parseMode: "html",
            }).catch(() => {});
          },
        });

        fs.renameSync(tmpPath, renamedPath);

        // Show upload phase
        await client.editMessage(chatId, {
          message: statusMsg.id,
          text: buildUploadMsg(newFileName, 0, fileSize),
          parseMode: "html",
        }).catch(() => {});

        // ── Upload ───────────────────────────────────────────────────────
        let lastUp = 0;
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
            if (now - lastUp < 2500) return;
            lastUp = now;
            const pct = Math.min(99, Math.floor(progress * 100));
            await client.editMessage(chatId, {
              message: statusMsg.id,
              text: buildUploadMsg(newFileName, pct, fileSize),
              parseMode: "html",
            }).catch(() => {});
          },
        });

        // Update stats
        stats.total++;
        stats.totalBytes += fileSize;

        // Delete progress message
        await del(client, chatId, [statusMsg.id]);

        // Success + next action button
        await client.sendMessage(chatId, {
          message:
            `✅ <b>کامل شد!</b>\n` +
            `📄 <code>${newFileName}</code>\n` +
            `💾 ${fmtSize(fileSize)}`,
          parseMode: "html",
          buttons: DONE_KB,
        });

        // Notify admin (if not self)
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

        userState.set(key, { stage: "idle" });

      } catch (err) {
        logger.error({ err }, "Error renaming file");
        userState.set(key, { stage: "idle" });
        await client.editMessage(chatId, {
          message: statusMsg.id,
          text: "❌ خطا در پردازش فایل. دوباره امتحان کنید.",
        }).catch(() => {});
      } finally {
        // Always clean up temp files
        for (const p of [tmpPath, renamedPath]) {
          fs.unlink(p, () => {});
        }
      }
    }
  }, new NewMessage({}));

  // ── Callback query handler ────────────────────────────────────────────────

  client.addEventHandler(async (event) => {
    const data = event.data?.toString() ?? "";
    const chatId = event.query.userId;
    const key = k(chatId);

    await event.answer().catch(() => {});

    switch (data) {
      case "help":
        await client.sendMessage(chatId, { message: HELP, parseMode: "html", buttons: BACK_KB });
        break;
      case "about":
        await client.sendMessage(chatId, { message: ABOUT, parseMode: "html", buttons: BACK_KB });
        break;
      case "cancel": {
        const state = userState.get(key);
        if (state?.stage === "awaiting_name") {
          await del(client, chatId, [state.promptMsgId]);
        }
        userState.set(key, { stage: "idle" });
        await client.sendMessage(chatId, {
          message: "❌ لغو شد. فایل جدیدی ارسال کنید:",
          parseMode: "html",
          buttons: MAIN_KB,
        });
        break;
      }
      case "another":
      case "back_start":
        userState.set(key, { stage: "idle" });
        await client.sendMessage(chatId, { message: WELCOME, parseMode: "html", buttons: MAIN_KB });
        break;
    }
  }, new CallbackQuery({}));

  // Notify admin that bot is online
  await client.sendMessage(ADMIN_ID, {
    message: "🟢 <b>ربات آنلاین شد.</b>\n\nدستورات ادمین:\n/stats — آمار\n/ping — وضعیت",
    parseMode: "html",
  }).catch(() => {});
}
