import assert from "node:assert/strict";
import test from "node:test";
import { TuiAltScreen } from "@earendil-works/pi-tui";
import { renderSelfCheckMessage, retryWidget } from "../widget.js";

test("Pi's fullscreen renderer routes terminal mouse clicks only inside [Cancel]", async t => {
  let input;
  let output = "";
  const terminal = {
    columns: 52, rows: 8, kittyProtocolActive: false,
    start(fn) { input = fn; }, stop() {}, write(data) { output += data; },
    hideCursor() {}, showCursor() {}, setProgress() {}, setProgramStatus() {},
  };
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: true });
  let clicks = 0;
  const attempt = { number: 1, deadline: Date.now() + 10000, running: false };
  const widget = retryWidget(tui, { fg: (_color, text) => text }, attempt, () => 10, () => { clicks++; });
  tui.addChild({ render: () => ["User prompt", "Provider error"], invalidate() {} });
  tui.addChild(widget);
  tui.start();
  t.after(() => { widget.dispose(); tui.stop(); });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(output.includes("[1/10]  [Cancel]"));
  const click = (col, row) => {
    input("\x1b[<0;" + col + ";" + row + "M");
    input("\x1b[<0;" + col + ";" + row + "m");
  };
  click(4, 3); // Progress.
  click(11, 2); // Same column, another widget.
  assert.equal(clicks, 0);
  click(11, 3);
  assert.equal(clicks, 1);
});

test("self-check retry widget and chat message renderer format collapsed and expanded states", () => {
  const theme = {
    fg: (_color, text) => text,
    bg: (_color, text) => text,
    bold: text => text,
  };
  const attempt = { number: 2, deadline: Date.now() + 9000, running: false, selfCheck: true };
  const widget = retryWidget({ requestRender() {} }, theme, attempt, () => 10, () => {});
  try {
    assert.match(widget.render(80)[0], /^\[2\/10\]  \[Cancel\]  Filter blocked · self-check in \ds · Esc$/);
    attempt.running = true;
    assert.equal(widget.render(80)[0], "[2/10]  [Cancel]  Self-checking & retrying · Esc");
  } finally {
    widget.dispose();
  }

  const message = {
    content: "Full self-check instruction body",
    details: { attempt: 2, limit: 10, stage: "output", redactedTools: ["read"] },
  };
  const collapsed = renderSelfCheckMessage(message, {
    expanded: false,
    outputPad: 1,
    keyHint: (_id, desc) => "ctrl+o " + desc,
  }, theme).render(120).join("\n");
  assert.match(collapsed, /\[Auto-Retry · Filter Self-Check 2\/10\]/);
  assert.match(collapsed, /Folded tool output: read\./);
  assert.match(collapsed, /\(ctrl\+o to expand\)/);
  assert.ok(!collapsed.includes("Full self-check instruction body"));

  const expanded = renderSelfCheckMessage(message, { expanded: true, outputPad: 1 }, theme).render(120).join("\n");
  assert.match(expanded, /Full self-check instruction body/);
});
