import { isContextOverflow, isRetryableAssistantError } from "@earendil-works/pi-ai/compat";

export const DELAY_MS = 10_000;

const disconnected = /\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|UND_ERR_SOCKET|ERR_STREAM_PREMATURE_CLOSE|unexpected EOF)\b|\bthe reply ended before it was complete\b/i;
const permanent = /\b(?:content[_ -]?filter(?:ed)?|content[_ -]?policy[_ -]?violation|prompt[_ -]?blocked|PROHIBITED_CONTENT|unauthorized|forbidden|invalid[_ -]?api[_ -]?key|authentication[_ -]?error|invalid[_ -]?request(?:[_ -]?error)?|insufficient[_ -]?quota|quota exceeded|billing|out of budget)\b|(?:^|\bHTTP\s+)(?:400|401|403)\b/i;
const terminalReason = /^(?:safety|content_filter|prohibited_content|blocklist|recitation|refusal)$/i;
const rejectionBanner = /^\s*(?:this |your |the )?request (?:was|has been) blocked by .{0,80}\b(?:filters?|safety policy)\b/im;

export function retryPolicy(message, model, policy, nativeUsed) {
  if (message.role !== "assistant" || message.stopReason !== "error" || isContextOverflow(message, model?.contextWindow ?? 0)) {
    return { retry: false, native: false };
  }
  const error = message.errorMessage ?? "";
  const nativeEligible = isRetryableAssistantError(message);
  const native = nativeEligible && (policy?.enabled ?? true) && nativeUsed < (policy?.maxRetries ?? 3);
  const rejected = terminalReason.test(message.rawStopReason ?? "") || permanent.test(error) || rejectionBanner.test(error) || message.content?.some(
    part => part.type === "text" && rejectionBanner.test(part.text)
  );
  const delay = native
    ? Math.min((policy?.baseDelayMs ?? 2000) * 2 ** nativeUsed, policy?.maxAgentDelayMs ?? 60_000)
    : 0;
  return { retry: !rejected && (nativeEligible || disconnected.test(error)), native, delay };
}

// The session keeps its raw transcript. The context edit skips only the failed
// assistant reply on the next request and preserves every completed tool result.
export function continuation(event, targetId) {
  if (event.outcome !== "error" || event.continue || event.context.pendingMessages.length) return;
  const tail = event.context.contextEntries.findLast(entry => entry.messages.length);
  if (tail?.sourceEntry.id !== targetId || tail.messages.at(-1)?.role !== "assistant") return;
  return {
    entries: [...event.entries, { type: "context_edit", targetId, replacement: null }],
    continue: true,
  };
}

export function waitForDelay(ms, signal) {
  if (ms <= 0 || signal.aborted) return;
  return new Promise(resolve => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
}
