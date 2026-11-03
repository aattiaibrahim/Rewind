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

/** Case-insensitive search over game, PC name and file name, plus an exact game filter. */
export function filterClips(clips, { search = "", game = "" } = {}) {
  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  return clips.filter((c) => {
    if (game && c.game !== game) return false;
    const hay = `${c.game} ${c.pc || ""} ${c.name} ${c.day}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** Game names, alphabetical. */
export function gamesOf(clips) {
  return [...new Set(clips.map((c) => c.game))].sort((a, b) => a.localeCompare(b));
}
