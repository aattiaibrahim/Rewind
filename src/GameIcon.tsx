import { useEffect, useState } from "react";
import { api } from "./api";

/** Same colour for the same game, from its name. */
function hue(name: string) {
  let h = 0;
  for (const c of name.toLowerCase()) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

/**
 * A game's logo: its own program icon when the game is installed or has been
 * played, else a coloured tile with its first letter. "Desktop" and recorder
 * folders get the letter tile too.
 */
export function GameIcon({ name, size = 18 }: { name: string; size?: number }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setSrc(null);
    if (name && name !== "All") api.gameIcon(name).then((s) => alive && setSrc(s));
    return () => {
      alive = false;
    };
  }, [name]);
  if (src) return <img className="game-icon" src={src} alt="" width={size} height={size} style={{ width: size, height: size }} />;
  const letter = (name.match(/[A-Za-z0-9]/)?.[0] ?? "?").toUpperCase();
  return (
    <span
      className="game-icon letter"
      aria-hidden="true"
      style={{ width: size, height: size, fontSize: size * 0.58, background: `hsl(${hue(name)} 45% 32%)` }}
    >
      {letter}
    </span>
  );
}
