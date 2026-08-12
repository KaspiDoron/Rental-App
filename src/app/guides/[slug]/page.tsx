import Link from "next/link";
import { notFound } from "next/navigation";
import { GUIDES, guideBySlug } from "@/lib/guides";

// Statically generated from the same array the hub and the sitemap read, so a
// guide cannot be listed without existing or exist without being listed.
export function generateStaticParams() {
  return GUIDES.map((g) => ({ slug: g.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const guide = guideBySlug(slug);
  if (!guide) return { title: "Guide - WheelDeal" };
  return {
    title: `${guide.title} - WheelDeal`,
    description: guide.summary,
    robots: { index: true, follow: true },
  };
}

export default async function GuidePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const guide = guideBySlug(slug);
  if (!guide) notFound();

  return (
    <main className="mx-auto max-w-2xl px-4 py-6 pb-safe">
      <Link href="/guides" className="text-[13px] font-bold text-brandblue">
        ← All guides
      </Link>
      <h1 className="mt-4 text-[26px] font-extrabold leading-tight text-strong">{guide.title}</h1>
      <p className="mt-2 text-[14px] leading-relaxed text-soft">{guide.summary}</p>
      <p className="mt-1 text-[11px] font-bold text-faint">Updated {guide.updated}</p>

      {guide.sections.map((s) => (
        <section key={s.heading} className="mt-6">
          <h2 className="text-[17px] font-extrabold text-strong">{s.heading}</h2>
          {s.body.map((p, i) => (
            <p key={i} className="mt-2 text-[14px] leading-relaxed text-soft">
              {p}
            </p>
          ))}
        </section>
      ))}

      <p className="mt-8 rounded-2xl bg-brandblue-soft px-4 py-3 text-[13px] font-bold leading-relaxed text-brandblue">
        WheelDeal&rsquo;s agents message rental shops near your hotel and haggle
        on your behalf, so you see the real local price instead of the tourist
        one.{" "}
        <Link href="/welcome" className="underline">
          See how it works
        </Link>
        .
      </p>
    </main>
  );
}
