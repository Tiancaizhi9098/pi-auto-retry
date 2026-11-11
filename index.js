import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, matchesKey } from "@earendil-works/pi-tui";
import { DEFAULT_LIMIT, parseLimit, readLimit, writeLimit } from "./preferences.js";
import {
  buildSelfCheckPrompt,
  continuation,
  DELAY_MS,
  retryPolicy,
  sanitizeMessagesForNativeRetry,
  SELF_CHECK_TYPE,
  waitForDelay,
} from "./retry.js";
import { renderSelfCheckMessage, retryWidget } from "./widget.js";

const key = "pi-auto-retry";
const isInteractive = mode => mode === "tui" || mode === "interactive";

export default function autoRetry(pi) {
  const path = join(getAgentDir(), "pi-auto-retry.json");
  let limit = DEFAULT_LIMIT;
  let active;
  let nativeUsed = 0;
  let dialogs = 0;

  pi.registerMessageRenderer(SELF_CHECK_TYPE, renderSelfCheckMessage);

  function clearAttempt() {
    const old = active;
    if (!old) return;
    active = undefined;
    old.controller.abort();
    old.offKey?.();
    if (isInteractive(old.ctx.mode)) old.ctx.ui.setWidget(key, undefined);
    if (old.ctx.mode === "rpc") old.ctx.ui.setStatus(key, undefined);
  }

  function reset() {
    clearAttempt();
    nativeUsed = 0;
  }

  function cancel(ctx) {
    if (!active) return false;
    reset();
    ctx.abort();
    ctx.ui.notify("Retries cancelled for this request.", "info");
    return true;
  }

  function show(attempt) {
    const { ctx } = attempt;
    if (ctx.mode === "rpc") {
      const modeLabel = attempt.selfCheck ? "self-check · " : "";
      ctx.ui.setStatus(key, "[" + attempt.number + "/" + limit + "]  " + modeLabel + "/retry cancel");
    }
    if (!isInteractive(ctx.mode)) return;
    const cancelThis = () => active === attempt && cancel(ctx);
    ctx.ui.setWidget(key, (tui, theme) => retryWidget(tui, theme, attempt, () => limit, cancelThis));
    attempt.offKey = ctx.ui.onTerminalInput(data => {
      if (!dialogs && !isKeyRelease(data) && matchesKey(data, "escape") && cancelThis()) return { consume: true };
    });
  }

  pi.on("session_start", (_event, ctx) => {
    reset();
    dialogs = 0;
    try {
      limit = readLimit(path);
    } catch (error) {
      limit = DEFAULT_LIMIT;
      ctx.ui.notify("Could not read retry settings. Using 10 retries. " + error.message, "warning");
    }
  });
  pi.on("session_shutdown", reset);
  pi.on("before_agent_start", reset);
  pi.on("message_start", event => { if (event.message.role === "user") reset(); });
  pi.on("agent_settled", reset);
  pi.on("model_select", (_event, ctx) => { if (active) cancel(ctx); });
  pi.on("ui_prompt_start", () => { dialogs++; });
  pi.on("ui_prompt_end", () => { dialogs = Math.max(0, dialogs - 1); });

  pi.on("agent_start", () => {
    if (!active || active.running) return;
    active.running = true;
    if (active.native) {
      nativeUsed++;
      if (active.selfCheck) {
        const content = buildSelfCheckPrompt({
          attemptNumber: active.number,
          limit,
          filterStreak: active.filterStreak,
          clue: active.clue,
          redactedTools: [],
          omittedTurnTools: [],
        });
        pi.sendMessage({
          customType: SELF_CHECK_TYPE,
          content,
          display: true,
          details: {
            attempt: active.number,
            limit,
            filterStreak: active.filterStreak,
            stage: active.clue?.stage ?? "request",
            reason: active.clue?.reason ?? "provider content filter",
            redactedTools: [],
            omittedTurnTools: [],
          },
        }, { deliverAs: "steer" });
      }
    }
    active.redraw?.();
  });

  pi.on("context", event => {
    if (!active?.running || !active.native || !active.selfCheck) return;
    return { messages: sanitizeMessagesForNativeRetry(event.messages, active.filterStreak) };
  });

  pi.on("turn_end", async (event, ctx) => {
    const policy = retryPolicy(event.message, ctx.model, pi.getSettings().retry, nativeUsed);
    const used = active?.number ?? 0;
    const prevFilterStreak = active?.filterStreak ?? 0;
    const series = active?.series ?? Symbol();
    clearAttempt();
    if (!policy.retry || used >= limit || ctx.signal?.aborted) {
      nativeUsed = 0;
      if (policy.retry && used && used >= limit && !ctx.signal?.aborted) {
        const suffix = policy.providerBlocked ? " The provider blocked this request." : "";
        ctx.ui.notify("Retry limit reached (" + used + "/" + limit + ")." + suffix, "warning");
      }
      if (policy.native && (!policy.retry || used >= limit)) ctx.abort();
      return;
    }

    const attempt = {
      number: used + 1,
      series,
      targetId: event.messageEntryId,
      turnToolResultIds: event.toolResultEntryIds ?? [],
      selfCheck: Boolean(policy.selfCheck),
      filterStreak: policy.selfCheck ? prevFilterStreak + 1 : prevFilterStreak,
      clue: policy.clue,
      ctx,
      native: policy.native,
      running: false,
      controller: new AbortController(),
      deadline: Date.now() + Math.max(DELAY_MS, policy.delay),
    };
    active = attempt;
    show(attempt);
    // Native retries already sleep inside Pi. Wait only for the remainder so
    // the two schedulers share one delay and one allowance.
    const signal = ctx.signal;
    const onAbort = () => { if (active === attempt) reset(); };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      await waitForDelay(Math.max(0, DELAY_MS - policy.delay), attempt.controller.signal);
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  });

  pi.on("agent_before_settle", (event, ctx) => {
    // If Pi expected a native retry but reached settlement, its own countdown
    // was cancelled. Only complete attempts which Pi handed back to us.
    if (!active || active.native || active.running || ctx.hasPendingMessages()) return;
    nativeUsed = 0;
    return continuation(event, active, limit);
  });

  function setLimit(value, ctx) {
    const next = parseLimit(value);
    if (next === undefined) {
      ctx.ui.notify("Enter a whole number of 0 or more, for example /retry 5.", "warning");
      return;
    }
    try {
      writeLimit(path, next);
    } catch (error) {
      ctx.ui.notify("Could not save the retry limit. " + error.message, "error");
      return;
    }
    limit = next;
    if (active && active.number > limit) cancel(ctx);
    else if (active?.ctx.mode === "rpc") show(active);
    else active?.redraw?.();
    ctx.ui.notify(limit ? "Retry limit saved (" + limit + ")." : "Automatic retries are off.", "info");
  }

  pi.registerCommand("retry", {
    description: "Auto-retry settings and cancellation",
    handler: async (args, ctx) => {
      const input = args.trim();
      if (input === "cancel") {
        if (!cancel(ctx)) ctx.ui.notify("No retry in progress.", "info");
        return;
      }
      if (input) return setLimit(input, ctx);
      const title = "Auto-retry · Limit " + limit + " · Interval 10s";
      if (!ctx.hasUI) return ctx.ui.notify(title + ". Use /retry 5 to change the limit.", "info");
      const options = ["Set retry limit"];
      const series = active?.series;
      if (active) options.push("Cancel retries for this request");
      const selected = await ctx.ui.select(title, options);
      if (selected === "Cancel retries for this request" && active?.series === series) cancel(ctx);
      if (selected !== options[0]) return;
      const value = await ctx.ui.input("Retry limit (0 turns retries off)", String(limit));
      if (value !== undefined) setLimit(value, ctx);
    },
  });
}
