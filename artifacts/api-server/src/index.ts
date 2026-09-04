import { createServer } from "node:http";
import app from "./app";
import { logger } from "./lib/logger";
import { registerP2PMeet } from "./lib/p2p-meet";
import { startNovaLuthEmailWorker } from "./lib/novaluth-email-outbox";
import { startNovaLuthMaintenanceScheduler } from "./routes/novaluth";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const server = createServer(app);
await registerP2PMeet(server);

server.on("error", (err) => {
  logger.error({ err }, "Error listening on port");
  process.exit(1);
});

server.listen(port, () => {
  logger.info({ port }, "Server listening");
  startNovaLuthEmailWorker();
  startNovaLuthMaintenanceScheduler();
});
