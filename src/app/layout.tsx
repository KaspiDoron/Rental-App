import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "WheelDeal — cheapest local rides, negotiated for you",
  description:
    "Hyper-local vehicle rental savings engine. AI agents find and negotiate the cheapest car, motorbike & scooter rentals near your hotel.",
  applicationName: "WheelDeal",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  themeColor: "#070b13",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
