import type { Metadata, Viewport } from "next";
import "./globals.css";

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || "https://wheeldeal.vercel.app";
const title = "WheelDeal - cheapest local rides, negotiated for you";
const description =
  "AI agents find and negotiate the cheapest car, manual motorcycle & automatic scooter rentals near your hotel. Live bargaining, map + list, biggest savings first.";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: { default: title, template: "%s · WheelDeal" },
  description,
  applicationName: "WheelDeal",
  keywords: [
    "car rental",
    "motorcycle rental",
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
    statusBarStyle: "default",
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
  twitter: { card: "summary_large_image", title, description },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f4f6f9" },
    { media: "(prefers-color-scheme: dark)", color: "#17191d" },
  ],
};

// Apply the saved theme before first paint to avoid a flash.
const themeScript = `
try {
  var t = localStorage.getItem("wd_theme");
  if (!t) t = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  document.documentElement.setAttribute("data-theme", t);
} catch (e) {}
`;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        {/* eslint-disable-next-line @next/next/no-page-custom-font */}
        <link
          href="https://fonts.googleapis.com/css2?family=Baloo+2:wght@600;700;800&family=Nunito:wght@400;600;700;800&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="app-shell">{children}</body>
    </html>
  );
}
