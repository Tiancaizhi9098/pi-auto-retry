# Pi Auto Retry

Retry interrupted model requests in ordinary Pi conversations. The default is **10 retries**, with **10 seconds** between attempts. The original request is separate from that allowance.

## Install

~~~sh
pi install git:github.com/Tiancaizhi9098/pi-auto-retry
~~~

Run `/reload` in an open Pi session. Requires Pi 1.5.2 or later in the 1.x series.

## Cancel a retry

~~~text
[1/10]  [Cancel]  Retrying in 10s · Esc
~~~

Click **[Cancel]** in Pi's fullscreen terminal, press **Esc**, or enter `/retry cancel`. This stops the current retry series, including an attempt already in progress. The next request gets a fresh allowance. In terminals using regular scrollback mode, use **Esc** or the command.

## Change the limit

Enter `/retry`, choose **Set retry limit**, type a whole number, and press **Enter**. You can also type `/retry 5` directly. The limit applies immediately and is saved in `pi-auto-retry.json` in Pi's agent directory for future sessions. Use `/retry 0` to turn automatic retries off and `/retry 10` to restore the default.

## What gets retried

The extension handles network disconnects, timeouts, temporary rate limits and server errors, including an HTTP 200 stream that ends with `Antigravity: the reply ended before it was complete`. Exhausted quota and invalid credentials end the request immediately.

When a reply is blocked by Gemini or provider content filters (for example `This request was blocked by Gemini's filters...` followed by `Antigravity: the reply ended before it was complete`, or a `SAFETY` / `PROHIBITED_CONTENT` / `content_filter` stop reason), Pi does **not** blindly resend the identical request:

1. **Tactical self-check (no prompt accumulation):** Omits the blocked assistant reply and injects a visible `[Auto-Retry · Filter Self-Check]` instruction guiding the model to keep internal reasoning brief/abstract and replace large verbatim `edit`/`write` JSON blocks with small anchors or concise scripted updates. Once a turn succeeds, old self-check prompts are automatically omitted from future model context so they never pile up.
2. **Automatic neutral engineering compaction & smart folding:** When a long uncompacted transcript (>100 KB, or >32 KB on repeated filter blocks) poisons the stream filter, Pi compacts older history into a clean, deterministic software-engineering summary (preserving user goals and modified/inspected file lists) while keeping recent small clean working snippets intact so the model does not get stuck re-reading the same file in a loop. On already-compact contexts, older or high-risk `toolResult` batches are folded before recent small snippets.
3. Shares the configured `/retry` limit, 10-second countdown, and `[Cancel]` / `Esc` / `/retry cancel` controls.

Pi continues from the failed model call. Completed tool results stay in the conversation. Pi's built-in agent retries count towards the same limit. With default Pi settings, retries start at ten-second intervals. If you manually configured longer Pi agent backoff, set `retry.maxAgentDelayMs` to `10000` in Pi's settings to use the same interval.

The extension runs independently of Goal mode. If you previously installed the separate `pi-goal-retry` fork, use a single retry extension for the session to avoid two independent retry loops.
