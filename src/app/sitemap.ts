import type { MetadataRoute } from "next";
import { resolveSiteOrigin } from "@/lib/site";

// Only the pages a signed-out visitor (and therefore a crawler) can actually
// reach. Listing a gated route would advertise a redirect to /login as content,
// which is exactly the "low value content" an AdSense reviewer rejects.
//
// Kept in step with `src/middleware.ts`: every path here is OUTSIDE that
// matcher, so none of them bounces to /login.
const PUBLIC_PATHS = [
  { path: "/welcome", priority: 1, changeFrequency: "weekly" as const },
  { path: "/pricing", priority: 0.8, changeFrequency: "monthly" as const },
  { path: "/terms", priority: 0.3, changeFrequency: "yearly" as const },
  { path: "/privacy", priority: 0.3, changeFrequency: "yearly" as const },
];

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const origin = await resolveSiteOrigin();
  return PUBLIC_PATHS.map(({ path, priority, changeFrequency }) => ({
    url: `${origin}${path}`,
    changeFrequency,
    priority,
  }));
}
