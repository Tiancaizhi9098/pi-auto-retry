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
  await session.bindExtensions({ mode: "interactive", uiContext: ui, onError: error => state.errors.push(error) });
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

test("explicit provider rejections, credentials, and success settle immediately", async t => {
  const s = await openSession(t);
  const before = s.calls.length;
  for (const message of [
    failure(truncated, [{ type: "text", text: "This request was blocked by Gemini's filters." }]),
    { ...failure("503 gateway"), rawStopReason: "SAFETY" },
    failure("HTTP 401 invalid API key, connection error"), failure("429 insufficient_quota"), success,
  ]) {
    s.reply = () => message;
    await s.session.prompt("normal request");
    assert.equal(s.row(), "");
  }
  assert.equal(s.calls.length, before + 5);
  assert.equal(s.nativeStarts.length, 0);
});

test("HTTP 200 with a Gemini block reports 0/20, while an ordinary stream cutoff retries", { timeout: 10000 }, async t => {
  const times = [];
  const blocked = "This request was blocked by Gemini's filters. Please try rephrasing your prompt.";
  const server = createServer((req, res) => {
    req.resume();
    times.push(Date.now());
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const send = data => res.write("data: " + JSON.stringify(data) + "\n\n");
    const finished = times.length === 3;
    const text = [blocked, "Reading the UI file.", "Done."][times.length - 1];
    send({ id: "test-reply", object: "chat.completion.chunk", created: 1, model: "mock",
      choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: finished ? "stop" : null }] });
    if (finished) res.end("data: [DONE]\n\n");
    else {
      send({ error: { type: "api_error", message: truncated } });
      res.end();
    }
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
  await s.session.prompt("Continue");
  await tick(30000);
  assert.equal(times.length, 1);
  assert.equal(s.row(), "");
  assert.equal(s.nativeStarts.length, 0);
  assert.deepEqual(s.notices.filter(n => n.includes("Auto-retry stopped")), [
    "Auto-retry stopped [0/20]. The provider blocked this request.",
  ]);

  // The previous refusal is still in the transcript. The next request's own
  // error must decide whether to retry.
  const next = s.session.prompt("Change the button label");
  await until(() => s.row().includes("[1/20]"));
  await tick(10000);
  await next;
  assert.equal(times.length, 3);
  assert.equal(times[2] - times[1], 10000);
  assert.equal(s.session.messages.at(-1).stopReason, "stop");
});
