import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: {
          DEFAULT: "#0b1220",
          soft: "#111b2e",
          muted: "#1b2942",
        },
        savings: {
          DEFAULT: "#10b981",
          bright: "#34d399",
          deep: "#059669",
        },
        gold: "#f5c451",
      },
      fontFamily: {
        sans: ["var(--font-sans)", "system-ui", "sans-serif"],
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
        shimmer: {
          "100%": { transform: "translateX(100%)" },
        },
        "slide-up": {
          "0%": { transform: "translateY(12px)", opacity: "0" },
          "100%": { transform: "translateY(0)", opacity: "1" },
        },
      },
      animation: {
        "pulse-ring": "pulse-ring 1.8s cubic-bezier(0.215,0.61,0.355,1) infinite",
        "count-pop": "count-pop 0.4s ease-out",
        shimmer: "shimmer 1.6s infinite",
        "slide-up": "slide-up 0.35s ease-out both",
      },
    },
  },
  plugins: [],
};

export default config;
