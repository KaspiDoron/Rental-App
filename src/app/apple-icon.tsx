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
      // Nudge the mark left: the artwork's visual weight sits right of its
      // bounding box, so a small negative offset makes it LOOK centred on the
      // home screen.
      <div
        style={{
          display: "flex",
          width: "100%",
          height: "100%",
          background: "#f4f6f9",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          width={180}
          height={180}
          src={dataUri}
          alt="WheelDeal"
          style={{ marginLeft: -10 }}
        />
      </div>
    ),
    { ...size }
  );
}
