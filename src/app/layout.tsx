import type { Metadata, Viewport } from "next";
import { Baloo_2, Nunito, Rubik, Secular_One } from "next/font/google";
import { I18nProvider } from "@/lib/i18n";
import { WillAssistantProvider } from "@/components/will/WillAssistantProvider";
import { NavVeil } from "@/components/NavVeil";
import { AmbientGlow } from "@/components/AmbientGlow";
import { PageFade } from "@/components/PageFade";
import { OfflineBanner } from "@/components/OfflineBanner";
import { ADSENSE_PUBLISHER, resolveSiteOrigin } from "@/lib/site";
import { TestModeBanner } from "@/components/TestModeBanner";
import { FirstTouchTerms } from "@/components/FirstTouchTerms";
import "./globals.css";

// SELF-HOSTED, NOT FETCHED AT RUNTIME.
//
// The two brand faces were pulled with a `<link>` to fonts.googleapis.com, so
// every cold open cost a DNS lookup, a TLS handshake and a CSS round trip to a
// third party BEFORE a single glyph could be requested - and `display=swap`
// meant the app painted in the system font and then reflowed when they landed.
// That reflow is layout shift on the most text-dense screen in the app, and on
// a hotel wifi in Ko Tao it is a visible second of it.
//
// `next/font` downloads both families at BUILD time, serves them from our own
// origin, and emits a `@font-face` with metric overrides so the fallback
// occupies the same space as the real face - the swap stops moving anything.
// It also removes a third-party request from the critical path, which is the
// part that mattered on a slow connection.
const nunito = Nunito({
  subsets: ["latin"],
  weight: ["400", "600", "700", "800"],
  variable: "--wd-font-body",
  display: "swap",
  // Adjusts the fallback face's metrics to match, so the swap is invisible.
  adjustFontFallback: true,
});

const baloo = Baloo_2({
  subsets: ["latin"],
  weight: ["600", "700", "800"],
  variable: "--wd-font-display",
  display: "swap",
  adjustFontFallback: true,
});

// THE HEBREW FACES (owner report 3, item 10). Neither brand font carries
// Hebrew glyphs, so Hebrew fell through to an arbitrary system face - the
// "not premium enough" in the owner's screenshots. These sit AFTER the Latin
// families in the --font-body/--font-display ladders (globals.css): font
// fallback is per-CHARACTER, so Latin stays pixel-identical on Nunito/Baloo
// while Hebrew glyphs resolve to Rubik (body) and Secular One (display).
const rubik = Rubik({
  subsets: ["hebrew", "latin"],
  weight: ["400", "500", "600", "700", "800"],
  variable: "--wd-font-body-he",
  display: "swap",
  adjustFontFallback: true,
});

const secular = Secular_One({
  // Secular One ships ONE weight; .font-display gets font-synthesis-weight:
  // none so browsers never smear a fake bold onto it.
  subsets: ["hebrew", "latin"],
  weight: "400",
  variable: "--wd-font-display-he",
  display: "swap",
  adjustFontFallback: true,
});

const title = "WheelDeal - cheapest local rides, negotiated for you";
const description =
  "AI agents find and negotiate the cheapest car, manual motorcycle & automatic scooter rentals near your hotel. Live bargaining, map + list, biggest savings first.";

// Correct absolute URLs are what make the WhatsApp/Telegram/X share preview
// (og:image) work. The resolution order - owner-set APP_DOMAIN in the Key Vault
// (so a domain move needs no redeploy), then the build env, then the brand
// default - lives in `@/lib/site` and is shared with push identity, the
// geocoder User-Agent, robots and the sitemap.
export async function generateMetadata(): Promise<Metadata> {
  const siteUrl = await resolveSiteOrigin();
  // Same resolution order as every other key: the admin Key Vault first, then
  // the environment. Best-effort - social card metadata never blocks a render.
  const { getConfig } = await import("@/lib/runtime-config");
  const twitterHandle = await getConfig("TWITTER_HANDLE").catch(() => "");
  return {
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
      // ONE PLACE A KEY LIVES. The admin Key Vault writes TWITTER_HANDLE and
      // the Keys screen reads it back, so the owner sets it and nothing
      // changes - this read went straight to process.env, which on Cloud Run
      // is whatever was baked at deploy time. Every other integration key
      // resolves through getConfig for exactly this reason.
      site: twitterHandle || undefined,
      creator: twitterHandle || undefined,
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
      // Google AdSense account verification. Google looks for this tag (or the
      // ads.txt file, or the script) when reviewing site ownership, and it must
      // be present on EVERY page - hence the root layout rather than a page.
      "google-adsense-account": ADSENSE_PUBLISHER,
    },
  };
}

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

// Apply the saved theme AND direction before first paint.
//
// The theme half avoids a colour flash. The direction half fixes I-6c: `dir`
// was set only by the i18n provider's effect, which runs AFTER hydration - so
// every Hebrew/Arabic cold load painted left-to-right and then snapped to RTL,
// a visible mirror-flip on the first frame. Reading `wd_lang` here and stamping
// `dir`/`lang` on <html> before paint makes the very first frame correct.
//
// The RTL set is inlined as a literal rather than imported because this string
// runs before any module loads. It must stay in sync with LANGS' `rtl: true`
// entries in src/lib/i18n.tsx - a test pins that it does.
//
// The storage read sits in its OWN try: when localStorage throws (private
// mode, blocked storage) the OS fallback and the attribute stamp must still
// run - one shared try/catch made a storage exception silently strand a
// dark-OS visitor on the light theme. The stored value is also validated, so
// a corrupted "wd_theme" falls back to the OS instead of stamping garbage.
const themeScript = `
var t = null;
try { t = localStorage.getItem("wd_theme"); } catch (e) {}
try {
  if (t !== "dark" && t !== "light")
    t = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  document.documentElement.setAttribute("data-theme", t);
} catch (e) {}
try {
  var l = localStorage.getItem("wd_lang");
  if (l) {
    document.documentElement.setAttribute("lang", l);
    document.documentElement.setAttribute("dir", (l === "he" || l === "ar") ? "rtl" : "ltr");
  }
} catch (e) {}
`;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      // The two font variables land on the root, where globals.css reads them.
      className={`${nunito.variable} ${baloo.variable} ${rubik.variable} ${secular.variable}`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
        {/* Google AdSense site-level tag. UNCONDITIONAL: Google's reviewer
            fetches the page anonymously and fails the site if the tag is not
            already there, so it cannot wait on an env var being set. The
            publisher id is public by design (it ships in ads.txt and in every
            ad request), so it is a constant, not a secret.

            Individual slots still render only on the free tier via <AdBanner>;
            paid plans stay 100% ad-free. This tag loads the SDK, it does not
            place an ad. */}
        <script
          async
          src={`https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${ADSENSE_PUBLISHER}`}
          crossOrigin="anonymous"
        />
      </head>
      <body className="app-shell">
        <I18nProvider>
          {/* Will's concierge brain: funnel step + idle detection, shared across
              Find Deals / Profile / Login so guidance survives the pairing hop. */}
          <WillAssistantProvider>
            {/* The page canvas owns horizontal clipping so the ROOT does not -
                see .app-canvas in globals.css.
                
                It must NEVER carry a transform, a filter or an animation that
                leaves one behind: both would make it the containing block for
                every `position: fixed` element inside it. `page-fade` is
                opacity-only for exactly that reason. */}
            {/* The whole-screen loading wash - a permanent SIBLING of the
                canvas (never inside it: the canvas clips X and must stay
                transform-free). It paints only while something raised it. */}
            <AmbientGlow />
            {/* PageFade keys the canvas per pathname so the fade re-runs on
                CLIENT navigations too - under router.push this div used to
                persist and the new page popped in with no ease. The canvas
                rules (opacity-only, never a transform) live in PageFade. */}
            <PageFade>{children}</PageFade>
            <NavVeil />
            <OfflineBanner />
            <TestModeBanner />
            {/* MANDATORY FIRST TOUCH. Not dismissable, no backdrop tap: the app
                is behind it until the acceptance is RECORDED with its version,
                so a terms bump asks again instead of changing the document
                under everyone silently. Signed-out visitors never see it - the
                gate is decided server-side in /api/auth/me. */}
            <FirstTouchTerms />
          </WillAssistantProvider>
        </I18nProvider>
      </body>
    </html>
  );
}
