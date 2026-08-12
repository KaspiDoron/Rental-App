import Link from "next/link";
import { GUIDES } from "@/lib/guides";

// The public guides hub. Crawlable, outside the middleware matcher, and listed
// in the sitemap - see src/lib/guides.ts for why this exists at all.
export const metadata = {
  title: "Rental guides - WheelDeal",
  description:
    "Honest, practical guides to renting a scooter or car in Southeast Asia: what prices are real, what deposits are normal, and what to check before you ride away.",
  robots: { index: true, follow: true },
};

export default function GuidesPage() {
  return (
    <main className="mx-auto max-w-2xl px-4 py-6 pb-safe">
      <Link href="/welcome" className="text-[13px] font-bold text-brandblue">
        ← WheelDeal
      </Link>
      <h1 className="mt-4 text-[26px] font-extrabold leading-tight text-strong">
        Renting a scooter or car abroad, without the guesswork
      </h1>
      <p className="mt-2 text-[14px] leading-relaxed text-soft">
        Everything below is the same ground our agents negotiate on every day -
        real price bands, the deposits that are normal, and the handful of things
        genuinely worth checking before you ride away. No affiliate links, no
        &ldquo;top 10 shops&rdquo;.
      </p>
      <ul className="mt-6 space-y-3">
        {GUIDES.map((g) => (
          <li key={g.slug}>
            <Link
              href={`/guides/${g.slug}`}
              className="block rounded-2xl border-2 border-line bg-card p-4 transition hover:border-brandblue/50"
            >
              <span className="block text-[15px] font-extrabold text-strong">{g.title}</span>
              <span className="mt-1 block text-[13px] leading-relaxed text-soft">{g.summary}</span>
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
