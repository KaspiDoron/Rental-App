import { ImageResponse } from "next/og";
import { markSvg, BRAND } from "@/lib/brand";

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt = "WheelDeal - AI agents negotiate the cheapest rides near your hotel";

// Social card: bold, playful, unmistakably branded.
export default function OgImage() {
  const badge = `data:image/svg+xml;base64,${Buffer.from(markSvg(320)).toString("base64")}`;

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          background: "linear-gradient(135deg, #2f6fed 0%, #1d5cd6 55%, #16337a 100%)",
          fontFamily: "sans-serif",
          position: "relative",
          overflow: "hidden",
        }}
      >
        {/* playful blobs */}
        <div style={{ position: "absolute", top: -80, right: -80, width: 340, height: 340, borderRadius: 999, background: "#ffb703", opacity: 0.9, display: "flex" }} />
        <div style={{ position: "absolute", bottom: -110, left: -60, width: 300, height: 300, borderRadius: 999, background: "#ef4444", opacity: 0.85, display: "flex" }} />
        <div style={{ position: "absolute", top: 90, left: 480, width: 60, height: 60, borderRadius: 999, background: "#ffffff", opacity: 0.15, display: "flex" }} />

        {/* left: copy */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "center", padding: "70px 0 70px 76px" }}>
          <div style={{ display: "flex", fontSize: 74, fontWeight: 800, color: "#ffffff", letterSpacing: -1 }}>
            Wheel<span style={{ color: "#ffd166" }}>Deal</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", marginTop: 18 }}>
            <div style={{ fontSize: 44, fontWeight: 700, color: "#ffffff", lineHeight: 1.2 }}>
              AI agents bargain for the
            </div>
            <div style={{ fontSize: 44, fontWeight: 800, color: "#ffd166", lineHeight: 1.2 }}>
              cheapest rides near your hotel.
            </div>
          </div>
          <div style={{ display: "flex", gap: 12, marginTop: 34 }}>
            {["Scooters", "Motorcycles", "Cars"].map((chip) => (
              <div
                key={chip}
                style={{
                  fontSize: 24,
                  fontWeight: 800,
                  color: BRAND.ink,
                  background: "#ffffff",
                  borderRadius: 999,
                  padding: "10px 24px",
                  display: "flex",
                }}
              >
                {chip}
              </div>
            ))}
          </div>
          <div style={{ display: "flex", marginTop: 22, fontSize: 24, fontWeight: 700, color: "#bcd2ff" }}>
            Live negotiation · Real Google reviews · 80% off launch
          </div>
        </div>

        {/* right: mark in a white tile */}
        <div style={{ display: "flex", alignItems: "center", paddingRight: 80 }}>
          <div
            style={{
              width: 380,
              height: 380,
              background: "#ffffff",
              borderRadius: 72,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              boxShadow: "0 30px 60px rgba(0,0,0,0.35)",
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img width={320} height={320} src={badge} alt="" />
          </div>
        </div>
      </div>
    ),
    { ...size }
  );
}
