import { useMemo, useState } from "react";
import { api, ClipFile, errText, fmtSize, Settings } from "./api";
import { useThumb } from "./hooks";

const LIMIT = 40;

function when(ms: number) {
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function Row({
  clip,
  onOpen,
  onKeep,
  onShrink,
  onDelete,
}: {
  clip: ClipFile;
  onOpen: () => void;
  onKeep: () => Promise<void>;
  onShrink: () => Promise<void>;
  onDelete: () => Promise<boolean>;
}) {
  const thumb = useThumb(clip.path, clip.modified);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const nasOnly = clip.location === "nas";
  const run = (label: string, f: () => Promise<unknown>) => async () => {
    setBusy(label);
    setErr(null);
    try {
      await f();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="clean-row">
      <button className="clean-thumb" onClick={onOpen} title="Open in Studio">
        {thumb && <img src={thumb} alt="" loading="lazy" />}
      </button>
      <div className="clean-main">
        <div className="card-title">{clip.name}</div>
        <div className="card-meta">
          {clip.folder} · {when(clip.modified)}
          {clip.location === "linked" && ` · ${clip.source}`}
          {nasOnly && " · only on the NAS"}
          {clip.onNas && " · also on the NAS"}
        </div>
        {(busy || err) && <small className={err ? "err-text" : "muted"}>{err ?? busy}</small>}
      </div>
      <div className="clean-size">{fmtSize(clip.size)}</div>
      <div className="row" style={{ flexWrap: "nowrap" }}>
        <button className="btn small" disabled={!!busy} onClick={run("Keeping…", onKeep)} title="Hide it until the next cleanup check">
          Keep
        </button>
        <button
          className="btn small"
          disabled={!!busy || nasOnly}
          onClick={run("Shrinking… this can take a minute", onShrink)}
          title={nasOnly ? "It's only on the NAS: use Cleanup in the NAS app" : "Re-encode it to about 40% of the size; the original goes to the Recycle Bin"}
        >
          Shrink
        </button>
        <button
          className="btn small danger"
          disabled={!!busy || nasOnly}
          onClick={run("Deleting…", onDelete)}
          title={nasOnly ? "It's only on the NAS: use Cleanup in the NAS app (it has a 30-day trash)" : "Move it to the Recycle Bin"}
        >
          Delete
        </button>
      </div>
    </div>
  );
}

/**
 * Cleanup: the biggest clips, so you can free up space. Delete (Recycle Bin), Shrink
 * (re-encode smaller, original to the Recycle Bin) or Keep (hidden until the next
 * cleanup check).
 */
export function Cleanup({
  clips,
  settings,
  update,
  onOpen,
  onDelete,
  onToast,
  onChanged,
}: {
  clips: ClipFile[] | null;
  settings: Settings;
  update: (p: Partial<Settings>) => void;
  onOpen: (path: string) => void;
  onDelete: (paths: string[]) => Promise<boolean>;
  onToast: (t: string, err?: boolean) => void;
  onChanged: () => void;
}) {
  const kept = settings.cleanupKept ?? {};
  const all = clips ?? [];
  const total = all.reduce((n, c) => n + c.size, 0);
  const keptCount = all.filter((c) => kept[c.path] === c.size).length;
  const biggest = useMemo(
    () => [...(clips ?? [])].filter((c) => kept[c.path] !== c.size).sort((a, b) => b.size - a.size).slice(0, LIMIT),
    [clips, kept],
  );
  const shown = biggest.reduce((n, c) => n + c.size, 0);
  const here = all.filter((c) => c.location !== "nas").reduce((n, c) => n + c.size, 0);

  return (
    <div className="page cleanup-page">
      <div className="toolbar">
        <h1 style={{ flex: 1 }}>Cleanup</h1>
        <button className="btn primary" onClick={() => update({ cleanupKept: {} })} title="List every clip again, including the ones you kept">
          Run cleanup check
        </button>
      </div>
      <p className="muted" style={{ margin: 0, maxWidth: 760, lineHeight: 1.5 }}>
        Your clips use <strong>{fmtSize(total)}</strong>
        {here !== total && <> ({fmtSize(here)} on this PC)</>}.{" "}
        {biggest.length
          ? `These ${biggest.length} biggest ones take ${fmtSize(shown)}. `
          : "Nothing left to look at: every big clip has been kept or cleaned up. "}
        Delete sends a clip to the Recycle Bin, Shrink re-encodes it to about 40% of the size, and Keep hides it until your
        next cleanup check.
        {keptCount > 0 && ` ${keptCount} kept since the last check.`}
      </p>
      <div className="clean-list">
        {biggest.map((c) => (
          <Row
            key={c.path}
            clip={c}
            onOpen={() => onOpen(c.path)}
            onKeep={async () => update({ cleanupKept: { ...kept, [c.path]: c.size } })}
            onShrink={async () => {
              const before = c.size;
              await api.shrinkClip(c.path);
              onToast(`Shrank ${c.name} (it was ${fmtSize(before)})`);
              onChanged();
            }}
            onDelete={async () => {
              const done = await onDelete([c.path]);
              if (done) onChanged();
              return done;
            }}
          />
        ))}
      </div>
    </div>
  );
}
