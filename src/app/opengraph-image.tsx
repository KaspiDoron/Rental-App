import { ImageResponse } from "next/og";
import { markSvg, BRAND } from "@/lib/brand";

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt = "WheelDeal - cheapest local rides, negotiated for you";

// Rich social preview card (Open Graph / shared everywhere).
export default function OgImage() {
  const badge = `data:image/svg+xml;base64,${Buffer.from(markSvg(220)).toString(
    "base64"
  )}`;

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "72px",
          background:
            "linear-gradient(135deg, #04070d 0%, #0b1220 55%, #06231d 100%)",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "28px" }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img width={132} height={132} src={badge} alt="" />
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div style={{ fontSize: 68, fontWeight: 800, color: "white", letterSpacing: -1 }}>
              WheelDeal
            </div>
            <div style={{ fontSize: 28, color: BRAND.mint, fontWeight: 600 }}>
              Rental savings & negotiation engine
            </div>
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          <div style={{ fontSize: 52, color: "white", fontWeight: 700, lineHeight: 1.15 }}>
            AI agents find and negotiate the
          </div>
          <div style={{ fontSize: 52, fontWeight: 800, lineHeight: 1.15, color: BRAND.mint }}>
            cheapest car & motorbike rentals near you.
          </div>
        </div>

        <div style={{ display: "flex", gap: 16 }}>
          {["Live negotiation", "Map + list", "Smart bargain", "Zero-cost"].map(
            (chip) => (
              <div
                key={chip}
                style={{
                  fontSize: 26,
                  color: "#cbd5e1",
                  border: "1px solid rgba(148,163,184,0.35)",
                  borderRadius: 999,
                  padding: "10px 26px",
                  display: "flex",
                }}
              >
                {chip}
              </div>
            )
          )}
        </div>
      </div>
    ),
    { ...size }
  );
}
