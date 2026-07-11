import type { MetadataRoute } from "next";

// PWA manifest. `display: standalone` + the apple-web-app meta in layout make
// the app run chromeless (no browser URL bar) once added to the home screen,
// giving it a native, App Store feel.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "WheelDeal - rental savings engine",
    short_name: "WheelDeal",
    description:
      "AI agents find and negotiate the cheapest car, motorbike & scooter rentals near your hotel.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    // Match the app's real light background so the PWA launch splash doesn't
    // flash a blue-black that belongs to neither theme.
    background_color: "#f4f6f9",
    theme_color: "#f4f6f9",
    categories: ["travel", "shopping", "productivity"],
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "maskable" },
      { src: "/apple-icon", sizes: "180x180", type: "image/png" },
    ],
  };
}
