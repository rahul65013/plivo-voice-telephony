const winston = require("winston");

const { combine, timestamp, printf, colorize, errors } = winston.format;

const fmt = printf(({ level, message, timestamp, stack }) => {
  return `${timestamp} [${level}] ${stack || message}`;
});

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: combine(
    errors({ stack: true }),
    timestamp({ format: "YYYY-MM-DD HH:mm:ss.SSS" }),
    process.env.NODE_ENV === "production" ? winston.format.json() : combine(colorize(), fmt)
  ),
  transports: [
    new winston.transports.Console(),
    // In production on EC2, also write to file (PM2 rotates these)
    ...(process.env.NODE_ENV === "production"
      ? [
          new winston.transports.File({ filename: "/var/log/plivo-server/error.log", level: "error" }),
          new winston.transports.File({ filename: "/var/log/plivo-server/combined.log" }),
        ]
      : []),
  ],
});

module.exports = logger;
