import { loadConfig } from "./config.js";
import { startEnglishStudyHttpServer } from "./http-server.js";

startEnglishStudyHttpServer(loadConfig(), (message) => console.error(message)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
