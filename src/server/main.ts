import { createApp } from "./http/app.js";
import { env } from "./env.js";

const app = await createApp();
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  await app.close();
  process.exit(0);
}
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
try {
  await app.listen({ port: env.port, host: "127.0.0.1" });
  console.log(`Solaris is listening at http://127.0.0.1:${env.port}`);
} catch (error) {
  app.log.error(error); process.exit(1);
}
