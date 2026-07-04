import { ImageResponse } from "next/og";
import { markSvg, BRAND } from "@/lib/brand";

export const runtime = "edge";

// X (Twitter) profile banner, exactly 1500x500. Downloadable from the owner's
// Brand kit card in Profile.
export async function GET() {
  const badge = `data:image/svg+xml;base64,${Buffer.from(markSvg(300)).toString("base64")}`;

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          background: "linear-gradient(120deg, #2f6fed 0%, #1d5cd6 55%, #16337a 100%)",
          position: "relative",
          overflow: "hidden",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ position: "absolute", top: -90, right: 220, width: 300, height: 300, borderRadius: 999, background: "#ffb703", opacity: 0.9, display: "flex" }} />
        <div style={{ position: "absolute", bottom: -120, left: -40, width: 260, height: 260, borderRadius: 999, background: "#ef4444", opacity: 0.85, display: "flex" }} />

        <div style={{ display: "flex", alignItems: "center", gap: 40, paddingLeft: 90 }}>
          <div
            style={{
              width: 320,
              height: 320,
              background: "#ffffff",
              borderRadius: 64,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              boxShadow: "0 24px 48px rgba(0,0,0,0.35)",
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img width={280} height={280} src={badge} alt="" />
          </div>
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div style={{ display: "flex", fontSize: 84, fontWeight: 800, color: "#ffffff", letterSpacing: -1 }}>
              Wheel<span style={{ color: "#ffd166" }}>Deal</span>
            </div>
            <div style={{ display: "flex", fontSize: 38, fontWeight: 700, color: "#ffffff", marginTop: 6 }}>
              AI agents bargain for the cheapest rides near your hotel
            </div>
            <div style={{ display: "flex", gap: 12, marginTop: 22 }}>
              {["Authentic bargaining", "Scooters · Motorcycles · Cars", "Real shops, real prices"].map((chip) => (
                <div
                  key={chip}
                  style={{
                    fontSize: 22,
                    fontWeight: 800,
                    color: BRAND.ink,
                    background: "#ffffff",
                    borderRadius: 999,
                    padding: "8px 20px",
                    display: "flex",
                  }}
                >
                  {chip}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    ),
    {
      width: 1500,
      height: 500,
      headers: {
        "Content-Disposition": 'attachment; filename="wheeldeal-x-banner.png"',
      },
    }
  );
}
