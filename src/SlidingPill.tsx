import { useLayoutEffect, useRef } from "react";

/**
 * A highlight that slides to whichever option is selected (the child with
 * class "on"), instead of each option fading its own background in and out.
 * Drop it in as the first child of any group of options: tabs, a segmented
 * control, chips, the sidebar. It follows the selection by watching class
 * changes, so the options themselves don't change at all.
 */
export function SlidingPill({ selector = ".on" }: { selector?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const pill = ref.current;
    const box = pill?.parentElement;
    if (!pill || !box) return;
    box.classList.add("has-pill");
    let first = true;
    let frame = 0;
    const place = () => {
      const on = box.querySelector<HTMLElement>(`:scope > ${selector}`);
      if (!on) {
        pill.style.opacity = "0";
        return;
      }
      // The first placement jumps straight there; after that it glides.
      if (first) pill.style.transition = "none";
      pill.style.opacity = "1";
      pill.style.transform = `translate(${on.offsetLeft}px, ${on.offsetTop}px)`;
      pill.style.width = `${on.offsetWidth}px`;
      pill.style.height = `${on.offsetHeight}px`;
      pill.style.borderRadius = getComputedStyle(on).borderRadius;
      if (first) {
        void pill.offsetWidth;
        pill.style.transition = "";
        first = false;
      }
    };
    const soon = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(place);
    };
    place();
    const mo = new MutationObserver(soon);
    mo.observe(box, { subtree: true, attributes: true, attributeFilter: ["class"], childList: true });
    const ro = new ResizeObserver(soon);
    ro.observe(box);
    return () => {
      mo.disconnect();
      ro.disconnect();
      cancelAnimationFrame(frame);
      box.classList.remove("has-pill");
    };
  }, [selector]);
  return <span ref={ref} className="slide-pill" aria-hidden="true" />;
}
