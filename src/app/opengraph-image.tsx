import { ImageResponse } from "next/og";
import { markSvg, BRAND } from "@/lib/brand";

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt = "WheelDeal - cheapest local rides, negotiated for you";

// Social preview card: playful, clean, blue / red / yellow on white-gray.
export default function OgImage() {
  const badge = `data:image/svg+xml;base64,${Buffer.from(markSvg(240)).toString(
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
          padding: "70px",
          background: "linear-gradient(150deg, #ffffff 0%, #f4f6f9 60%, #e8eefb 100%)",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "30px" }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img width={150} height={150} src={badge} alt="" />
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div style={{ display: "flex", fontSize: 72, fontWeight: 800, color: BRAND.ink, letterSpacing: -1 }}>
              Wheel<span style={{ color: BRAND.blue }}>Deal</span>
            </div>
            <div style={{ fontSize: 30, color: BRAND.red, fontWeight: 700 }}>
              Rental savings & negotiation engine
            </div>
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ fontSize: 52, color: BRAND.ink, fontWeight: 700, lineHeight: 1.15 }}>
            AI agents find and negotiate the
          </div>
          <div style={{ fontSize: 52, fontWeight: 800, lineHeight: 1.15, color: BRAND.blue }}>
            cheapest rides near your hotel.
          </div>
        </div>

        <div style={{ display: "flex", gap: 16 }}>
          {[
            ["Live negotiation", BRAND.blue],
            ["Real map & reviews", BRAND.green],
            ["Smart bargain", BRAND.red],
            ["80% off launch", BRAND.yellow],
          ].map(([chip, color]) => (
            <div
              key={chip}
              style={{
                fontSize: 26,
                fontWeight: 700,
                color: "#ffffff",
                background: color,
                borderRadius: 999,
                padding: "12px 28px",
                display: "flex",
              }}
            >
              {chip}
            </div>
          ))}
        </div>
      </div>
    ),
    { ...size }
  );
}
