import Link from "next/link";
import { LegalDoc } from "@/components/LegalDoc";
import { PRIVACY_SECTIONS, TERMS_VERSION } from "@/lib/legal";

export const metadata = {
  title: "Privacy Policy - WheelDeal",
  robots: { index: true, follow: true },
};

export default function PrivacyPage() {
  return (
    <main className="mx-auto max-w-2xl px-4 py-6 pb-safe">
      <Link href="/" className="text-[13px] font-bold text-brandblue">
        ← Back
      </Link>
      <div className="mt-4">
        <LegalDoc title="Privacy Policy" version={TERMS_VERSION} sections={PRIVACY_SECTIONS} />
      </div>
      <div className="mt-4 text-[12px] text-faint">
        See also our{" "}
        <Link href="/terms" className="font-bold text-brandblue underline">
          Terms of Use
        </Link>
        .
      </div>
    </main>
  );
}
