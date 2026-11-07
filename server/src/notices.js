// Notifications: things on the NAS worth a look, one row each, with an action
// and a hide button. Hidden rows come back when what they're about changes
// (their id carries a signature of it).
//
// - Damaged clips (ffprobe can't read them).
// - A game whose clips sit in folders spelled differently ("VALORANT" and "Valorant").
// - Duplicate copies of a clip (the cleanup module's duplicate scan).
// - New clips from other PCs since you last looked.

import { createHash } from "node:crypto";
import { mkdir, rename, rmdir } from "node:fs/promises";
import path from "node:path";
import { freePath } from "./cleanup.js";
import { gameKey } from "./library.js";

const sig = (parts) => createHash("sha1").update(parts.join("\n")).digest("base64url").slice(0, 10);
const plural = (n, word) => `${n} ${n === 1 ? word : word.endsWith("y") ? `${word.slice(0, -1)}ies` : `${word}s`}`;

/** All notices for the library, hidden ones left out. */
export async function notices(clips, { store, cleanup }) {
  const out = [];
  const damaged = clips.filter((c) => c.damaged);
  if (damaged.length) {
    out.push({
      id: `damaged:${sig(damaged.map((c) => c.id).sort())}`,
      kind: "damaged",
      title: `${plural(damaged.length, "clip")} can't be read`,
      detail: damaged.slice(0, 3).map((c) => c.name).join(", ") + (damaged.length > 3 ? ` and ${damaged.length - 3} more` : "") + ". Repair in the editor may save them.",
      action: { label: "Show them", do: "filter-damaged" },
    });
  }

  const byGame = new Map();
  for (const c of clips) {
    const f = c.folder ?? c.game;
    if (!byGame.has(c.game)) byGame.set(c.game, new Map());
    byGame.get(c.game).set(f, (byGame.get(c.game).get(f) || 0) + 1);
  }
  for (const [game, fs] of byGame) {
    if (fs.size < 2) continue;
    const names = [...fs.keys()].sort();
    out.push({
      id: `folders:${gameKey(game)}:${sig(names)}`,
      kind: "folders",
      title: `${game} is in ${fs.size} folders`,
      detail: `${names.map((n) => `"${n}" (${plural(fs.get(n), "clip")})`).join(", ")}. They show as one game here; merging moves them all into "${game}".`,
      action: { label: `Merge into "${game}"`, do: "merge", game, needsChange: true },
    });
  }

  if (cleanup) {
    for (const d of await cleanup.duplicates(clips)) {
      const [keep, ...extra] = d.clips;
      out.push({
        id: `dupe:${sig(d.clips.map((c) => c.rel).sort())}`,
        kind: "dupes",
        title: `${plural(d.clips.length, "copy")} of the same ${d.game} clip`,
        detail: `${d.clips.map((c) => c.name).join(", ")}. Keeps "${keep.name}"; the other${extra.length === 1 ? "" : "s"} go${extra.length === 1 ? "es" : ""} to the trash.`,
        action: { label: extra.length === 1 ? "Delete the extra copy" : `Delete ${extra.length} extra copies`, do: "dedupe", ids: extra.map((c) => c.id), needsChange: true },
        clip: keep.id,
      });
    }
  }

  const seen = store.data.seenAt || 0;
  const seenPc = store.data.seenPc ?? {};
  const byPc = new Map();
  for (const c of clips) if (c.pc && c.mtime > Math.max(seen, seenPc[c.pc] || 0)) byPc.set(c.pc, [...(byPc.get(c.pc) ?? []), c]);
  for (const [pc, list] of byPc) {
    const games = [...new Set(list.map((c) => c.game))];
    out.push({
      id: `new:${pc}`,
      kind: "new",
      title: `${plural(list.length, "new clip")} from ${pc}`,
      detail: `${games.slice(0, 3).join(", ")}${games.length > 3 ? ` and ${games.length - 3} more` : ""}.`,
      action: { label: "Show them", do: "filter-pc", pc },
      clip: list.sort((a, b) => b.mtime - a.mtime)[0].id,
    });
  }
  return out.filter((n) => !store.isHidden(n.id));
}

/** Hide a notice. New-clip notices mark that PC's clips as seen instead, so later ones show again. */
export async function hideNotice(id, store) {
  if (id.startsWith("new:")) {
    store.data.seenPc = { ...(store.data.seenPc ?? {}), [id.slice(4)]: Date.now() };
    return store.save();
  }
  return store.hide(id);
}

/** Move every clip of `game` into the folder named after the game. -> number moved */
export async function mergeFolders(clips, game, root) {
  const target = path.join(root, game);
  await mkdir(target, { recursive: true });
  let moved = 0;
  const left = new Set();
  for (const c of clips) {
    if (c.game !== game || (c.folder ?? c.game) === game || !c.rel.includes("/")) continue;
    const to = await freePath(target, c.name);
    await rename(path.join(root, ...c.rel.split("/")), to);
    left.add(path.join(root, c.rel.split("/")[0]));
    moved++;
  }
  // The old folders, if nothing else is in them now.
  for (const d of left) await rmdir(d).catch(() => {});
  return moved;
}
