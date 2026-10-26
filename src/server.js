const env = require("./config/env");
const app = require("./app");
const { connectToDatabase } = require("./database/mongoose");
const { logger } = require("./logger");

async function bootstrap() {
  try {
    await connectToDatabase();
    const port = env.port || 4000;
    app.listen(port, () => {
      logger.info(`[server] listening on port ${port}`);
    });
  } catch (error) {
    logger.error({ err: error }, "[server] failed to start");
    process.exit(1);
  }
}

process.on("unhandledRejection", (reason) => {
  logger.fatal({ err: reason }, "[server] unhandled rejection");
  process.exit(1);
});

process.on("uncaughtException", (error) => {
  logger.fatal({ err: error }, "[server] uncaught exception");
  process.exit(1);
});

bootstrap();
