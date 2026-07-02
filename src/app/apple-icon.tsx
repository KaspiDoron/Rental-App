import { ImageResponse } from "next/og";
import { markSvg } from "@/lib/brand";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

// iOS home-screen icon. iOS composites transparency onto black, so we paint a
// clean light backdrop behind the transparent mark.
export default function AppleIcon() {
  const dataUri = `data:image/svg+xml;base64,${Buffer.from(
    markSvg(180, "#f4f6f9")
  ).toString("base64")}`;
  return new ImageResponse(
    (
      <div style={{ display: "flex", width: "100%", height: "100%" }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img width={180} height={180} src={dataUri} alt="WheelDeal" />
      </div>
    ),
    { ...size }
  );
}
