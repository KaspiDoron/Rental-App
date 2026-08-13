"use client";

import { useEffect, useState } from "react";
import { readTheme, applyTheme, type Theme } from "@/lib/client/theme";

// THE THEME IS A TOP-NAV DECISION NOW (owner report 3, item 1).
//
// The only way to switch themes was a control buried in Profile ->
// Preferences - so a traveller on a dark phone who landed on a light screen
// had no visible way out of the mismatch. This is the LanguageButton chip
// pattern, one tap, mounted beside it in every topbar.
//
// State starts as null and reads the DOM after mount: the server renders no
// theme, the prehydrate script stamps it before paint, and rendering a
// guessed icon would flash the wrong glyph on hydration.
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme | null>(null);

  useEffect(() => {
    setTheme(readTheme());
  }, []);

  const next: Theme = theme === "dark" ? "light" : "dark";

  return (
    <button
      onClick={() => {
        applyTheme(next);
        setTheme(next);
      }}
      aria-label="Toggle dark mode"
      aria-pressed={theme === "dark"}
      className="btn btn-sm chip flex items-center gap-1 rounded-full border-2 border-line bg-card px-2.5 py-1 text-[13px] font-extrabold text-strong"
    >
      {/* Both glyphs stay in the DOM so the tap target never reflows; the
          inactive one is hidden. Before mount neither shows - a blank chip
          for one frame beats a wrong one. */}
      <span aria-hidden className={theme === "dark" ? "" : "hidden"}>
        ☀️
      </span>
      <span aria-hidden className={theme === "light" ? "" : "hidden"}>
        🌙
      </span>
      {theme === null && (
        <span aria-hidden className="inline-block h-[1em] w-[1em]" />
      )}
    </button>
  );
}
