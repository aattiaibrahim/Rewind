import { RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/** One day section in the library: its date, and how many clips. */
export type TimelineDay = { key: string; ts: number; count: number };

type Mark = { key: string; ts: number; y: number; month?: string; year?: string };

/**
 * Immich-style date scrubber down the right edge of the library: a tick per
 * day, month (and year) labels, a bubble with the date under the pointer,
 * and click or drag to jump. Positions follow the real layout of the day
 * sections, so a day with many clips takes up more of the rail.
 */
export function Timeline({ scroller, days }: { scroller: RefObject<HTMLDivElement | null>; days: TimelineDay[] }) {
  const rail = useRef<HTMLDivElement>(null);
  const [marks, setMarks] = useState<Mark[]>([]);
  const [view, setView] = useState({ top: 0, height: 0 });
  const [hover, setHover] = useState<{ y: number; label: string } | null>(null);
  const dragging = useRef(false);

  // Where each day section sits, as a share of the whole scroll height.
  const measure = useCallback(() => {
    const sc = scroller.current;
    const r = rail.current;
    if (!sc || !r) return;
    const total = Math.max(1, sc.scrollHeight);
    const h = r.clientHeight;
    const now = new Date();
    let lastMonth = "";
    let lastYear = "";
    let lastLabelY = -99;
    const out: Mark[] = [];
    for (const d of days) {
      const el = sc.querySelector<HTMLElement>(`[data-day="${CSS.escape(d.key)}"]`);
      if (!el) continue;
      const y = (el.offsetTop / total) * h;
      const date = new Date(d.ts);
      const month = date.toLocaleDateString(undefined, { month: "short" });
      const year = String(date.getFullYear());
      const m: Mark = { key: d.key, ts: d.ts, y };
      // Like Immich: every year gets a label where it starts (the top too);
      // months get one where they change, if there's room.
      if (year !== lastYear) {
        m.year = year;
        if (`${month} ${year}` !== `${lastMonth} ${lastYear}` && y - lastLabelY > 26) m.month = month;
        lastLabelY = y;
      } else if (month !== lastMonth && y - lastLabelY > 16) {
        m.month = month;
        lastLabelY = y;
      }
      void now;
      lastMonth = month;
      lastYear = year;
      out.push(m);
    }
    setMarks(out);
    setView({ top: (sc.scrollTop / total) * h, height: (sc.clientHeight / total) * h });
  }, [scroller, days]);

  useLayoutEffect(measure, [measure]);
  useEffect(() => {
    const sc = scroller.current;
    if (!sc) return;
    const onScroll = () => {
      const total = Math.max(1, sc.scrollHeight);
      const h = rail.current?.clientHeight ?? 0;
      setView({ top: (sc.scrollTop / total) * h, height: (sc.clientHeight / total) * h });
    };
    sc.addEventListener("scroll", onScroll, { passive: true });
    // Thumbnails loading, the window resizing: re-measure.
    const ro = new ResizeObserver(() => measure());
    ro.observe(sc);
    if (sc.firstElementChild) ro.observe(sc.firstElementChild);
    Array.from(sc.children).forEach((c) => ro.observe(c));
    return () => {
      sc.removeEventListener("scroll", onScroll);
      ro.disconnect();
    };
  }, [scroller, measure]);

  const dayAt = (y: number) => {
    let best = marks[0];
    for (const m of marks) if (m.y <= y + 1) best = m;
    return best;
  };
  const label = (ts: number) =>
    new Date(ts).toLocaleDateString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      year: new Date(ts).getFullYear() === new Date().getFullYear() ? undefined : "numeric",
    });
  const jump = (clientY: number) => {
    const sc = scroller.current;
    const r = rail.current;
    if (!sc || !r) return;
    const rect = r.getBoundingClientRect();
    const y = Math.max(0, Math.min(rect.height, clientY - rect.top));
    const d = dayAt(y);
    // Snap to the start of the day under the pointer, like Immich.
    const el = d && sc.querySelector<HTMLElement>(`[data-day="${CSS.escape(d.key)}"]`);
    sc.scrollTop = el ? el.offsetTop - 8 : (y / rect.height) * sc.scrollHeight;
  };
  const move = (e: React.PointerEvent) => {
    const rect = rail.current!.getBoundingClientRect();
    const y = Math.max(0, Math.min(rect.height, e.clientY - rect.top));
    const d = dayAt(y);
    setHover(d ? { y, label: label(d.ts) } : null);
    if (dragging.current) jump(e.clientY);
  };

  if (days.length < 2) return <div className="timeline-rail empty-rail" ref={rail} />;
  return (
    <div
      className={`timeline-rail ${hover ? "active" : ""}`}
      ref={rail}
      onPointerMove={move}
      onPointerLeave={() => !dragging.current && setHover(null)}
      onPointerDown={(e) => {
        dragging.current = true;
        e.currentTarget.setPointerCapture(e.pointerId);
        jump(e.clientY);
      }}
      onPointerUp={() => {
        dragging.current = false;
      }}
      role="scrollbar"
      aria-label="Jump to a date"
      aria-orientation="vertical"
      aria-valuenow={Math.round(view.top)}
    >
      <div className="tl-view" style={{ top: view.top, height: Math.max(3, view.height) }} />
      {marks.map((m) => (
        <span key={m.key} className={`tl-day ${m.month || m.year ? "month" : ""} ${m.year ? "year" : ""}`} style={{ top: m.y }}>
          {(m.month || m.year) && (
            <em>
              {m.year && <b>{m.year}</b>}
              {m.month}
            </em>
          )}
        </span>
      ))}
      {hover && (
        <div className="tl-bubble" style={{ top: hover.y }}>
          {hover.label}
        </div>
      )}
    </div>
  );
}
