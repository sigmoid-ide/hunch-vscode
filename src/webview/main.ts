// The Runs view: draws what the extension posts and reports clicks and selection back.
import type { DetailsView, RowView, ScreenView } from "../viewModel.ts";

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };
const vscode = acquireVsCodeApi();

const ROW_HEIGHT = 28;
const LANE_WIDTH = 14;
const PADDING = 6;
const CURVE_WIDTH = 64;

let screen: ScreenView | undefined;
let selection: string[] = [];
let anchor: string | undefined;
/** The row the keyboard is on; with Shift, the selection runs from the anchor to it. */
let cursor: string | undefined;
const app = document.getElementById("app")!;

// Drawn once: redrawing the search box would lose what is being typed.
app.innerHTML = `
  <div class="layout">
    <div class="table-pane">
      <div class="search"><input id="search" type="text" placeholder="Search all runs, or filter: is:kept since:7d val_loss<0.3" aria-label="Search all runs" spellcheck="false"></div>
      <div id="table" class="table"></div>
    </div>
    <div id="details" class="details-pane"></div>
  </div>`;
const searchBox = document.getElementById("search") as HTMLInputElement;
const tablePane = document.getElementById("table")!;
const detailsPane = document.getElementById("details")!;

window.addEventListener("message", (event) => {
  if (event.data?.type !== "screen") return;
  screen = event.data.data as ScreenView;
  selection = screen.selection;
  render();
});
vscode.postMessage({ type: "ready" });

function render(): void {
  if (!screen) return;
  const s = screen;
  // Choosing a milestone ends a search; while typing, the box is the user's.
  if (document.activeElement !== searchBox && searchBox.value !== s.search) searchBox.value = s.search;
  const graphPx = PADDING * 2 + LANE_WIDTH * Math.max(s.graphWidth, 1);
  const focused = document.activeElement?.id === "grid";
  tablePane.innerHTML = `
    <div id="grid" class="grid" role="grid" aria-label="Runs" aria-multiselectable="true" tabindex="0">
      <div class="row header" role="row">
        <div role="columnheader"></div>
        <div role="columnheader" title="The end of the run's id. Use it with hunch show and hunch diff.">Run</div>
        <div role="columnheader" class="started">Started</div>
        <div role="columnheader" title="Why you ran it, written before the run (hunch run -m). Right-click a run to edit it.">Hypothesis</div>
        <div role="columnheader" title="This metric at the end of each run, and how it moved during the run.">${esc(s.headerMetric)}</div>
        <div role="columnheader" title="What the run showed, written after it, and whether to keep building on it or drop it (hunch note).">Conclusion</div>
      </div>
      ${s.rows.map((row) => rowHtml(row, graphPx)).join("")}
    </div>
    ${s.rows.length ? "" : `<div class="empty">${s.empty.map((line, i) => `<div class="${i ? "" : "empty-title"}">${esc(line)}</div>`).join("")}</div>`}
    ${quickRunsHtml(s.quickRuns)}`;
  detailsPane.innerHTML = detailsHtml(s);
  // Set from script: the webview's security policy blocks inline style attributes.
  const grid = document.getElementById("grid")!;
  grid.style.setProperty("--graph", `${graphPx}px`);
  if (focused) grid.focus();
}

function rowHtml(row: RowView, graphPx: number): string {
  const selected = selection.includes(row.id);
  const context = esc(JSON.stringify({ webviewSection: "run", runId: row.id, preventDefaultContextMenuItems: true }));
  const why = row.why ?? "no hypothesis";
  const metricClass = row.status === "crashed" || row.status === "killed" ? "red" : row.status === "running" ? "green" : row.status === "lost" ? "dim" : "";
  const metricText = (row.metricKey ? `${row.metricKey} ` : "") + row.metric;
  return `
    <div class="row${selected ? " selected" : ""}" role="row" aria-selected="${selected}" data-id="${esc(row.id)}" data-vscode-context="${context}">
      <div role="gridcell" class="graph">${graphSvg(row, graphPx)}</div>
      <div role="gridcell" class="dim mono">${esc(row.short)}</div>
      <div role="gridcell" class="dim started">${esc(row.started)}</div>
      <div role="gridcell" class="${row.why ? "" : "dim italic"}" title="${esc(why)}">${esc(why)}</div>
      <div role="gridcell" class="metric" title="${esc(metricTooltip(row, metricText))}"><span class="${metricClass}">${esc(metricText)}</span>${curveSvg(row)}</div>
      <div role="gridcell" title="${esc(row.conclusion ?? "")}">${row.verdict ? `<span class="pill ${row.verdict === "keep" ? "keep" : "drop"}">${esc(row.verdict)}</span>` : ""}${esc(row.conclusion ?? "")}</div>
    </div>`;
}

function metricTooltip(row: RowView, text: string): string {
  return row.spark.length < 2 ? text : `${text}   (from ${row.spark[0].toPrecision(4).replace(/\.?0+$/, "")} at the start)`;
}

function graphSvg(row: RowView, graphPx: number): string {
  const mid = ROW_HEIGHT / 2;
  const x = (lane: number) => PADDING + lane * LANE_WIDTH + LANE_WIDTH / 2;
  const parts: string[] = [];
  for (let lane = 0; lane < row.above; lane++) {
    if (row.joining.includes(lane)) {
      parts.push(`<path d="M${x(lane)} 0 C${x(lane)} ${mid * 0.6} ${x(row.lane)} ${mid * 0.4} ${x(row.lane)} ${mid}"/>`);
    } else {
      parts.push(`<line x1="${x(lane)}" y1="0" x2="${x(lane)}" y2="${ROW_HEIGHT}"/>`);
    }
  }
  if (row.hasParent) parts.push(`<line x1="${x(row.lane)}" y1="${mid}" x2="${x(row.lane)}" y2="${ROW_HEIGHT}"/>`);
  const node = `<circle class="node ${row.node}" cx="${x(row.lane)}" cy="${mid}" r="4.5"/>`;
  return `<svg width="${graphPx}" height="${ROW_HEIGHT}" aria-hidden="true"><g class="lanes">${parts.join("")}</g>${node}</svg>`;
}

function curveSvg(row: RowView): string {
  const values = row.spark;
  if (values.length < 2) return "";
  const top = 6;
  const h = ROW_HEIGHT - 2 * top;
  const low = Math.min(...values);
  const high = Math.max(...values);
  const points = values.map((v, i) => {
    const px = (i * CURVE_WIDTH) / (values.length - 1);
    const py = top + (high === low ? h / 2 : ((high - v) / (high - low)) * h);
    return `${px.toFixed(1)},${py.toFixed(1)}`;
  }).join(" ");
  const red = row.status === "crashed" || row.status === "killed";
  return `<svg class="curve${red ? " red" : ""}" width="${CURVE_WIDTH}" height="${ROW_HEIGHT}" aria-hidden="true"><polyline points="${points}"/></svg>`;
}

function quickRunsHtml(quick: ScreenView["quickRuns"]): string {
  if (!quick.count) return "";
  const runs = quick.count === 1 ? "1 quick run" : `${quick.count} quick runs`;
  const text = quick.showing ? `Showing ${runs}` : `${runs} hidden`;
  return `<div class="quick-runs"><span class="dim">${text} (stopped or crashed in under 30 seconds)</span> <a href="#" data-action="toggle-quick">${quick.showing ? "Hide" : "Show"}</a></div>`;
}

function detailsHtml(s: ScreenView): string {
  const d: DetailsView | null = s.details;
  if (!d) {
    const text = s.message ?? (s.loaded && s.rows.length ? "Select a run to see its details." : "Your runs will appear here.");
    return `<div class="details-message">${esc(text)}</div>`;
  }
  const rows = d.rows.map((row) => {
    const value = "text" in row.value
      ? `<div class="value">${esc(row.value.text)}</div>`
      : `<div class="value"><a href="#" data-command="${esc(row.value.command)}" data-args="${esc(JSON.stringify(row.value.args))}">${esc(row.value.link)}</a></div>`;
    return `<div class="label">${esc(row.label)}</div>${value}`;
  }).join("");
  const actions = d.actions.length
    ? `<div class="actions">${d.actions.map((a, i) => `<button class="${i ? "secondary" : ""}"${a.key ? ` title="Key in the table: ${esc(a.key)}"` : ""} data-command="${esc(a.command)}" data-args="${esc(JSON.stringify(a.args))}">${esc(a.label)}</button>`).join("")}</div>`
    : "";
  return `
    <div class="details">
      <div class="title${d.dimTitle ? " dim" : ""}">${esc(d.title)}</div>
      <div class="subtitle dim">${esc(d.subtitle)}</div>
      ${actions}
      <div class="fields">${rows}</div>
    </div>`;
}

// Search: every keystroke asks for the matching runs. Escape clears it, Down moves to the first match.

searchBox.addEventListener("input", () => vscode.postMessage({ type: "search", text: searchBox.value }));

searchBox.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && searchBox.value) {
    event.preventDefault();
    searchBox.value = "";
    vscode.postMessage({ type: "search", text: "" });
  } else if (event.key === "ArrowDown" && screen?.rows.length) {
    event.preventDefault();
    document.getElementById("grid")?.focus();
    select([screen.rows[0].id]);
  }
});

// Selection and actions.

app.addEventListener("click", (event) => {
  const target = event.target as HTMLElement;
  const command = target.closest<HTMLElement>("[data-command]");
  if (command) {
    event.preventDefault();
    vscode.postMessage({ type: "command", command: command.dataset.command, args: JSON.parse(command.dataset.args ?? "[]") });
    return;
  }
  if (target.closest("[data-action=toggle-quick]")) {
    event.preventDefault();
    vscode.postMessage({ type: "toggleQuickRuns" });
    return;
  }
  const row = target.closest<HTMLElement>(".row[data-id]");
  if (!row) return;
  const id = row.dataset.id!;
  cursor = id;
  if (event.shiftKey && anchor) {
    const ids = screen!.rows.map((r) => r.id);
    const [a, b] = [ids.indexOf(anchor), ids.indexOf(id)].sort((x, y) => x - y);
    select(ids.slice(a, b + 1), false);
  } else if (event.ctrlKey || event.metaKey) {
    select(selection.includes(id) ? selection.filter((s) => s !== id) : [...selection, id]);
  } else {
    select([id]);
  }
});

app.addEventListener("dblclick", (event) => {
  const row = (event.target as HTMLElement).closest<HTMLElement>(".row[data-id]");
  if (row) vscode.postMessage({ type: "open", id: row.dataset.id });
});

// Right-clicking a row outside the selection selects it, as lists do.
app.addEventListener("contextmenu", (event) => {
  const row = (event.target as HTMLElement).closest<HTMLElement>(".row[data-id]");
  if (row && !selection.includes(row.dataset.id!)) select([row.dataset.id!]);
});

/** Keys that act on the selected runs, as their right-click menu does. F2 renames, as elsewhere in VS Code. */
const RUN_KEYS: Record<string, string> = { k: "hunch.keep", d: "hunch.drop", c: "hunch.writeConclusion", F2: "hunch.editHypothesis" };

app.addEventListener("keydown", (event) => {
  if ((event.target as HTMLElement).id !== "grid" || !screen?.rows.length) return;
  const ids = screen.rows.map((r) => r.id);
  const command = event.ctrlKey || event.metaKey || event.altKey ? undefined : RUN_KEYS[event.key.length === 1 ? event.key.toLowerCase() : event.key];
  if (command && selection.length) {
    event.preventDefault();
    vscode.postMessage({ type: "command", command, args: [{ runId: selection[0] }] });
    return;
  }
  const at = cursor && ids.includes(cursor) ? cursor : selection[selection.length - 1];
  const current = at ? ids.indexOf(at) : -1;
  let next = current;
  if (event.key === "ArrowDown") next = Math.min(ids.length - 1, current + 1);
  else if (event.key === "ArrowUp") next = Math.max(0, current - 1);
  else if (event.key === "Home") next = 0;
  else if (event.key === "End") next = ids.length - 1;
  else if (event.key === "Enter" && current >= 0) {
    vscode.postMessage({ type: "open", id: ids[current] });
    return;
  } else return;
  event.preventDefault();
  if (event.shiftKey && anchor && ids.includes(anchor)) {
    const [a, b] = [ids.indexOf(anchor), next].sort((x, y) => x - y);
    select(ids.slice(a, b + 1), false); // Shift extends the selection, as Shift+click does
  } else {
    select([ids[next]]);
  }
  cursor = ids[next];
  document.querySelector(`.row[data-id="${CSS.escape(ids[next])}"]`)?.scrollIntoView({ block: "nearest" });
});

// Ctrl+F, or / outside the search box, goes to the search box from anywhere in the view.
document.addEventListener("keydown", (event) => {
  const modified = event.ctrlKey || event.metaKey;
  const find = modified && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "f";
  const slash = event.key === "/" && !modified && !event.altKey && event.target !== searchBox;
  if (!find && !slash) return;
  event.preventDefault();
  searchBox.focus();
  searchBox.select();
});

function select(ids: string[], moveAnchor = true): void {
  selection = ids;
  if (moveAnchor) anchor = ids[ids.length - 1];
  for (const row of document.querySelectorAll<HTMLElement>(".row[data-id]")) {
    const on = ids.includes(row.dataset.id!);
    row.classList.toggle("selected", on);
    row.setAttribute("aria-selected", String(on));
  }
  vscode.postMessage({ type: "select", ids });
}

function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
