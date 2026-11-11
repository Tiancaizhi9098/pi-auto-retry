import { isContextOverflow, isRetryableAssistantError } from "@earendil-works/pi-ai/compat";

export const DELAY_MS = 10_000;
export const SELF_CHECK_TYPE = "pi-auto-retry";
export const REDACTED_TOOL_PREFIX = "[pi-auto-retry: raw tool output omitted";

const COMPACT_IMMEDIATE_CHARS = 100_000;
const COMPACT_ESCALATED_CHARS = 32_000;
const COMPACT_ESCALATED_ENTRIES = 24;
const KEEP_RECENT_TURNS = 3;
const KEEP_MAX_CHARS = 14_000;
const KEPT_LARGE_TOOL_CHARS = 6_000;

const disconnected = /\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|UND_ERR_SOCKET|ERR_STREAM_PREMATURE_CLOSE|unexpected EOF)\b|\bthe reply ended before it was complete\b|\bconnection lost mid-reply\b/i;
const filterError = /\b(?:content[_ -]?filter(?:ed)?|content[_ -]?policy[_ -]?violation|prompt[_ -]?blocked|PROHIBITED_CONTENT|FINISH_REASON_SAFETY|Provider stopped with:\s*sensitive)\b/i;
const authOrQuota = /\b(?:unauthorized|forbidden|invalid[_ -]?api[_ -]?key|authentication[_ -]?error|insufficient[_ -]?quota|quota (?:exceeded|reached)|increase your limits|upgrade your subscription|billing|out of budget)\b|(?:^|\bHTTP\s+)(?:401|403)\b/i;
const badRequest = /\b(?:invalid[_ -]?request(?:[_ -]?error)?)\b|(?:^|\bHTTP\s+)400\b/i;
const terminalReason = /^(?:safety|content_filter|prohibited_content|blocklist|recitation|spii|image_safety|image_prohibited_content|image_recitation|sensitive|refusal)$/i;
const rejectionBanner = /(?:^|[\s"'`])(?:this |your |the )?request (?:was|has been) blocked by .{0,80}\b(?:filters?|safety polic(?:y|ies))\b/i;
const stripBanner = /(?:this |your |the )?request (?:was|has been) blocked by [\s\S]*$/i;
const highRiskToolPattern = /\b(?:qword ptr|dword ptr|byte ptr|gs:\[|fs:\[|VirtualAllocEx|WriteProcessMemory|CreateRemoteThread|NtMapViewOfSection|ZwMapViewOfSection|MmTls|IMAGE_NT_HEADERS)\b/i;

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

function extractMessageText(message) {
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .map(part => {
      if (part.type === "text") return part.text ?? "";
      if (part.type === "thinking") return part.thinking ?? "";
      if (part.type === "toolCall") return JSON.stringify(part.arguments ?? {});
      return "";
    })
    .join("\n");
}

function estimateEntryChars(entry) {
  return (entry.messages ?? []).reduce((sum, msg) => sum + extractMessageText(msg).length, 0);
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
  return `${REDACTED_TOOL_PREFIX} (${stats}) after provider stream filter interruptions. Re-inspect only narrow line slices if strictly needed.]`;
}

function sanitizeUserSnippet(raw) {
  const goalMatch = raw.match(/<goal_objective>([\s\S]*?)<\/goal_objective>/i);
  const source = goalMatch ? goalMatch[1] : raw;
  const cleaned = source
    .replace(/```[\s\S]*?```/g, "[code block]")
    .replace(/\b0x[0-9a-fA-F]{6,}\b/g, "[hex]")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "";
  return cleaned.length > 220 ? cleaned.slice(0, 217) + "..." : cleaned;
}

export function buildNeutralEngineeringSummary(entries) {
  const userPrompts = [];
  const modifiedFiles = new Set();
  const readFiles = new Set();
  let commandRuns = 0;

  for (const entry of entries) {
    const rawMsg = entry.sourceEntry?.type === "message" ? entry.sourceEntry.message : undefined;
    const candidates = entry.messages?.length ? entry.messages : (rawMsg ? [rawMsg] : []);
    for (const msg of candidates) {
      if (msg.role === "user") {
        const text = typeof msg.content === "string"
          ? msg.content
          : (msg.content ?? []).filter(p => p.type === "text").map(p => p.text ?? "").join(" ");
        const snippet = sanitizeUserSnippet(text);
        if (snippet && userPrompts.at(-1) !== snippet) {
          userPrompts.push(snippet);
        }
      } else if (msg.role === "assistant" && msg.stopReason !== "error" && msg.stopReason !== "aborted" && Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type !== "toolCall") continue;
          const filePath = typeof part.arguments?.path === "string" ? part.arguments.path : undefined;
          if (part.name === "write" || part.name === "edit") {
            if (filePath) modifiedFiles.add(filePath);
          } else if (part.name === "read") {
            if (filePath) readFiles.add(filePath);
          } else if (part.name === "bash" || part.name === "powershell") {
            commandRuns++;
          }
        }
      }
    }
  }

  const keepIndices = new Set();
  if (userPrompts.length > 0) keepIndices.add(0);
  const substantive = userPrompts
    .map((text, idx) => ({ text, idx }))
    .filter(item => item.text.length >= 8);
  for (const item of substantive.slice(-2)) keepIndices.add(item.idx);
  for (let i = Math.max(0, userPrompts.length - 2); i < userPrompts.length; i++) keepIndices.add(i);
  const selectedPrompts = [...keepIndices].sort((a, b) => a - b).map(idx => userPrompts[idx]);

  const lines = [
    "Earlier conversation history was compacted into a neutral software-engineering summary to prevent false-positive stream filter interruptions:",
  ];
  if (selectedPrompts.length) {
    lines.push("- User task history:");
    for (const p of selectedPrompts) lines.push("  - " + p);
  }
  if (modifiedFiles.size) {
    lines.push("- Files already created or modified on disk (changes are persisted): " + [...modifiedFiles].slice(-25).join(", "));
  }
  const readOnly = [...readFiles].filter(f => !modifiedFiles.has(f));
  if (readOnly.length) {
    lines.push("- Files previously inspected: " + readOnly.slice(-25).join(", "));
  }
  if (commandRuns > 0) {
    lines.push(`- Completed build/diagnostic command runs in earlier turns: ${commandRuns}`);
  }
  lines.push("- Continue from the retained recent context below; inspect narrow file slices on disk only when needed.");
  return lines.join("\n");
}

function selectCompactionKeepStart(surviving) {
  let turns = 0;
  let chars = 0;
  let keepStart = surviving.length;

  for (let i = surviving.length - 1; i >= 0; i--) {
    const role = surviving[i].messages[0]?.role;
    const size = estimateEntryChars(surviving[i]);
    if (role === "toolResult") {
      chars += size;
      continue;
    }
    if (role === "assistant" || role === "user") {
      if (turns >= KEEP_RECENT_TURNS || (turns >= 1 && chars + size > KEEP_MAX_CHARS)) {
        break;
      }
      if (chars + size > KEEP_MAX_CHARS * 2) {
        break;
      }
      chars += size;
      turns++;
      keepStart = i;
    }
  }

  // Never start on a toolResult without its paired assistant message.
  while (keepStart < surviving.length && surviving[keepStart].messages[0]?.role === "toolResult") {
    keepStart++;
  }
  return keepStart;
}

function collectToolBatches(surviving) {
  const batches = [];
  let i = 0;
  while (i < surviving.length) {
    const msg = surviving[i].messages[0];
    if (surviving[i].sourceEntry.type !== "message" || msg?.role !== "toolResult") {
      i++;
      continue;
    }
    const start = i;
    while (i < surviving.length && surviving[i].messages[0]?.role === "toolResult") i++;
    const entries = surviving.slice(start, i).filter(
      e => e.sourceEntry.type === "message" && e.messages[0]?.role === "toolResult" && !isRedactedToolResult(e.messages[0]),
    );
    if (entries.length) {
      const text = entries.map(e => extractMessageText(e.messages[0])).join("\n");
      batches.push({
        entries,
        chars: text.length,
        highRisk: highRiskToolPattern.test(text),
      });
    }
  }
  return batches;
}

function redactBatch(batch) {
  const edits = [];
  const redactedTools = [];
  for (const entry of batch.entries) {
    const toolMsg = entry.messages[0];
    edits.push({
      type: "context_edit",
      targetId: entry.sourceEntry.id,
      replacement: { content: [{ type: "text", text: formatRedactedToolResult(toolMsg) }] },
    });
    if (toolMsg.toolName && !redactedTools.includes(toolMsg.toolName)) {
      redactedTools.push(toolMsg.toolName);
    }
  }
  return { edits, redactedTools };
}

export function planContextRecovery(contextEntries, ignoredIds = new Set(), { filterHeat = 1 } = {}) {
  const surviving = contextEntries.filter(entry => entry.messages.length > 0 && !ignoredIds.has(entry.sourceEntry.id));
  const totalChars = surviving.reduce((sum, entry) => sum + estimateEntryChars(entry), 0);

  // Tier 2: Compact bloated transcript history so accumulated code/logs stop poisoning the stream filter,
  // while keeping recent clean working context intact.
  const shouldCompact = (filterHeat >= 1 && totalChars > COMPACT_IMMEDIATE_CHARS)
    || (filterHeat >= 2 && (totalChars > COMPACT_ESCALATED_CHARS || surviving.length > COMPACT_ESCALATED_ENTRIES));

  if (shouldCompact && surviving.length > 1) {
    const keepStart = selectCompactionKeepStart(surviving);
    if (keepStart > 0) {
      const kept = surviving.slice(keepStart);
      const firstKeptEntryId = kept[0]?.sourceEntry.id ?? null;
      const firstKeptRawIdx = firstKeptEntryId
        ? contextEntries.findIndex(e => e.sourceEntry.id === firstKeptEntryId)
        : contextEntries.length;
      const rawDropped = firstKeptRawIdx > 0 ? contextEntries.slice(0, firstKeptRawIdx) : surviving.slice(0, keepStart);
      const summary = buildNeutralEngineeringSummary(rawDropped);
      const retainedRangeIds = new Set(
        firstKeptRawIdx >= 0
          ? contextEntries.slice(firstKeptRawIdx).map(e => e.sourceEntry.id)
          : [],
      );
      const postCompactionEdits = [];
      const redactedTools = [];

      // Within the small kept window, fold only oversized or high-risk raw tool outputs;
      // preserve small benign target file snippets so the model doesn't have to re-read them.
      for (const entry of kept) {
        const msg = entry.messages[0];
        if (entry.sourceEntry.type !== "message" || msg?.role !== "toolResult" || isRedactedToolResult(msg)) continue;
        const text = extractMessageText(msg);
        if (text.length > KEPT_LARGE_TOOL_CHARS || highRiskToolPattern.test(text)) {
          postCompactionEdits.push({
            type: "context_edit",
            targetId: entry.sourceEntry.id,
            replacement: { content: [{ type: "text", text: formatRedactedToolResult(msg) }] },
          });
          if (msg.toolName && !redactedTools.includes(msg.toolName)) redactedTools.push(msg.toolName);
        }
      }

      return {
        compaction: { type: "compaction", summary, firstKeptEntryId },
        retainedRangeIds,
        edits: postCompactionEdits,
        compacted: true,
        redactedTools,
        omittedTurnTools: [],
      };
    }
  }

  if (filterHeat < 2) {
    return { edits: [], compacted: false, redactedTools: [], omittedTurnTools: [] };
  }

  // Tier 3: Already-compact context with repeated filter blocks.
  // If multiple unredacted tool batches exist and the newest one is a small clean snippet,
  // fold the older/riskier batch first so we don't blind the model on the file it just read.
  const batches = collectToolBatches(surviving);
  if (batches.length > 0) {
    let chosen = batches.at(-1);
    if (batches.length >= 2 && chosen.chars <= 4_000 && !chosen.highRisk) {
      chosen = batches.at(-2);
    }
    const { edits, redactedTools } = redactBatch(chosen);
    return { edits, compacted: false, redactedTools, omittedTurnTools: [] };
  }

  // Tier 4: All toolResults are already folded, yet blocks still persist — omit the offending
  // assistant tool-call turn + its paired toolResults together (e.g. flagged write/edit arguments).
  const lastUserIdx = surviving.findLastIndex(entry => entry.messages.some(msg => msg.role === "user"));
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
    return { edits, compacted: false, redactedTools: [], omittedTurnTools };
  }

  return { edits: [], compacted: false, redactedTools: [], omittedTurnTools: [] };
}

export function buildSelfCheckPrompt({
  attemptNumber,
  limit,
  filterHeat = 1,
  clue = { stage: "request", reason: "provider content filter", attemptedTools: [] },
  compacted = false,
  redactedTools = [],
  omittedTurnTools = [],
}) {
  const target = clue?.stage === "output" ? "generated reply stream" : "request or reply stream";
  const reason = clue?.reason ?? "provider content filter";
  const lines = [
    `[Auto-Retry Filter Self-Check ${attemptNumber}/${limit}] Previous turn was interrupted by ${reason} on the ${target} (false positive on systems, compiler, or security-adjacent code).`,
  ];

  if (clue?.stage === "output") {
    const parts = [];
    if (clue.hadThinking) parts.push("internal reasoning");
    if (clue.hadPartialText) parts.push("visible text");
    if (clue.attemptedTools?.length) parts.push("tool call: " + clue.attemptedTools.join(", "));
    lines.push(
      `Diagnosis: Input context was accepted; the cutoff happened mid-generation (${parts.join(", ")}). Emitting the same reasoning or verbatim multi-line tool arguments again will trigger the same cutoff.`,
    );
  } else if (filterHeat > 1) {
    lines.push(
      `Diagnosis: Repeated filter interruption (level ${filterHeat}). Keep both context reads and generated output minimal and abstract.`,
    );
  }

  if (compacted) {
    lines.push(
      "Context cleanup: Earlier verbose transcript history was compacted into a neutral engineering summary so accumulated low-level code/logs no longer trip the stream filter. All prior file edits remain on disk.",
    );
  }
  if (redactedTools.length) {
    lines.push(
      `Context cleanup: Raw output from tool result(s) (${redactedTools.join(", ")}) was replaced with a compact placeholder. Only re-read narrow line slices if strictly needed.`,
    );
  }
  if (omittedTurnTools.length) {
    lines.push(
      `Context cleanup: An earlier tool-call turn (${omittedTurnTools.join(", ")}) was omitted from context because interruptions persisted; verify file state selectively if needed.`,
    );
  }

  lines.push(
    "Required adjustments for this retry:",
    "1. Keep internal reasoning (`thinking`) to 1-2 short, abstract sentences about module/build structure; avoid low-level register, instruction, memory-layout, or service terminology in reasoning.",
    "2. Avoid large verbatim `edit` or `write` tool calls (repeating multi-line `oldText`/`newText` code blocks in JSON frequently trips stream filters mid-call). Prefer a tiny 2-4 line `edit` anchor, or run a short Python script via `bash` that updates target lines programmatically without echoing large code blocks inline.",
    "3. Do not re-read files whose relevant lines are already visible in recent context—apply the needed change directly and continue in the user's language.",
  );

  return lines.join("\n");
}

export function collectStaleSelfCheckEdits(contextEntries) {
  return contextEntries
    .filter(
      entry => entry.messages.length > 0
        && entry.sourceEntry.type === "custom_message"
        && entry.sourceEntry.customType === SELF_CHECK_TYPE,
    )
    .map(entry => ({ type: "context_edit", targetId: entry.sourceEntry.id, replacement: null }));
}

export function pruneRuntimeMessages(messages, { nativeSelfCheck = false, filterHeat = 0 } = {}) {
  let changed = false;
  const lastIdx = messages.length - 1;
  const next = [];

  // Keep a SELF_CHECK_TYPE custom message ONLY when it is the active trailing prompt of the retry;
  // strip any older accumulated self-check messages from legacy/uncleaned turns.
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === "custom" && msg.customType === SELF_CHECK_TYPE && i !== lastIdx) {
      changed = true;
      continue;
    }
    next.push(msg);
  }

  if (nativeSelfCheck && filterHeat >= 2) {
    for (let i = next.length - 1; i >= 0; i--) {
      if (next[i].role !== "toolResult" || isRedactedToolResult(next[i])) continue;
      let start = i;
      while (start > 0 && next[start - 1].role === "toolResult") start--;
      for (let k = start; k <= i; k++) {
        if (next[k].role === "toolResult" && !isRedactedToolResult(next[k])) {
          next[k] = {
            ...next[k],
            content: [{ type: "text", text: formatRedactedToolResult(next[k]) }],
          };
          changed = true;
        }
      }
      break;
    }
  }

  return changed ? next : undefined;
}

export function continuation(event, attempt, limit = 10) {
  const info = typeof attempt === "string" ? { targetId: attempt } : attempt;
  const {
    targetId,
    turnToolResultIds = [],
    selfCheck = false,
    filterHeat = 1,
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

  if (!selfCheck) {
    const drafts = [...event.entries];
    for (const id of failedIds) {
      drafts.push({ type: "context_edit", targetId: id, replacement: null });
    }
    return { entries: drafts, continue: true };
  }

  // Omit EVERY earlier SELF_CHECK_TYPE custom_message anywhere in active context so they never accumulate.
  const staleSelfCheckIds = new Set();
  for (const entry of contextEntries) {
    if (
      entry.messages.length > 0
      && entry.sourceEntry.type === "custom_message"
      && entry.sourceEntry.customType === SELF_CHECK_TYPE
    ) {
      staleSelfCheckIds.add(entry.sourceEntry.id);
    }
  }

  const ignoredIds = new Set([...failedIds, ...staleSelfCheckIds]);
  const cleanup = planContextRecovery(contextEntries, ignoredIds, { filterHeat });
  const drafts = [...event.entries];

  if (cleanup.compaction) {
    drafts.push(cleanup.compaction);
    // If firstKeptEntryId is non-null, entries in [firstKeptEntryId..leaf] remain in buildContextEntries(),
    // so omit failedIds and any stale self-check prompts inside that retained range.
    if (cleanup.compaction.firstKeptEntryId !== null) {
      for (const id of failedIds) {
        if (!cleanup.retainedRangeIds || cleanup.retainedRangeIds.has(id)) {
          drafts.push({ type: "context_edit", targetId: id, replacement: null });
        }
      }
      for (const id of staleSelfCheckIds) {
        if (cleanup.retainedRangeIds?.has(id)) {
          drafts.push({ type: "context_edit", targetId: id, replacement: null });
        }
      }
    }
  } else {
    for (const id of failedIds) {
      drafts.push({ type: "context_edit", targetId: id, replacement: null });
    }
    for (const id of staleSelfCheckIds) {
      drafts.push({ type: "context_edit", targetId: id, replacement: null });
    }
  }

  drafts.push(...cleanup.edits);

  const content = buildSelfCheckPrompt({
    attemptNumber: number,
    limit,
    filterHeat,
    clue,
    compacted: cleanup.compacted,
    redactedTools: cleanup.redactedTools,
    omittedTurnTools: cleanup.omittedTurnTools,
  });

  drafts.push({
    type: "custom_message",
    customType: SELF_CHECK_TYPE,
    content,
    display: true,
    details: {
      attempt: number,
      limit,
      filterHeat,
      stage: clue?.stage ?? "request",
      reason: clue?.reason ?? "provider content filter",
      compacted: cleanup.compacted,
      redactedTools: cleanup.redactedTools,
      omittedTurnTools: cleanup.omittedTurnTools,
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
