import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setImmediate as nextFrame } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const { AuthStorage } = await import(new URL("./core/auth-storage.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
const entry = process.env.PI_AUTO_RETRY_TEST_ENTRY || fileURLToPath(new URL("../index.js", import.meta.url));
const truncated = "Antigravity: the reply ended before it was complete";
const geminiFilterBanner = "This request was blocked by Gemini's filters. They can occasionally trigger by mistake on safe coding, security, or biology-related queries. Please try rephrasing your prompt. You can send feedback or read more about our policies here.";
const failure = (errorMessage, content = []) => ({ stopReason: "error", errorMessage, content });
const success = { stopReason: "stop", content: [{ type: "text", text: "done" }] };
const turn = () => nextFrame();

async function until(predicate) {
  for (let n = 0; n < 1000 && !predicate(); n++) await turn();
  assert.ok(predicate(), "Pi did not reach the expected state");
}

async function openSession(t, options = {}) {
  const dir = options.dir ?? await mkdtemp(join(tmpdir(), "pi-auto-retry-test-"));
  const oldDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: options.native });
  const runtime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null, refreshOnCreate: false, modelsStorePath: join(dir, "models-cache.json") });
  runtime.registerProvider("retry-test", {
    api: "openai-completions", baseUrl: options.baseUrl ?? "http://127.0.0.1:1/unused", apiKey: "offline",
    models: [{ id: "mock", name: "Mock", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
  });
  const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager, noExtensions: true,
    additionalExtensionPaths: [entry], noSkills: true, noThemes: true, noContextFiles: true, noPromptTemplates: true });
  await loader.reload();
  const { session, extensionsResult } = await createAgentSession({ cwd: dir, agentDir: dir, resourceLoader: loader,
    modelRuntime: runtime, model: runtime.getModel("retry-test", "mock"), settingsManager,
    sessionManager: SessionManager.inMemory(dir), noTools: "builtin", customTools: options.tools });
  assert.deepEqual(extensionsResult.errors, []);
  assert.ok(extensionsResult.extensions.some(ext => ext.commands.has("retry")));
  const state = { dir, session, calls: [], nativeStarts: [], notices: [], menus: [], errors: [], reply: () => failure(truncated) };
  const theme = { fg: (_color, text) => text };
  const ui = {
    setWidget(_key, factory) {
      state.widget?.dispose();
      state.widget = factory?.({ requestRender() {} }, theme);
    },
    onTerminalInput(fn) { state.key = fn; return () => { state.key = undefined; }; },
    notify(text) { state.notices.push(text); },
    async select(title, items) { state.menus.push({ title, items }); return state.choose?.(items); },
    async input() { return state.enter; },
  };
  await session.bindExtensions({ mode: options.mode ?? "tui", uiContext: ui, onError: error => state.errors.push(error) });
  session.subscribe(event => { if (event.type === "auto_retry_start") state.nativeStarts.push(event); });
  const mockStream = (model, context, streamOptions) => {
    state.calls.push({ time: Date.now(), messages: structuredClone(context.messages) });
    const stream = createAssistantMessageEventStream();
    queueMicrotask(async () => {
      const response = await state.reply(state.calls.length, streamOptions.signal);
      const message = {
        role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        ...response,
      };
      if (response.stopReason === "error" || response.stopReason === "aborted") stream.push({ type: "error", reason: response.stopReason, error: message });
      else stream.push({ type: "done", reason: response.stopReason, message });
      stream.end();
    });
    return stream;
  };
  if (!options.baseUrl) session.agent.streamFunction = mockStream;
  t.after(async () => {
    await session.abort();
    session.dispose();
    if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldDir;
    if (!options.dir) await rm(dir, { recursive: true, force: true });
    assert.deepEqual(state.errors, []);
  });
  state.row = () => state.widget?.render(80)[0] ?? "";
  return state;
}

function clock(t) {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 100000 });
  return async ms => {
    // Flush the host's async continuations when the extension hands the timer to Pi.
    while (ms > 0) {
      const step = Math.min(ms, 1000);
      t.mock.timers.tick(step);
      for (let n = 0; n < 4; n++) await turn();
      ms -= step;
    }
  };
}

for (const [label, error] of [["stream cut off", truncated], ["native 503", "HTTP 503 Service Unavailable"]]) {
  test(label + " retries once per 10 seconds and stops at ten", async t => {
    const s = await openSession(t);
    s.reply = () => failure(error);
    const tick = clock(t);
    const done = s.session.prompt("Update the UI");
    for (let n = 1; n <= 10; n++) {
      await until(() => s.row().includes("[" + n + "/10]"));
      assert.match(s.row(), /\[Cancel\].*Retrying in 10s/);
      assert.equal(s.calls.length, n);
      await tick(9999);
      assert.equal(s.calls.length, n);
      await tick(1);
    }
    await done;
    assert.equal(s.calls.length, 11);
    assert.equal(s.row(), "");
    assert.deepEqual(s.calls.map(call => call.time - s.calls[0].time), Array.from({ length: 11 }, (_, i) => i * 10000));
    assert.ok(s.calls.every(call => call.messages.filter(m => m.role === "user").length === 1));
    if (label === "native 503") assert.ok(s.nativeStarts.length > 0);
    await tick(20000);
    assert.equal(s.calls.length, 11);
  });
}

test("menu persists the limit, updates a live countdown, and survives a restart", async t => {
  const s = await openSession(t);
  s.choose = items => items[0];
  s.enter = "3";
  await s.session.prompt("/retry");
  assert.match(s.menus[0].title, /Limit 10/);
  assert.equal(JSON.parse(await readFile(join(s.dir, "pi-auto-retry.json"))).maxRetries, 3);
  const reopened = await openSession(t, { dir: s.dir });
  const tick = clock(t);
  const done = reopened.session.prompt("normal conversation");
  await until(() => reopened.row().includes("[1/3]"));
  reopened.choose = items => items[0];
  reopened.enter = "1";
  await reopened.session.prompt("/retry");
  assert.ok(reopened.menus[0].items.includes("Cancel retries for this request"));
  assert.match(reopened.row(), /\[1\/1\]/);
  await tick(10000);
  await done;
  assert.equal(reopened.calls.length, 2);
  await reopened.session.prompt("/retry -1");
  assert.equal(JSON.parse(await readFile(join(s.dir, "pi-auto-retry.json"))).maxRetries, 1);
  await reopened.session.prompt("/retry 0");
  reopened.reply = () => failure("503 Service Unavailable");
  await reopened.session.prompt("one request");
  assert.equal(reopened.calls.length, 3);
});

test("button, Escape, and /retry cancel stop only the current series", async t => {
  const s = await openSession(t, { native: { baseDelayMs: 10000, maxAgentDelayMs: 10000 } });
  s.reply = () => failure("503 Service Unavailable");
  const tick = clock(t);
  for (const action of ["mouse", "key", "command", "native-abort"]) {
    const before = s.calls.length;
    const done = s.session.prompt("next conversation turn");
    await until(() => s.session.isRetrying && s.row().includes("[1/10]"));
    if (action === "mouse") {
      const click = { type: "click", button: "left", x: 1, y: 0 };
      assert.equal(s.widget.handleMouse(click), undefined);
      assert.equal(s.widget.handleMouse({ ...click, x: 10 })?.handled, true);
    }
    if (action === "key") assert.equal(s.key("\x1b")?.consume, true);
    if (action === "command") await s.session.prompt("/retry cancel");
    if (action === "native-abort") s.session.abortRetry();
    await done;
    await tick(20000);
    assert.equal(s.calls.length, before + 1);
    assert.equal(s.widget, undefined);
    assert.equal(s.key, undefined);
  }
});

test("fallback cancellation immediately stops its wait and leaves the next request enabled", async t => {
  const s = await openSession(t);
  const tick = clock(t);
  const done = s.session.prompt("first");
  await until(() => s.row().includes("[1/10]"));
  assert.equal(s.key("\x1b")?.consume, true);
  await done;
  await tick(10000);
  assert.equal(s.calls.length, 1);
  s.reply = () => success;
  await s.session.prompt("second");
  assert.equal(s.calls.length, 2);
});

test("Cancel can interrupt a retry after the provider request has started", async t => {
  const s = await openSession(t);
  let aborted = false;
  s.reply = (n, signal) => n === 1 ? failure(truncated) : new Promise(resolve => {
    signal.addEventListener("abort", () => {
      aborted = true;
      resolve({ stopReason: "aborted", content: [] });
    }, { once: true });
  });
  const tick = clock(t);
  const done = s.session.prompt("normal request");
  await until(() => s.row().includes("[1/10]"));
  await tick(10000);
  await until(() => s.calls.length === 2);
  assert.match(s.row(), /\[Cancel\]  Retrying · Esc/);
  await s.session.prompt("/retry cancel");
  await done;
  assert.ok(aborted);
  await tick(20000);
  assert.equal(s.calls.length, 2);
});

test("Escape inside the menu can dismiss the menu without cancelling its pending retry", async t => {
  const s = await openSession(t);
  s.reply = n => n === 1 ? failure(truncated) : success;
  const tick = clock(t);
  const done = s.session.prompt("normal request");
  await until(() => s.row().includes("[1/10]"));
  let dismiss;
  s.choose = () => new Promise(resolve => { dismiss = resolve; });
  const menu = s.session.prompt("/retry");
  await until(() => Boolean(dismiss));
  await turn();
  assert.equal(s.key("\x1b"), undefined);
  dismiss(undefined);
  await menu;
  await tick(10000);
  await done;
  assert.equal(s.calls.length, 2);
});

test("a successful tool call is preserved when the next model stream fails", async t => {
  let executions = 0;
  const tool = { name: "record", label: "Record", description: "Record once", parameters: Type.Object({}),
    async execute() { executions++; return { content: [{ type: "text", text: "recorded" }], details: {} }; } };
  const s = await openSession(t, { tools: [tool] });
  const partial = "unfinished text";
  s.reply = n => n === 1 ? { stopReason: "toolUse", content: [{ type: "toolCall", id: "call1", name: "record", arguments: {} }] }
    : n === 2 ? failure(truncated, [{ type: "text", text: partial }]) : success;
  const tick = clock(t);
  const done = s.session.prompt("Record a change");
  await until(() => s.row().includes("[1/10]"));
  await tick(10000);
  await done;
  assert.equal(executions, 1);
  assert.equal(s.calls.length, 3);
  const last = s.calls.at(-1).messages;
  assert.equal(last.filter(m => m.role === "user").length, 1);
  assert.equal(last.at(-1).role, "toolResult");
  assert.equal(last.at(-1).toolCallId, "call1");
  assert.ok(!JSON.stringify(last).includes(partial));
  assert.equal(s.widget, undefined);
});

test("credentials, quota, invalid schema requests, and success settle immediately", async t => {
  const s = await openSession(t);
  const before = s.calls.length;
  for (const message of [
    failure("HTTP 401 invalid API key, connection error"),
    failure("429 insufficient_quota"),
    failure("429: Antigravity: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 2h. (429: you can retry your request)"),
    failure("HTTP 400 invalid_request_error: missing required field"),
    success,
  ]) {
    s.reply = () => message;
    await s.session.prompt("normal request");
    assert.equal(s.row(), "");
  }
  assert.equal(s.calls.length, before + 5);
  assert.equal(s.nativeStarts.length, 0);
});

test("Gemini filter + Antigravity cutoff injects a visible self-check prompt before retrying", async t => {
  const s = await openSession(t);
  const sensitiveDraft = "RAW_SENSITIVE_DRAFT_SNIPPET";
  s.reply = n => n === 1
    ? failure(truncated, [
      { type: "thinking", thinking: sensitiveDraft },
      { type: "text", text: geminiFilterBanner },
    ])
    : success;
  const tick = clock(t);
  const done = s.session.prompt("Audit the auth parser");
  await until(() => s.row().includes("[1/10]"));
  assert.match(s.row(), /\[Cancel\].*Filter blocked · self-check in 10s · Esc/);
  await tick(10000);
  await done;

  assert.equal(s.calls.length, 2);
  const retryMessages = s.calls[1].messages;
  const serialized = JSON.stringify(retryMessages);
  // Neither the blocked banner nor raw draft thinking is echoed back into context.
  assert.ok(!serialized.includes("blocked by Gemini's filters"));
  assert.ok(!serialized.includes(sensitiveDraft));
  // Model receives a self-check instruction diagnosing the mid-generation output filter.
  const selfCheckMsg = retryMessages.at(-1);
  assert.equal(selfCheckMsg.role, "user");
  const selfCheckText = JSON.stringify(selfCheckMsg.content);
  assert.match(selfCheckText, /Auto-Retry Filter Self-Check 1\/10/);
  assert.match(selfCheckText, /Gemini's content filter/);
  assert.match(selfCheckText, /mid-generation \(internal reasoning\)/);

  // Persisted as a visible custom_message in session history, and omitted from future model context once recovered.
  const customEntries = s.session.sessionManager.getBranch().filter(e => e.type === "custom_message" && e.customType === "pi-auto-retry");
  assert.equal(customEntries.length, 1);
  assert.equal(customEntries[0].display, true);

  await s.session.prompt("Follow-up request");
  assert.equal(s.calls.length, 3);
  assert.ok(!JSON.stringify(s.calls[2].messages).includes("Auto-Retry Filter Self-Check"));
});

test("bloated uncompacted history compacts on filter block while keeping recent clean tool snippets intact", async t => {
  const bigDump = "OLD_LOW_LEVEL_TRACE_LINE\n".repeat(5000); // ~125 KB
  const cleanSnippet = "def compile_cpp(sources, output):\n    return output\n";
  let callNum = 0;
  const readTool = {
    name: "read",
    label: "Read",
    description: "Read file",
    parameters: Type.Object({ path: Type.String() }),
    async execute(_id, params) {
      callNum++;
      return {
        content: [{ type: "text", text: params.path.includes("old") ? bigDump : cleanSnippet }],
        details: {},
      };
    },
  };
  const s = await openSession(t, { tools: [readTool] });
  s.reply = n => {
    if (n === 1) return { stopReason: "toolUse", content: [{ type: "toolCall", id: "c_old", name: "read", arguments: { path: "src/old_trace.log" } }] };
    if (n === 2) return { stopReason: "toolUse", content: [{ type: "toolCall", id: "c_clean", name: "read", arguments: { path: "scripts/toolchain.py" } }] };
    if (n === 3) return failure(truncated, [{ type: "thinking", thinking: "Modifying toolchain." }, { type: "text", text: geminiFilterBanner }]);
    return success;
  };
  const tick = clock(t);
  const done = s.session.prompt("Update scripts/toolchain.py build step");
  await until(() => s.row().includes("[1/10]"));
  await tick(10000);
  await done;

  assert.equal(callNum, 2);
  assert.equal(s.calls.length, 4);
  const recoveredPayload = JSON.stringify(s.calls[3].messages);
  // 125 KB old dump was compacted away into a neutral summary.
  assert.ok(!recoveredPayload.includes("OLD_LOW_LEVEL_TRACE_LINE"));
  assert.match(recoveredPayload, /compacted into a neutral software-engineering summary/);
  assert.match(recoveredPayload, /src\/old_trace\.log/);
  // Recent small clean toolchain.py snippet was preserved so the model doesn't loop re-reading it.
  assert.ok(recoveredPayload.includes("def compile_cpp(sources, output):"));
});

test("consecutive Gemini filter blocks progressively fold raw tool outputs without breaking toolCall pairing", async t => {
  const rawPayload = "FLAGGED_PAYLOAD_LITERAL_LINE_1\nFLAGGED_PAYLOAD_LITERAL_LINE_2";
  const readTool = {
    name: "read_sample",
    label: "Read Sample",
    description: "Read sample payload file",
    parameters: Type.Object({}),
    async execute() {
      return { content: [{ type: "text", text: rawPayload }], details: {} };
    },
  };
  const s = await openSession(t, { tools: [readTool] });
  s.reply = n => {
    if (n === 1) {
      return { stopReason: "toolUse", content: [{ type: "toolCall", id: "call_read_1", name: "read_sample", arguments: {} }] };
    }
    if (n === 2 || n === 3) {
      return failure(truncated, [{ type: "text", text: geminiFilterBanner }]);
    }
    return success;
  };
  const tick = clock(t);
  const done = s.session.prompt("Inspect sample file");

  // First filter block (call #2): keeps toolResult raw content and injects self-check #1.
  await until(() => s.row().includes("[1/10]"));
  await tick(10000);

  // Second consecutive filter block (call #3): folds raw toolResult content and replaces self-check #1 with #2.
  await until(() => s.row().includes("[2/10]"));
  await tick(10000);
  await done;

  assert.equal(s.calls.length, 4);
  // Attempt 1 (call #3) kept raw tool output to let model adjust its own reply first.
  assert.ok(JSON.stringify(s.calls[2].messages).includes("FLAGGED_PAYLOAD_LITERAL_LINE_1"));

  // Attempt 2 (call #4) folded the raw tool output while preserving the paired toolResult message.
  const finalCallMessages = s.calls[3].messages;
  assert.ok(!JSON.stringify(finalCallMessages).includes("FLAGGED_PAYLOAD_LITERAL_LINE_1"));
  const toolResultMsg = finalCallMessages.find(m => m.role === "toolResult");
  assert.equal(toolResultMsg?.toolCallId, "call_read_1");
  assert.match(JSON.stringify(toolResultMsg.content), /raw tool output omitted \(read_sample, 2 lines/);

  // Superseded self-check #1 was omitted so self-check prompts do not stack up.
  const selfChecksInContext = finalCallMessages.filter(
    m => m.role === "user" && JSON.stringify(m.content).includes("Auto-Retry Filter Self-Check"),
  );
  assert.equal(selfChecksInContext.length, 1);
  assert.match(JSON.stringify(selfChecksInContext[0].content), /Auto-Retry Filter Self-Check 2\/10/);
  assert.match(JSON.stringify(selfChecksInContext[0].content), /read_sample/);
});

test("persistent filter blocks after folding tool output omit the offending tool-call turn pair and recover", async t => {
  const writeTool = {
    name: "write_sample",
    label: "Write Sample",
    description: "Write sample file",
    parameters: Type.Object({ body: Type.String() }),
    async execute() {
      return { content: [{ type: "text", text: "wrote file" }], details: {} };
    },
  };
  const s = await openSession(t, { tools: [writeTool] });
  const flaggedArg = "FLAGGED_INLINE_TOOL_ARGUMENT";
  s.reply = n => {
    if (n === 1) {
      return {
        stopReason: "toolUse",
        content: [{ type: "toolCall", id: "call_write_1", name: "write_sample", arguments: { body: flaggedArg } }],
      };
    }
    if (n >= 2 && n <= 4) {
      return failure(truncated, [{ type: "text", text: geminiFilterBanner }]);
    }
    return success;
  };
  const tick = clock(t);
  const done = s.session.prompt("Create test fixture");

  for (let n = 1; n <= 3; n++) {
    await until(() => s.row().includes("[" + n + "/10]"));
    await tick(10000);
  }
  await done;

  assert.equal(s.calls.length, 5);
  const lastMessages = s.calls[4].messages;
  assert.ok(!JSON.stringify(lastMessages).includes(flaggedArg));
  assert.equal(lastMessages.filter(m => m.role === "toolResult").length, 0);
  assert.match(JSON.stringify(lastMessages.at(-1).content), /Auto-Retry Filter Self-Check 3\/10/);
  assert.match(JSON.stringify(lastMessages.at(-1).content), /write_sample/);
});

test("filter self-check retries stop at the configured limit and notify the user", async t => {
  const s = await openSession(t);
  await s.session.prompt("/retry 2");
  s.reply = () => failure(truncated, [{ type: "text", text: geminiFilterBanner }]);
  const tick = clock(t);
  const done = s.session.prompt("Run security check");

  await until(() => s.row().includes("[1/2]"));
  await tick(10000);
  await until(() => s.row().includes("[2/2]"));
  await tick(10000);
  await done;

  assert.equal(s.calls.length, 3);
  assert.ok(s.notices.includes("Retry limit reached (2/2). The provider blocked this request."));
});

test("cancelling a pending filter self-check countdown leaves no self-check message in history", async t => {
  const s = await openSession(t);
  s.reply = () => failure(truncated, [{ type: "text", text: geminiFilterBanner }]);
  const tick = clock(t);
  const done = s.session.prompt("Inspect query");
  await until(() => s.row().includes("[1/10]"));
  assert.equal(s.key("\x1b")?.consume, true);
  await done;
  await tick(15000);
  assert.equal(s.calls.length, 1);
  const customEntries = s.session.sessionManager.getBranch().filter(e => e.type === "custom_message");
  assert.equal(customEntries.length, 0);
});

test("native retryable status combined with SAFETY stop reason still injects self-check", async t => {
  const s = await openSession(t);
  s.reply = n => n === 1 ? { ...failure("503 gateway"), rawStopReason: "SAFETY" } : success;
  const tick = clock(t);
  const done = s.session.prompt("Check handler");
  await until(() => s.row().includes("[1/10]"));
  await tick(10000);
  await done;
  assert.equal(s.calls.length, 2);
  assert.match(JSON.stringify(s.calls[1].messages), /Auto-Retry Filter Self-Check 1\/10/);
  assert.match(JSON.stringify(s.calls[1].messages), /SAFETY/);
});

test("HTTP 200 with a Gemini block self-checks then recovers across an ordinary stream cutoff", { timeout: 10000 }, async t => {
  const times = [];
  const bodies = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      bodies.push(Buffer.concat(chunks).toString("utf8"));
      times.push(Date.now());
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const send = data => res.write("data: " + JSON.stringify(data) + "\n\n");
      const finished = times.length === 3;
      const text = [geminiFilterBanner, "Reading the UI file.", "Done."][times.length - 1];
      send({ id: "test-reply", object: "chat.completion.chunk", created: 1, model: "mock",
        choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: finished ? "stop" : null }] });
      if (finished) res.end("data: [DONE]\n\n");
      else {
        send({ error: { type: "api_error", message: truncated } });
        res.end();
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => {
    server.closeAllConnections();
    return new Promise(resolve => server.close(resolve));
  });
  const s = await openSession(t, { baseUrl: "http://127.0.0.1:" + server.address().port + "/v1",
    native: { provider: { maxRetries: 0 } } });
  await s.session.prompt("/retry 20");
  const tick = clock(t);
  const done = s.session.prompt("Continue");

  // Attempt 1: Gemini filter block -> self-check countdown.
  await until(() => s.row().includes("[1/20]"));
  assert.match(s.row(), /Filter blocked · self-check in 10s/);
  await tick(10000);

  // Attempt 2: Ordinary Antigravity stream cutoff -> normal retry countdown.
  await until(() => s.row().includes("[2/20]"));
  assert.match(s.row(), /\[Cancel\]  Retrying in 10s/);
  await tick(10000);

  await done;
  assert.equal(times.length, 3);
  assert.equal(s.row(), "");
  assert.ok(!bodies[1].includes("blocked by Gemini's filters"));
  assert.match(bodies[1], /Auto-Retry Filter Self-Check 1\/20/);
  assert.ok(!bodies[2].includes("Reading the UI file."));
  assert.match(bodies[2], /Auto-Retry Filter Self-Check 1\/20/);
  assert.equal(s.session.messages.at(-1).stopReason, "stop");
});
