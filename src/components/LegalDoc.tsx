import type { LegalSection } from "@/lib/legal";

// Shared renderer for the Terms of Use / Privacy Policy - used by the /terms
// and /privacy pages AND the signup modal, from one source (lib/legal.ts), so
// the on-page and in-modal text can never drift.
export function LegalDoc({
  title,
  version,
  sections,
  intro,
}: {
  title: string;
  version?: string;
  sections: LegalSection[];
  intro?: string;
}) {
  return (
    <div className="space-y-3 text-[13px] leading-relaxed text-soft">
      <div>
        <h2 className="text-lg font-extrabold text-strong">{title}</h2>
        {version && <p className="text-[11px] text-faint">Version {version}</p>}
      </div>
      {intro && <p>{intro}</p>}
      {sections.map((s) => (
        <p key={s.n}>
          <b className="text-strong">
            {s.n}. {s.title}.
          </b>{" "}
          {s.body}
        </p>
      ))}
    </div>
  );
}
