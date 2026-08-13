import type { Config } from "tailwindcss";

// Semantic tokens are CSS variables set in globals.css, so light (default,
// playful white-gray) and dark (gray palette) themes swap without class churn.
const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  // THE ONE SWITCH BOTH HALVES OBEY. Without this key Tailwind's `dark:`
  // utilities follow the OS (`media`), while every token above follows the
  // `data-theme` attribute - so a dark-device user with a stored "light"
  // choice (or vice versa) got a SPLIT-BRAIN screen: token surfaces one
  // theme, `dark:` utilities the other. That is the owner's "find deals is
  // white while the whole app is dark" screenshot. Keyed to the attribute,
  // the prehydrate script and the toggle drive both systems at once.
  darkMode: ["selector", '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        base: "var(--bg)",
        card: "var(--card)",
        card2: "var(--card2)",
        strong: "var(--text)",
        soft: "var(--muted)",
        faint: "var(--faint)",
        line: "var(--line)",
        brandblue: {
          DEFAULT: "var(--blue)",
          strong: "var(--blue-strong)",
          soft: "var(--blue-soft)",
        },
        brandred: { DEFAULT: "var(--red)", soft: "var(--red-soft)" },
        brandyellow: { DEFAULT: "var(--yellow)", soft: "var(--yellow-soft)" },
        savings: { DEFAULT: "var(--green)", soft: "var(--green-soft)" },
        // Caution text/badges. Existed as class NAMES (bg-warn, text-warn)
        // long before it existed as a color - Tailwind silently compiled
        // them to nothing, so every warning badge rendered unstyled.
        warn: { DEFAULT: "var(--warn)", soft: "var(--warn-soft)" },
        wagreen: {
          DEFAULT: "var(--wa-green)",
          deep: "var(--wa-green-deep)",
          soft: "var(--wa-green-soft)",
        },
      },
      fontFamily: {
        sans: ["var(--font-body)"],
        display: ["var(--font-display)"],
      },
      borderRadius: {
        blob: "1.4rem",
      },
      keyframes: {
        "pulse-ring": {
          "0%": { transform: "scale(0.8)", opacity: "0.7" },
          "80%, 100%": { transform: "scale(2.2)", opacity: "0" },
        },
        "count-pop": {
          "0%": { transform: "scale(1)" },
          "50%": { transform: "scale(1.18)" },
          "100%": { transform: "scale(1)" },
        },
        shimmer: { "100%": { transform: "translateX(100%)" } },
        "slide-up": {
          "0%": { transform: "translateY(14px)", opacity: "0" },
          "100%": { transform: "translateY(0)", opacity: "1" },
        },
        wiggle: {
          "0%,100%": { transform: "rotate(-2deg)" },
          "50%": { transform: "rotate(2deg)" },
        },
      },
      animation: {
        "pulse-ring": "pulse-ring 1.8s cubic-bezier(0.215,0.61,0.355,1) infinite",
        "count-pop": "count-pop 0.4s ease-out",
        shimmer: "shimmer 1.6s infinite",
        "slide-up": "slide-up 0.35s ease-out both",
        wiggle: "wiggle 1.6s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};

export default config;
