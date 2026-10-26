const mongoose = require("mongoose");
const env = require("../config/env");
const { logger } = require("../logger");

mongoose.set("strictQuery", true);

let connectionPromise = null;

async function connectToDatabase() {
  if (connectionPromise) return connectionPromise;

  if (!env.mongodbUri) {
    throw new Error("MONGODB_URI environment variable must be defined");
  }

  connectionPromise = mongoose
    .connect(env.mongodbUri, {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 5000,
      autoIndex: env.nodeEnv !== "production"
    })
    .then((connection) => {
      logger.info("[mongo] connected");
      connection.connection.on("error", (error) => {
        logger.error({ err: error }, "[mongo] connection error");
      });
      connection.connection.on("disconnected", () => {
        logger.warn("[mongo] disconnected");
      });
      return connection;
    })
    .catch((error) => {
      connectionPromise = null;
      throw error;
    });

  return connectionPromise;
}

module.exports = { connectToDatabase };
