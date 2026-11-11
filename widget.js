import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

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
      const status = attempt.running || !seconds ? "Retrying" : "Retrying in " + seconds + "s";
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
