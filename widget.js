import { Box, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const button = "[Cancel]";

export function retryWidget(tui, theme, attempt, getLimit, cancel) {
  let left = 0;
  let right = 0;
  const timer = setInterval(() => {
    if (!attempt.running) tui.requestRender();
  }, 1000);
  timer.unref?.();
  attempt.redraw = () => tui.requestRender();
  return {
    render(width) {
      const progress = "[" + attempt.number + "/" + getLimit() + "]";
      const prefix = progress + "  ";
      const seconds = Math.max(0, Math.ceil((attempt.deadline - Date.now()) / 1000));
      const status = attempt.selfCheck
        ? (attempt.running || !seconds ? "Self-checking & retrying" : "Filter blocked · self-check in " + seconds + "s")
        : (attempt.running || !seconds ? "Retrying" : "Retrying in " + seconds + "s");
      left = visibleWidth(prefix);
      right = left + visibleWidth(button);
      if (right > width) right = left;
      const line = theme.fg("warning", progress) + "  " + theme.fg("accent", button)
        + "  " + status + theme.fg("dim", " · Esc");
      return [truncateToWidth(line, width, "")];
    },
    handleMouse(event) {
      if (event.button !== "left" || event.y !== 0 || event.x < left || event.x >= right) return;
      if (event.type === "press") return { handled: true };
      if (event.type === "click") {
        cancel();
        return { handled: true };
      }
    },
    invalidate() {},
    dispose() {
      clearInterval(timer);
      attempt.redraw = undefined;
    },
  };
}

export function renderSelfCheckMessage(message, options, theme) {
  const { expanded, outputPad = 1 } = options ?? {};
  const details = message.details ?? {};
  const badge = details.attempt && details.limit ? ` ${details.attempt}/${details.limit}` : "";
  const bold = text => (theme.bold ? theme.bold(text) : text);
  const bg = text => (theme.bg ? theme.bg("customMessageBg", text) : text);

  const title = theme.fg("warning", bold(`[Auto-Retry · Filter Self-Check${badge}]`));
  const summary = [
    details.stage === "output"
      ? "Reply stream hit provider filter; asking model to inspect & rephrase before retrying."
      : "Request hit provider filter; asking model to inspect context/phrasing & retry.",
  ];
  if (details.redactedTools?.length) {
    summary.push(`Folded tool output: ${details.redactedTools.join(", ")}.`);
  }
  if (details.omittedTurnTools?.length) {
    summary.push(`Omitted earlier tool turn: ${details.omittedTurnTools.join(", ")}.`);
  }

  let body = title + " " + summary.join(" ");
  if (expanded) {
    const raw = typeof message.content === "string"
      ? message.content
      : (message.content ?? []).filter(part => part.type === "text").map(part => part.text).join("\n");
    body += "\n\n" + theme.fg("muted", raw);
  } else if (options?.keyHint) {
    body += " " + theme.fg("dim", `(${options.keyHint("app.tools.expand", "to expand")})`);
  }

  const box = new Box(outputPad, 1, bg);
  box.addChild(new Text(body, 0, 0));
  return box;
}
