// Grouping and filtering of clips. Shared by the server (tests) and the browser.

/** Newest first: by the time the clip was taken, then (n) counter, then name. */
export function sortClips(clips) {
  return [...clips].sort((a, b) =>
    a.takenAt !== b.takenAt ? (a.takenAt < b.takenAt ? 1 : -1) : (b.n || 1) - (a.n || 1) || b.name.localeCompare(a.name),
  );
}

/**
 * Days newest first; inside a day, games ordered by their newest clip;
 * inside a game, clips newest first.
 * -> [{ day: "2026-11-03", games: [{ game: "VALORANT", clips: [...] }] }]
 */
export function groupClips(clips) {
  const days = new Map();
  for (const c of sortClips(clips)) {
    if (!days.has(c.day)) days.set(c.day, new Map());
    const games = days.get(c.day);
    if (!games.has(c.game)) games.set(c.game, []);
    games.get(c.game).push(c);
  }
  return [...days].map(([day, games]) => ({
    day,
    games: [...games].map(([game, list]) => ({ game, clips: list })),
  }));
}

/** Like the desktop library: days newest first, clips newest first. -> [{ day, clips }] */
export function groupByDay(clips) {
  const out = [];
  for (const c of sortClips(clips)) {
    if (out[out.length - 1]?.day !== c.day) out.push({ day: c.day, clips: [] });
    out[out.length - 1].clips.push(c);
  }
  return out;
}

/** Length buckets for the filter, in seconds: [from, to). */
export const LENGTHS = { short: [0, 30], medium: [30, 120], long: [120, Infinity] };

/**
 * Search (words in any order, over game, PC, source, name and date) plus filters:
 * game, pcs (list), sources (list; "" is Hindsight's own), kind ("clip" | "recording"),
 * from / to (YYYY-MM-DD, inclusive), length (a LENGTHS key; clips not measured yet
 * stay in), damaged (only damaged ones).
 */
export function filterClips(clips, { search = "", game = "", pcs = [], sources = [], kind = "", from = "", to = "", length = "", damaged = false } = {}) {
  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  const len = LENGTHS[length];
  return clips.filter((c) => {
    if (game && c.game !== game) return false;
    if (pcs.length && !pcs.includes(c.pc || "")) return false;
    if (sources.length && !sources.includes(c.source || "")) return false;
    if (kind === "recording" && !c.recording) return false;
    if (kind === "clip" && c.recording) return false;
    if (from && c.day < from) return false;
    if (to && c.day > to) return false;
    if (len && c.duration && !(c.duration >= len[0] && c.duration < len[1])) return false;
    if (damaged && !c.damaged) return false;
    const hay = `${c.game} ${c.pc || ""} ${c.source || ""} ${c.name} ${c.day}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** "new" (default), "old", "big" or "long". */
export function sortBy(clips, order = "new") {
  const newest = sortClips(clips);
  if (order === "old") return newest.reverse();
  if (order === "big") return newest.sort((a, b) => b.size - a.size);
  if (order === "long") return newest.sort((a, b) => (b.duration || 0) - (a.duration || 0));
  return newest;
}

/** One folder per game, biggest collections first: [{ game, clips, bytes, newest }]. */
export function folders(clips) {
  const by = new Map();
  for (const c of sortClips(clips)) {
    if (!by.has(c.game)) by.set(c.game, { game: c.game, clips: [], bytes: 0, newest: c });
    const f = by.get(c.game);
    f.clips.push(c);
    f.bytes += c.size;
  }
  return [...by.values()].sort((a, b) => b.clips.length - a.clips.length || a.game.localeCompare(b.game));
}

/** Values present for a filter, with counts: [[value, count]] most first. */
export function facet(clips, key) {
  const m = new Map();
  for (const c of clips) m.set(c[key] || "", (m.get(c[key] || "") || 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/** Game names, alphabetical. */
export function gamesOf(clips) {
  return [...new Set(clips.map((c) => c.game))].sort((a, b) => a.localeCompare(b));
}
