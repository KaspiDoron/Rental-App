import type { Metadata, Viewport } from "next";
import "./globals.css";

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || "https://wheeldeal.vercel.app";
const title = "WheelDeal - cheapest local rides, negotiated for you";
const description =
  "AI agents find and negotiate the cheapest car, motorbike & scooter rentals near your hotel. Live bargaining, map + list, biggest savings first.";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: title,
    template: "%s · WheelDeal",
  },
  description,
  applicationName: "WheelDeal",
  keywords: [
    "car rental",
    "motorbike rental",
    "scooter hire",
    "travel savings",
    "rental negotiation",
    "cheap rentals",
  ],
  authors: [{ name: "WheelDeal" }],
  creator: "WheelDeal",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "WheelDeal",
    statusBarStyle: "black-translucent",
  },
  formatDetection: { telephone: false },
  openGraph: {
    type: "website",
    siteName: "WheelDeal",
    title,
    description,
    url: siteUrl,
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    title,
    description,
  },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
  themeColor: "#070b13",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="app-shell">{children}</body>
    </html>
  );
}
