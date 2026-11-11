import { isContextOverflow, isRetryableAssistantError } from "@earendil-works/pi-ai/compat";

export const DELAY_MS = 10_000;
export const SELF_CHECK_TYPE = "pi-auto-retry";
export const REDACTED_TOOL_PREFIX = "[pi-auto-retry: raw tool output omitted";

const disconnected = /\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|UND_ERR_SOCKET|ERR_STREAM_PREMATURE_CLOSE|unexpected EOF)\b|\bthe reply ended before it was complete\b/i;
const filterError = /\b(?:content[_ -]?filter(?:ed)?|content[_ -]?policy[_ -]?violation|prompt[_ -]?blocked|PROHIBITED_CONTENT|FINISH_REASON_SAFETY|Provider stopped with:\s*sensitive)\b/i;
const authOrQuota = /\b(?:unauthorized|forbidden|invalid[_ -]?api[_ -]?key|authentication[_ -]?error|insufficient[_ -]?quota|quota exceeded|billing|out of budget)\b|(?:^|\bHTTP\s+)(?:401|403)\b/i;
const badRequest = /\b(?:invalid[_ -]?request(?:[_ -]?error)?)\b|(?:^|\bHTTP\s+)400\b/i;
const terminalReason = /^(?:safety|content_filter|prohibited_content|blocklist|recitation|spii|image_safety|image_prohibited_content|image_recitation|sensitive|refusal)$/i;
const rejectionBanner = /(?:^|[\s"'`])(?:this |your |the )?request (?:was|has been) blocked by .{0,80}\b(?:filters?|safety polic(?:y|ies))\b/i;
const stripBanner = /(?:this |your |the )?request (?:was|has been) blocked by [\s\S]*$/i;

export function inspectBlockedMessage(message) {
  const error = message.errorMessage ?? "";
  const rawReason = (message.rawStopReason ?? "").trim();
  const texts = (message.content ?? []).filter(part => part.type === "text").map(part => part.text ?? "");
  const combined = [error, ...texts].join("\n");

  let reason = "provider content filter";
  if (/gemini's filters/i.test(combined)) reason = "Gemini's content filter";
  else if (rawReason && terminalReason.test(rawReason)) reason = "provider filter (" + rawReason + ")";

  const hadThinking = Boolean(
    message.content?.some(part => part.type === "thinking" && Boolean(part.thinking?.trim())),
  );
  const hadPartialText = texts.some(text => text.replace(stripBanner, "").trim().length > 0);
  const attemptedTools = [
    ...new Set(
      (message.content ?? [])
        .filter(part => part.type === "toolCall" && typeof part.name === "string" && part.name)
        .map(part => part.name),
    ),
  ];

  return {
    reason,
    stage: hadThinking || hadPartialText || attemptedTools.length > 0 ? "output" : "request",
    hadThinking,
    hadPartialText,
    attemptedTools,
  };
}

export function retryPolicy(message, model, policy, nativeUsed) {
  if (
    message.role !== "assistant"
    || message.stopReason !== "error"
    || isContextOverflow(message, model?.contextWindow ?? 0)
  ) {
    return { retry: false, native: false };
  }
  const error = message.errorMessage ?? "";
  const nativeEligible = isRetryableAssistantError(message);
  const native = nativeEligible && (policy?.enabled ?? true) && nativeUsed < (policy?.maxRetries ?? 3);
  if (authOrQuota.test(error)) {
    return { retry: false, native };
  }
  const delay = native
    ? Math.min((policy?.baseDelayMs ?? 2000) * 2 ** nativeUsed, policy?.maxAgentDelayMs ?? 60_000)
    : 0;
  const providerBlocked = terminalReason.test(message.rawStopReason ?? "")
    || filterError.test(error)
    || rejectionBanner.test(error)
    || Boolean(message.content?.some(part => part.type === "text" && rejectionBanner.test(part.text ?? "")));
  if (providerBlocked) {
    return {
      retry: true,
      selfCheck: true,
      providerBlocked: true,
      native,
      delay,
      clue: inspectBlockedMessage(message),
    };
  }
  return { retry: !badRequest.test(error) && (nativeEligible || disconnected.test(error)), native, delay };
}

export function isRedactedToolResult(message) {
  return message?.role === "toolResult"
    && Array.isArray(message.content)
    && message.content.length === 1
    && message.content[0]?.type === "text"
    && message.content[0].text.startsWith(REDACTED_TOOL_PREFIX);
}

export function formatRedactedToolResult(message) {
  const content = Array.isArray(message.content) ? message.content : [];
  const text = content.filter(part => part.type === "text").map(part => part.text ?? "").join("\n");
  const images = content.filter(part => part.type === "image").length;
  const lines = text ? text.split(/\r?\n/).length : 0;
  const stats = [
    message.toolName || "tool",
    ...(message.isError ? ["error"] : []),
    lines + " lines",
    text.length + " chars",
    ...(images ? [images + " image(s)"] : []),
  ].join(", ");
  return `${REDACTED_TOOL_PREFIX} (${stats}) after consecutive provider filter blocks. Re-inspect selectively if needed using narrow line ranges, filtered queries, or a local summary script instead of loading full raw output into context.]`;
}

function findLatestUnredactedToolBatch(surviving, minIndex) {
  for (let i = surviving.length - 1; i >= Math.max(0, minIndex); i--) {
    const msg = surviving[i].messages[0];
    if (surviving[i].sourceEntry.type !== "message" || msg?.role !== "toolResult" || isRedactedToolResult(msg)) {
      continue;
    }
    let start = i;
    while (start > 0 && surviving[start - 1].messages[0]?.role === "toolResult") start--;
    let end = i;
    while (end + 1 < surviving.length && surviving[end + 1].messages[0]?.role === "toolResult") end++;

    const edits = [];
    const redactedTools = [];
    for (let k = start; k <= end; k++) {
      const entry = surviving[k];
      const toolMsg = entry.messages[0];
      if (entry.sourceEntry.type !== "message" || toolMsg?.role !== "toolResult" || isRedactedToolResult(toolMsg)) {
        continue;
      }
      edits.push({
        type: "context_edit",
        targetId: entry.sourceEntry.id,
        replacement: { content: [{ type: "text", text: formatRedactedToolResult(toolMsg) }] },
      });
      if (toolMsg.toolName && !redactedTools.includes(toolMsg.toolName)) {
        redactedTools.push(toolMsg.toolName);
      }
    }
    if (edits.length) return { edits, redactedTools, omittedTurnTools: [] };
  }
  return undefined;
}

export function planContextSanitization(contextEntries, ignoredIds = new Set()) {
  const surviving = contextEntries.filter(entry => entry.messages.length > 0 && !ignoredIds.has(entry.sourceEntry.id));
  const lastUserIdx = surviving.findLastIndex(entry => entry.messages.some(msg => msg.role === "user"));

  // 1. Prefer redacting the most recent unredacted toolResult batch in the active user request.
  const currentBatch = findLatestUnredactedToolBatch(surviving, lastUserIdx + 1);
  if (currentBatch) return currentBatch;

  // 2. If all toolResults in the active request are already redacted yet blocks persist,
  //    omit the latest assistant tool-call turn + its paired toolResults together (in case toolCall arguments triggered the filter).
  for (let i = surviving.length - 1; i >= Math.max(0, lastUserIdx + 1); i--) {
    const entry = surviving[i];
    const msg = entry.messages[0];
    if (entry.sourceEntry.type !== "message" || msg?.role !== "assistant") continue;
    const toolCalls = (msg.content ?? []).filter(part => part.type === "toolCall");
    if (!toolCalls.length) continue;
    const callIds = new Set(toolCalls.map(part => part.id));
    const edits = [{ type: "context_edit", targetId: entry.sourceEntry.id, replacement: null }];
    for (let j = i + 1; j < surviving.length; j++) {
      const next = surviving[j];
      const nextMsg = next.messages[0];
      if (nextMsg?.role === "assistant") break;
      if (next.sourceEntry.type === "message" && nextMsg?.role === "toolResult" && callIds.has(nextMsg.toolCallId)) {
        edits.push({ type: "context_edit", targetId: next.sourceEntry.id, replacement: null });
      }
    }
    const omittedTurnTools = [...new Set(toolCalls.map(part => part.name).filter(Boolean))];
    return { edits, redactedTools: [], omittedTurnTools };
  }

  // 3. Fallback: redact an earlier unredacted toolResult batch from prior turns if present.
  return findLatestUnredactedToolBatch(surviving, 0) ?? { edits: [], redactedTools: [], omittedTurnTools: [] };
}

export function buildSelfCheckPrompt({
  attemptNumber,
  limit,
  filterStreak = 1,
  clue = { stage: "request", reason: "provider content filter", attemptedTools: [] },
  redactedTools = [],
  omittedTurnTools = [],
}) {
  const target = clue?.stage === "output" ? "generated reply stream" : "request or reply stream";
  const reason = clue?.reason ?? "provider content filter";
  const lines = [
    `[Auto-Retry Filter Self-Check ${attemptNumber}/${limit}] The previous response did not complete because ${reason} flagged the ${target} (often a false positive on safe coding, security, or biology-related queries).`,
  ];

  if (clue?.stage === "output") {
    const parts = [];
    if (clue.hadThinking) parts.push("reasoning");
    if (clue.hadPartialText) parts.push("visible text");
    if (clue.attemptedTools?.length) parts.push("tool call(s): " + clue.attemptedTools.join(", "));
    lines.push(
      `Diagnosis clue: The conversation context was accepted, and the filter triggered mid-generation (${parts.join(", ")}). Generating the same wording, code literal, or tool arguments verbatim will likely trigger the block again.`,
    );
  } else if (filterStreak > 1) {
    lines.push(
      `Diagnosis clue: Consecutive filter block #${filterStreak}. Either recent context/tool data or the opening tokens of your reply triggered the filter.`,
    );
  }

  if (redactedTools.length) {
    lines.push(
      `Context cleanup: Raw output from recent tool result(s) (${redactedTools.join(", ")}) was replaced with a compact placeholder to clear potential input-filter triggers. Do not reload full raw outputs all at once.`,
    );
  }
  if (omittedTurnTools.length) {
    lines.push(
      `Context cleanup: An earlier tool-call turn (${omittedTurnTools.join(", ")}) in this request was omitted from model context because filter blocks persisted even after redacting tool output. Check current workspace state selectively if needed.`,
    );
  }

  lines.push(
    "Before continuing, inspect the cause and adjust your approach:",
    "1. Check what in the current task, recent tool calls/results, or your planned reply could falsely trip automated filters (such as verbatim exploit/payload literals, raw shell one-liners, encoded blobs, sensitive biological/chemical terms, or large unredacted logs).",
    "2. Keep both internal reasoning and visible text concise, neutral, and technical; avoid quoting or echoing raw sensitive strings inline.",
    "3. When inspecting or modifying files that contain sensitive patterns, read narrow line ranges or use small local filtering/editing steps instead of dumping full raw text into chat.",
    "4. Proceed directly to complete the user's request in the user's language.",
  );

  return lines.join("\n");
}

export function sanitizeMessagesForNativeRetry(messages, filterStreak) {
  const next = messages.slice();
  // Keep only the newest trailing self-check custom message if multiple accumulated during native retries.
  let newestSelfCheck = -1;
  for (let i = next.length - 1; i >= 0; i--) {
    const msg = next[i];
    if (msg.role === "custom" && msg.customType === SELF_CHECK_TYPE) {
      if (newestSelfCheck === -1) newestSelfCheck = i;
      else next.splice(i, 1);
      continue;
    }
    break;
  }

  if (filterStreak >= 2) {
    let steps = filterStreak - 1;
    for (let i = next.length - 1; i >= 0 && steps > 0; i--) {
      if (next[i].role !== "toolResult" || isRedactedToolResult(next[i])) continue;
      let start = i;
      while (start > 0 && next[start - 1].role === "toolResult") start--;
      for (let k = start; k <= i; k++) {
        if (next[k].role === "toolResult" && !isRedactedToolResult(next[k])) {
          next[k] = {
            ...next[k],
            content: [{ type: "text", text: formatRedactedToolResult(next[k]) }],
          };
        }
      }
      steps--;
      i = start;
    }
  }
  return next;
}

// The session keeps its raw transcript. The context edit skips only the failed
// assistant reply on the next request and preserves every completed tool result
// (unless consecutive filter blocks require folding raw tool output).
export function continuation(event, attempt, limit = 10) {
  const info = typeof attempt === "string" ? { targetId: attempt } : attempt;
  const {
    targetId,
    turnToolResultIds = [],
    selfCheck = false,
    filterStreak = 0,
    clue,
    number = 1,
  } = info ?? {};
  if (!targetId || event.outcome !== "error" || event.continue || event.context.pendingMessages.length) return;

  const contextEntries = event.context.contextEntries;
  const failedIds = new Set([targetId, ...turnToolResultIds]);
  const tail = contextEntries.findLast(entry => entry.messages.length);
  if (!tail || !failedIds.has(tail.sourceEntry.id)) return;
  const targetEntry = contextEntries.findLast(entry => entry.sourceEntry.id === targetId);
  if (!targetEntry || targetEntry.messages.at(-1)?.role !== "assistant") return;

  const drafts = [...event.entries];
  for (const id of failedIds) {
    drafts.push({ type: "context_edit", targetId: id, replacement: null });
  }

  if (!selfCheck) {
    return { entries: drafts, continue: true };
  }

  // Omit superseded trailing self-check prompts from earlier failed attempts in this turn.
  for (let i = contextEntries.length - 1; i >= 0; i--) {
    const entry = contextEntries[i];
    if (!entry.messages.length || failedIds.has(entry.sourceEntry.id)) continue;
    if (entry.sourceEntry.type === "custom_message" && entry.sourceEntry.customType === SELF_CHECK_TYPE) {
      drafts.push({ type: "context_edit", targetId: entry.sourceEntry.id, replacement: null });
      failedIds.add(entry.sourceEntry.id);
      continue;
    }
    break;
  }

  let redactedTools = [];
  let omittedTurnTools = [];
  if (filterStreak >= 2) {
    const cleanup = planContextSanitization(contextEntries, failedIds);
    drafts.push(...cleanup.edits);
    redactedTools = cleanup.redactedTools;
    omittedTurnTools = cleanup.omittedTurnTools;
  }

  const content = buildSelfCheckPrompt({
    attemptNumber: number,
    limit,
    filterStreak,
    clue,
    redactedTools,
    omittedTurnTools,
  });

  drafts.push({
    type: "custom_message",
    customType: SELF_CHECK_TYPE,
    content,
    display: true,
    details: {
      attempt: number,
      limit,
      filterStreak,
      stage: clue?.stage ?? "request",
      reason: clue?.reason ?? "provider content filter",
      redactedTools,
      omittedTurnTools,
    },
  });

  return { entries: drafts, continue: true };
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
