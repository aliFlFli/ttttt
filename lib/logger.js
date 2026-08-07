// Minimal structured logger. Swap for pino/winston if you already use one.
function fmt(level, objOrMsg, msg) {
  const time = new Date().toISOString();
  if (typeof objOrMsg === "object") {
    return `[${time}] ${level.toUpperCase()}: ${msg || ""} ${JSON.stringify(objOrMsg)}`;
  }
  return `[${time}] ${level.toUpperCase()}: ${objOrMsg}`;
}

export const logger = {
  info: (objOrMsg, msg) => console.log(fmt("info", objOrMsg, msg)),
  warn: (objOrMsg, msg) => console.warn(fmt("warn", objOrMsg, msg)),
  error: (objOrMsg, msg) => console.error(fmt("error", objOrMsg, msg)),
};
