import assert from "node:assert/strict";
import test from "node:test";
import { TuiAltScreen } from "@earendil-works/pi-tui";
import { retryWidget } from "../widget.js";

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
