/* No credentials in JS, storage, URLs, or JSON responses. The session is HttpOnly. */
const $ = (id) => document.getElementById(id);
let events = [], cursor, paused = false, busy = false, authenticated = false, gapSeen = false;
const MAX_VISIBLE = 1000;
const category = (kind) => /^(channel|member|message)\./.test(kind) ? "chat" :
  kind.startsWith("events.") || kind.startsWith("webhook.") ? "delivery" : kind.split(".")[0];
const failed = (kind) => /failed|abandoned/.test(kind);
const node = (tag, className, text) => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
};
function eventRow(event) {
  const d = event.details;
  const row = node("details", "event");
  row.dataset.id = String(event.id);
  row.dataset.category = category(event.kind);
  row.dataset.failed = String(failed(event.kind));
  const summary = node("summary");
  const date = new Date(event.timestamp);
  const time = node("time", "time", date.toLocaleTimeString([], { hour12: false }));
  time.dateTime = event.timestamp;
  time.title = date.toISOString();
  time.append(node("span", "", date.toLocaleDateString([], { month: "short", day: "numeric" })));
  const description = node("div", "description");
  const parts = [];
  if (d.actor) parts.push(d.actor.name);
  if (d.channel) parts.push(`#${d.channel.name}`);
  if (d.count !== undefined) parts.push(`${d.count} event${d.count === 1 ? "" : "s"}`);
  if (d.attempt) parts.push(`attempt ${d.attempt}`);
  if (d.reason) parts.push(d.reason.replaceAll("_", " "));
  if (d.retryAfterMs !== undefined) parts.push(`retry in ${d.retryAfterMs / 1000}s`);
  if (d.expiresAt) parts.push(`lease until ${new Date(d.expiresAt).toLocaleTimeString([], { hour12: false })}`);
  if (!parts.length) parts.push(event.kind === "server.started" ? "Server is ready" : "Server stopped");
  description.append(node("p", "byline", parts.join(" · ")));
  if (d.message) description.append(node("p", "message", d.message.text));
  summary.append(time, node("span", "tag", event.kind), description, node("span", "mode", d.mode ?? "—"));
  row.append(summary, node("pre", "", JSON.stringify(event, null, 2)));
  return row;
}
function render() {
  const query = $("search").value.trim().toLowerCase();
  const selectedCategory = $("category").value;
  const selectedMode = $("mode").value;
  const matching = events.filter((event) => (selectedCategory === "all" || category(event.kind) === selectedCategory) &&
    (selectedMode === "all" || event.details.mode === selectedMode) && (!query || JSON.stringify(event).toLowerCase().includes(query)));
  const existing = new Map([...$("feed").children].map((row) => [Number(row.dataset.id), row]));
  // Reuse nodes so expanded details/focus survive live updates.
  const rows = matching.map((event) => existing.get(event.id) ?? eventRow(event));
  const wanted = new Set(rows);
  for (const row of [...$("feed").children]) if (!wanted.has(row)) row.remove();
  rows.forEach((row, index) => { if ($("feed").children[index] !== row) $("feed").insertBefore(row, $("feed").children[index] ?? null); });
  $("empty").hidden = matching.length !== 0;
  $("window").textContent = `${matching.length.toLocaleString()} SHOWN / ${events.length.toLocaleString()} LOADED`;
  $("messages").textContent = events.filter((e) => e.kind === "message.posted").length.toLocaleString();
  $("subscriptions").textContent = events.filter((e) => e.kind.startsWith("subscription.")).length.toLocaleString();
  $("failures").textContent = events.filter((e) => failed(e.kind)).length.toLocaleString();
}
function status(text, live = false) { $("connection").textContent = text; $("connection").classList.toggle("live", live); }
function warn(text) { $("warning").textContent = text; $("warning").hidden = !text; }
async function update() {
  if (busy || paused || document.hidden) return;
  busy = true;
  try {
    const response = await fetch(`/debug/api/events${cursor === undefined ? "" : `?after=${cursor}`}`, { credentials: "same-origin", cache: "no-store" });
    if (response.status === 401 || response.status === 403) {
      authenticated = false;
      events = []; cursor = undefined; $("feed").replaceChildren();
      $("monitor").hidden = true; $("logout").hidden = true; $("signin").hidden = false;
      status(response.status === 403 ? "Administrator access required" : "Sign in to continue");
      return;
    }
    if (!response.ok) throw new Error("unavailable");
    const data = await response.json();
    if (paused) return;
    authenticated = true;
    $("monitor").hidden = false; $("logout").hidden = false; $("signin").hidden = true;
    if (data.reset) { events = []; gapSeen = true; }
    warn([gapSeen ? "Some activity is no longer retained. Showing the latest available window." : "",
      data.recordingFailures ? `${data.recordingFailures} activity records could not be saved. This view may be incomplete.` : ""].filter(Boolean).join(" "));
    const byId = new Map(events.map((event) => [event.id, event]));
    for (const event of data.events) byId.set(event.id, event);
    events = [...byId.values()].sort((a, b) => b.id - a.id).slice(0, MAX_VISIBLE);
    cursor = data.cursor;
    $("retained").textContent = data.retained.toLocaleString();
    $("retention").textContent = `Server retains ${data.retention.toLocaleString()} events. Browser keeps the latest ${MAX_VISIBLE.toLocaleString()} loaded.`;
    $("updated").textContent = `Updated ${new Date(data.serverTime).toLocaleTimeString()}`;
    status(paused ? "Paused" : `Live · ${data.viewer}`, !paused);
    render();
    if (data.hasMore && !paused) setTimeout(update, 50);
  } catch {
    status("Reconnecting…");
    if (!authenticated) { $("signin").hidden = false; }
    else warn("Cannot reach the server. Retrying automatically; displayed activity may be stale.");
  } finally { busy = false; }
}
$("search").addEventListener("input", render);
$("category").addEventListener("change", render);
$("mode").addEventListener("change", render);
$("pause").addEventListener("click", () => {
  paused = !paused;
  $("pause").textContent = paused ? "Resume" : "Pause";
  status(paused ? "Paused" : "Reconnecting…");
  if (!paused) void update();
});
$("reset").addEventListener("click", () => {
  if (busy) return;
  events = []; cursor = undefined; gapSeen = false; warn(""); render();
  paused = false; $("pause").textContent = "Pause";
  void update();
});
document.addEventListener("visibilitychange", () => { if (!document.hidden) void update(); });
setInterval(update, 2000);
void update();
