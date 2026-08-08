const pino = require("pino");
const env = require("./config/env");

const isDev = env.nodeEnv !== "production";

const logger = pino(
  { level: env.logLevel },
  isDev ? require("pino-pretty")({ colorize: true, translateTime: "SYS:HH:MM:ss" }) : undefined
);

module.exports = { logger };
