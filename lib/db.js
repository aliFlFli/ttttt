import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

/**
 * SQLite-backed persistence. Replaces the previous per-table JSON files
 * (users.json, stats.json, banned.json, bot_config.json) with a single
 * durable, crash-safe database file, and adds a `files` table so users can
 * browse their upload history by category/folder.
 */
export function openDb(dataDir) {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, "bot.sqlite3");
  const db = new Database(dbPath);

  db.pragma("journal_mode = WAL"); // crash-safe, concurrent-read friendly
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      lang TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      first_seen INTEGER NOT NULL,
      last_seen TEXT,
      count INTEGER NOT NULL DEFAULT 0,
      total_bytes INTEGER NOT NULL DEFAULT 0,
      daily_bytes INTEGER NOT NULL DEFAULT 0,
      daily_date TEXT,
      referred_by TEXT,
      premium_until INTEGER NOT NULL DEFAULT 0,
      premium_limit INTEGER NOT NULL DEFAULT 0,
      premium_tier TEXT
    );

    CREATE TABLE IF NOT EXISTS referrals (
      referrer_id TEXT NOT NULL,
      referred_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (referrer_id, referred_id)
    );

    CREATE TABLE IF NOT EXISTS banned (
      id TEXT PRIMARY KEY,
      banned_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS stats (
      key TEXT PRIMARY KEY,
      value INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(user_id, name)
    );

    CREATE TABLE IF NOT EXISTS files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      category_id INTEGER,
      original_name TEXT NOT NULL,
      new_name TEXT NOT NULL,
      size INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_files_user ON files(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_categories_user ON categories(user_id);
  `);

  return db;
}

const DEFAULT_CONFIG = {
  maxFileSize: 2 * 1024 * 1024 * 1024,
  normalDailyLimit: 5 * 1024 * 1024 * 1024,
};

export function makeStore(db) {
  const stmts = {
    getUser: db.prepare("SELECT * FROM users WHERE id = ?"),
    insertUser: db.prepare(`
      INSERT INTO users (id, lang, status, first_seen, last_seen, daily_date)
      VALUES (@id, @lang, @status, @first_seen, @last_seen, @daily_date)
    `),
    updateUser: db.prepare(`
      UPDATE users SET
        lang=@lang, status=@status, last_seen=@last_seen, count=@count,
        total_bytes=@total_bytes, daily_bytes=@daily_bytes, daily_date=@daily_date,
        referred_by=@referred_by, premium_until=@premium_until,
        premium_limit=@premium_limit, premium_tier=@premium_tier
      WHERE id=@id
    `),
    allUsers: db.prepare("SELECT * FROM users"),
    addReferral: db.prepare(`
      INSERT OR IGNORE INTO referrals (referrer_id, referred_id, created_at) VALUES (?, ?, ?)
    `),
    countReferrals: db.prepare("SELECT COUNT(*) AS c FROM referrals WHERE referrer_id = ?"),

    isBanned: db.prepare("SELECT 1 FROM banned WHERE id = ?"),
    ban: db.prepare("INSERT OR IGNORE INTO banned (id, banned_at) VALUES (?, ?)"),
    unban: db.prepare("DELETE FROM banned WHERE id = ?"),
    listBanned: db.prepare("SELECT id FROM banned"),

    getConfig: db.prepare("SELECT value FROM config WHERE key = ?"),
    setConfig: db.prepare("INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"),

    getStat: db.prepare("SELECT value FROM stats WHERE key = ?"),
    incStat: db.prepare(`
      INSERT INTO stats (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = value + excluded.value
    `),

    findCategory: db.prepare("SELECT * FROM categories WHERE user_id = ? AND name = ?"),
    insertCategory: db.prepare("INSERT INTO categories (user_id, name, created_at) VALUES (?, ?, ?)"),
    listCategories: db.prepare(`
      SELECT c.*, COUNT(f.id) AS file_count
      FROM categories c LEFT JOIN files f ON f.category_id = c.id
      WHERE c.user_id = ? GROUP BY c.id ORDER BY c.created_at DESC
    `),

    insertFile: db.prepare(`
      INSERT INTO files (user_id, category_id, original_name, new_name, size, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `),
    filesByCategory: db.prepare(`
      SELECT * FROM files WHERE user_id = ? AND category_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?
    `),
    filesUncategorized: db.prepare(`
      SELECT * FROM files WHERE user_id = ? AND category_id IS NULL ORDER BY created_at DESC LIMIT ? OFFSET ?
    `),
  };

  function nowSec() {
    return Date.now();
  }

  function rowToUser(row) {
    if (!row) return null;
    return row;
  }

  function getUser(id, adminId) {
    let row = stmts.getUser.get(id);
    if (!row) {
      const today = new Date().toDateString();
      stmts.insertUser.run({
        id,
        lang: null,
        status: id === adminId ? "approved" : "pending",
        first_seen: nowSec(),
        last_seen: today,
        daily_date: today,
      });
      row = stmts.getUser.get(id);
    }
    if (id === adminId && row.status !== "approved" && row.status !== "premium") {
      stmts.updateUser.run({ ...row, status: "approved" });
      row = stmts.getUser.get(id);
    }
    return rowToUser(row);
  }

  function saveUser(user) {
    stmts.updateUser.run(user);
  }

  function ensureDailyReset(user) {
    const today = new Date().toDateString();
    if (user.daily_date !== today) {
      user.daily_bytes = 0;
      user.daily_date = today;
    }
  }

  function isPremium(user) {
    if (user.status === "premium" && user.premium_until > Date.now()) return true;
    if (user.status === "premium" && user.premium_until <= Date.now()) {
      user.status = "approved";
      user.premium_until = 0;
      user.premium_limit = 0;
      user.premium_tier = null;
      saveUser(user);
    }
    return false;
  }

  function getConfigValue(key, fallback) {
    const row = stmts.getConfig.get(key);
    if (!row) return fallback;
    try { return JSON.parse(row.value); } catch { return fallback; }
  }
  function setConfigValue(key, value) {
    stmts.setConfig.run(key, JSON.stringify(value));
  }
  function getBotConfig() {
    return {
      maxFileSize: getConfigValue("maxFileSize", DEFAULT_CONFIG.maxFileSize),
      normalDailyLimit: getConfigValue("normalDailyLimit", DEFAULT_CONFIG.normalDailyLimit),
    };
  }

  function getStat(key) {
    const row = stmts.getStat.get(key);
    return row ? row.value : 0;
  }
  function incStat(key, by = 1) {
    stmts.incStat.run(key, by);
  }

  function findOrCreateCategory(userId, name) {
    let cat = stmts.findCategory.get(userId, name);
    if (!cat) {
      stmts.insertCategory.run(userId, name, nowSec());
      cat = stmts.findCategory.get(userId, name);
    }
    return cat;
  }

  function listCategories(userId) {
    return stmts.listCategories.all(userId);
  }

  function recordFile({ userId, categoryId, originalName, newName, size }) {
    stmts.insertFile.run(userId, categoryId ?? null, originalName, newName, size, nowSec());
  }

  function listFiles(userId, categoryId, limit = 10, offset = 0) {
    if (categoryId == null) return stmts.filesUncategorized.all(userId, limit, offset);
    return stmts.filesByCategory.all(userId, categoryId, limit, offset);
  }

  return {
    db,
    getUser,
    saveUser,
    ensureDailyReset,
    isPremium,
    allUsers: () => stmts.allUsers.all(),
    addReferral: (referrerId, referredId) => stmts.addReferral.run(referrerId, referredId, nowSec()),
    countReferrals: (referrerId) => stmts.countReferrals.get(referrerId).c,

    isBanned: (id) => !!stmts.isBanned.get(id),
    ban: (id) => stmts.ban.run(id, nowSec()),
    unban: (id) => stmts.unban.run(id),
    listBanned: () => stmts.listBanned.all().map((r) => r.id),

    getBotConfig,
    setMaxFileSize: (bytes) => setConfigValue("maxFileSize", bytes),
    setNormalDailyLimit: (bytes) => setConfigValue("normalDailyLimit", bytes),

    getStat,
    incStat,

    findOrCreateCategory,
    listCategories,
    recordFile,
    listFiles,
  };
}
