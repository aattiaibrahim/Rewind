import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
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
    const c = listen("clips-changed", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      a.then((f) => f());
      b.then((f) => f());
      c.then((f) => f());
      window.removeEventListener("focus", refresh);
    };
  }, [refresh]);
  return [clips, refresh] as const;
}

/**
 * Has this element come near the screen yet? Stays true once it has, so a
 * card loads its thumbnail once and keeps it. `root` is the scrolling box
 * (found by selector) and `margin` how far ahead to start.
 */
export function useNearView<T extends Element>(rootSelector = ".lib-page", margin = "900px 0px") {
  const ref = useRef<T>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    if (near) return;
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") return setNear(true);
    const io = new IntersectionObserver(
      (es) => {
        if (es.some((e) => e.isIntersecting)) {
          setNear(true);
          io.disconnect();
        }
      },
      { root: document.querySelector(rootSelector), rootMargin: margin },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [near, rootSelector, margin]);
  return [ref, near] as const;
}

export function useThumb(path: string, key: string | number = "") {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setSrc(null);
    if (!path) return;
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

/** Theme, accent and motion as attributes on <html>, so the CSS can switch
 *  colours instantly (no re-render). Also remembered locally so the next
 *  launch paints in the right theme before settings have loaded. */
export function useAppearance(settings: Settings | null) {
  useEffect(() => {
    if (!settings) return;
    const look = { theme: settings.theme ?? "midnight", accent: settings.accent ?? "lime", motion: settings.reduceMotion ? "reduce" : "full" };
    applyAppearance(look);
    try {
      localStorage.setItem("rewind.appearance", JSON.stringify(look));
    } catch {
      /* only a start-up nicety */
    }
  }, [settings?.theme, settings?.accent, settings?.reduceMotion]); // eslint-disable-line react-hooks/exhaustive-deps
}

export function applyAppearance(look: { theme: string; accent: string; motion: string }) {
  const el = document.documentElement;
  el.dataset.theme = look.theme;
  el.dataset.accent = look.accent;
  el.dataset.motion = look.motion;
}

/** Paint in the last-used theme before anything loads. */
export function applyCachedAppearance() {
  try {
    const v = localStorage.getItem("rewind.appearance");
    if (v) applyAppearance(JSON.parse(v));
  } catch {
    /* first launch or storage unavailable: defaults */
  }
}
