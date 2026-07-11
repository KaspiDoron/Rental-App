import type { Metadata, Viewport } from "next";
import { I18nProvider } from "@/lib/i18n";
import { NavVeil } from "@/components/NavVeil";
import { DomTranslator } from "@/components/DomTranslator";
import { OfflineBanner } from "@/components/OfflineBanner";
import "./globals.css";

// Correct absolute URLs are what make the WhatsApp/Telegram/X share preview
// (og:image) work. Priority: explicit NEXT_PUBLIC_SITE_URL -> Vercel's
// production domain -> current deployment URL -> fallback.
const siteUrl =
  process.env.NEXT_PUBLIC_SITE_URL ||
  (process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : "https://wheeldeal.vercel.app");
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
  twitter: {
    card: "summary_large_image",
    title,
    description,
    site: process.env.TWITTER_HANDLE || undefined,
    creator: process.env.TWITTER_HANDLE || undefined,
  },
  robots: { index: true, follow: true },
  alternates: { canonical: "/" },
  category: "travel",
  generator: "WheelDeal",
  referrer: "origin-when-cross-origin",
  icons: {
    icon: [{ url: "/icon.svg", type: "image/svg+xml" }],
    apple: [{ url: "/apple-icon", sizes: "180x180", type: "image/png" }],
  },
  other: {
    "msapplication-TileColor": "#2f6fed",
    "apple-mobile-web-app-title": "WheelDeal",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Pinch-zoom stays ENABLED for accessibility (WCAG 1.4.4). Form controls are
  // all >= 16px so iOS never auto-zooms on focus - we don't need to disable it.
  maximumScale: 5,
  userScalable: true,
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
        {/* Google AdSense (site-level tag so Google can review the site).
            Individual slots render only on the free tier via <AdBanner>. */}
        {process.env.ADSENSE_CLIENT && (
          <script
            async
            src={`https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${process.env.ADSENSE_CLIENT}`}
            crossOrigin="anonymous"
          />
        )}
      </head>
      <body className="app-shell">
        <I18nProvider>
          {children}
          <NavVeil />
          <DomTranslator />
          <OfflineBanner />
        </I18nProvider>
      </body>
    </html>
  );
}
