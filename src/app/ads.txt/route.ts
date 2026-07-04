// Serves /ads.txt so Google AdSense can verify ad inventory ownership.
// Uses the configured ADSENSE_CLIENT (ca-pub-...).
export async function GET() {
  const client = (process.env.ADSENSE_CLIENT || "").trim();
  const pub = client.replace(/^ca-/, ""); // ads.txt uses pub-... without "ca-"
  const body = pub
    ? `google.com, ${pub}, DIRECT, f08c47fec0942fa0\n`
    : "# Set ADSENSE_CLIENT to publish ads.txt\n";
  return new Response(body, {
    headers: { "Content-Type": "text/plain", "Cache-Control": "public, max-age=86400" },
  });
}
