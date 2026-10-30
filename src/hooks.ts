import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useState } from "react";
import { api, ClipFile, Settings, Status, UpdateState } from "./api";

export function useUpdate() {
  const [u, setU] = useState<UpdateState | null>(null);
  useEffect(() => {
    api.getUpdateState().then(setU).catch(() => {});
    const un = listen<UpdateState>("update-state", (e) =>
      setU((prev) => ({ ...e.payload, current: prev?.current || e.payload.current })),
    );
    return () => {
      un.then((f) => f());
    };
  }, []);
  return u;
}

export function useStatus() {
  const [status, setStatus] = useState<Status | null>(null);
  useEffect(() => {
    api.getStatus().then(setStatus).catch(() => {});
    const un = listen<Status>("engine-status", (e) => setStatus(e.payload));
    return () => {
      un.then((f) => f());
    };
  }, []);
  return status;
}

export function useSettings() {
  const [settings, setLocal] = useState<Settings | null>(null);
  useEffect(() => {
    api.getSettings().then(setLocal).catch(() => {});
    const un = listen<Settings>("settings-changed", (e) => setLocal(e.payload));
    return () => {
      un.then((f) => f());
    };
  }, []);
  const update = useCallback(async (patch: Partial<Settings>) => {
    const current = await api.getSettings();
    const next = { ...current, ...patch };
    setLocal(next);
    await api.setSettings(next);
  }, []);
  return [settings, update] as const;
}

/** The clip list, refreshed when a clip is saved or the clips folder changes. */
export function useClips() {
  const [clips, setClips] = useState<ClipFile[] | null>(null);
  const refresh = useCallback(() => {
    api.listClips().then(setClips).catch(() => setClips([]));
  }, []);
  useEffect(() => {
    refresh();
    const a = listen("clip-saved", refresh);
    const b = listen("settings-changed", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      a.then((f) => f());
      b.then((f) => f());
      window.removeEventListener("focus", refresh);
    };
  }, [refresh]);
  return [clips, refresh] as const;
}

export function useThumb(path: string, key: string | number = "") {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setSrc(null);
    api
      .thumbnail(path, String(key))
      .then((s) => alive && setSrc(s))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [path, key]);
  return src;
}
