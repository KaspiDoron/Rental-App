"use client";

// The blur-lock veil over the Find-Deals search card while WhatsApp is not
// linked. The whole product runs on the traveller's own number, so a search
// they cannot send is a dead end - this makes the gate obvious, calm and
// premium instead of letting them fill in a form that goes nowhere.
//
// Two states, never both:
//   checking - the status call is still in flight. Neutral, no pairing pitch,
//              so we never flash "not connected" at someone who IS connected.
//   locked   - confirmed unlinked. Full pitch + one-tap route to pairing.
//
// The card underneath stays MOUNTED (blurred + inert) rather than unmounted, so
// the onboarding tour anchors and layout stay stable.

import { Icon } from "./icons";
import { OrbitDots } from "./OrbitDots";
import { startNav } from "./NavVeil";
import { useI18n } from "@/lib/i18n";

export function WaLockVeil({ checking = false }: { checking?: boolean }) {
  const { t } = useI18n();

  if (checking) {
    return (
      <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 rounded-blob bg-card/80 p-5 text-center backdrop-blur-xl">
        <OrbitDots size={34} className="text-brandblue" label={t("Checking WhatsApp")} />
        <div className="text-[13px] font-extrabold text-soft">
          {t("Checking your WhatsApp link…")}
        </div>
      </div>
    );
  }

  return (
    <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-4 overflow-hidden rounded-blob bg-gradient-to-b from-card/85 via-card/92 to-card/97 p-6 text-center backdrop-blur-xl">
      {/* Soft brand glow behind the mark - pure CSS, no image payload. */}
      <div
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-1/3 h-56 w-56 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#25D366]/20 blur-3xl"
      />

      {/* The mark: WhatsApp green, breathing halo, lifted off the surface. */}
      <span className="relative flex h-[72px] w-[72px] shrink-0 items-center justify-center">
        <span className="soft-pulse absolute inset-0 rounded-[26px] bg-[#25D366]/30 blur-md" />
        <span className="relative flex h-[72px] w-[72px] items-center justify-center rounded-[26px] bg-gradient-to-br from-[#3ee27a] to-[#128C7E] text-white shadow-2xl ring-1 ring-white/20">
          <Icon name="whatsapp" className="h-9 w-9" />
        </span>
      </span>

      <div className="relative">
        <div className="text-[17px] font-extrabold leading-tight text-strong">
          {t("Link WhatsApp to unlock the search")}
        </div>
        <p className="mx-auto mt-1.5 max-w-[17rem] text-[12px] font-bold leading-relaxed text-soft">
          {t("Your agents bargain from your own number, so shops talk to a real traveller - and every reply lands back here.")}
        </p>
      </div>

      <a
        href="/profile"
        data-will="wa-link"
        onClick={() => startNav()}
        className="btn cta-sheen relative rounded-2xl bg-gradient-to-r from-[#25D366] to-[#128C7E] px-6 py-3 text-[14px] font-extrabold text-white shadow-lg hover:opacity-95"
      >
        💬 {t("Link my WhatsApp")}
      </a>

      {/* Quiet reassurance - the three objections people actually have. */}
      <div className="relative flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-[10px] font-bold text-faint">
        <span className="flex items-center gap-1">
          <Icon name="lock" className="h-3 w-3" /> {t("Private")}
        </span>
        <span>·</span>
        <span>{t("About 30 seconds")}</span>
        <span>·</span>
        <span>{t("Disconnect any time")}</span>
      </div>
    </div>
  );
}
