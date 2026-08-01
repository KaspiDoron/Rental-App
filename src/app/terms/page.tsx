import Link from "next/link";
import { LegalDoc } from "@/components/LegalDoc";
import { TERMS_SECTIONS, TERMS_VERSION, withOperator } from "@/lib/legal";

export const metadata = {
  title: "Terms of Use - WheelDeal",
  robots: { index: true, follow: true },
};

export default async function TermsPage() {
  // The legal entity from the Key Vault - the owner registers a company and the
  // Terms name it, with no redeploy. Falls back to the reviewed placeholder.
  const { getConfig } = await import("@/lib/runtime-config");
  const operator = await getConfig("OPERATOR_NAME").catch(() => "");
  return (
    <main className="mx-auto max-w-2xl px-4 py-6 pb-safe">
      <Link href="/" className="text-[13px] font-bold text-brandblue">
        ← Back
      </Link>
      <div className="mt-4">
        <LegalDoc title="Terms of Use" version={TERMS_VERSION} sections={withOperator(TERMS_SECTIONS, operator)} />
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
