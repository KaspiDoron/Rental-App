import type { MetadataRoute } from "next";
import { resolveSiteOrigin } from "@/lib/site";

// Google Search Console and the AdSense review both start here. Without a
// robots.txt the crawler has no sitemap pointer and no statement about what is
// private, and a site whose signed-in surfaces look like thin or duplicate
// content is a common reason a monetization review stalls.
//
// So: the PUBLIC pages are explicitly open, and everything behind the session
// cookie or the admin gate is explicitly closed. This is a crawling hint, not a
// security boundary - the real gate is the HMAC-signed session checked
// server-side on every route.
export default async function robots(): Promise<MetadataRoute.Robots> {
  const origin = await resolveSiteOrigin();
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: ["/api/", "/admin", "/profile", "/deals", "/login"],
      },
      // Explicitly welcome the ad crawler. It is a different bot from
      // Googlebot and it is the one that decides whether a page can be
      // monetized at all.
      { userAgent: "Mediapartners-Google", allow: "/" },
    ],
    sitemap: `${origin}/sitemap.xml`,
    host: origin,
  };
}
