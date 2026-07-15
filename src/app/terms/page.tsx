import Link from "next/link";
import { LegalDoc } from "@/components/LegalDoc";
import { TERMS_SECTIONS, TERMS_VERSION } from "@/lib/legal";

export const metadata = {
  title: "Terms of Use - WheelDeal",
  robots: { index: true, follow: true },
};

export default function TermsPage() {
  return (
    <main className="mx-auto max-w-2xl px-4 py-6 pb-safe">
      <Link href="/" className="text-[13px] font-bold text-brandblue">
        ← Back
      </Link>
      <div className="mt-4">
        <LegalDoc title="Terms of Use" version={TERMS_VERSION} sections={TERMS_SECTIONS} />
      </div>
      <div className="mt-4 text-[12px] text-faint">
        See also our{" "}
        <Link href="/privacy" className="font-bold text-brandblue underline">
          Privacy Policy
        </Link>
        .
      </div>
    </main>
  );
}
