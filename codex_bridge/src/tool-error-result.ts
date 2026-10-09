import { ThreadHistoryError } from "./thread-history-reader.js";
import { ConversationPersistenceError } from "./job-store.js";
import { DirectOperationError } from "./direct-operation-error.js";

export function toolErrorResult(error: unknown) {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
  const code = error instanceof DirectOperationError || error instanceof ThreadHistoryError || error instanceof ConversationPersistenceError
    ? error.code
    : "BridgeOperationFailed";
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
    structuredContent: { error: { code, message } },
  };
}
