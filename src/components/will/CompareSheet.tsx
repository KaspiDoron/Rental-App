"use client";

// Side-by-side comparison of 2-3 offers - opened by Will ("compare the top
// 3") or anywhere else the app wants it. Facts only, no invention: every row
// comes straight from the vendors' real offers.

import { Modal } from "../Modal";
import { Icon } from "../icons";
import type { Vendor } from "@/lib/types";
import { moneyLocal } from "@/lib/currency";
import { depositSummary } from "@/lib/deposit";
import { isPresentableOffer } from "@/lib/offer-presentation";
import { useI18n } from "@/lib/i18n";

export function CompareSheet({
  vendors,
  durationDays,
  onLock,
  onClose,
}: {
  vendors: Vendor[];
  durationDays: number;
  onLock: (vendor: Vendor) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  // Never compare a price the shop quoted for a DIFFERENT vehicle - it would
  // rank an off-spec quote (e.g. an e-bike) against the real matches.
  const cols = vendors.filter((v) => isPresentableOffer(v.offer)).slice(0, 3);
  const cheapest = cols.reduce<Vendor | null>(
    (best, v) => (!best || v.offer!.pricePerDay < best.offer!.pricePerDay ? v : best),
    null
  );

  const rows: { label: string; render: (v: Vendor) => React.ReactNode }[] = [
    {
      label: t("Per day"),
      render: (v) => (
        <span className={`text-[14px] font-extrabold ${v.id === cheapest?.id ? "text-savings" : "text-strong"}`}>
          {moneyLocal(v.offer!.pricePerDay, v.offer!.currency)}
        </span>
      ),
    },
    {
      label: `${t("Total")} (${durationDays} ${t("days")})`,
      render: (v) => (
        <span className="text-[12px] font-bold text-strong">
          {moneyLocal(v.offer!.pricePerDay * durationDays, v.offer!.currency)}
        </span>
      ),
    },
    {
      label: t("Confirmed"),
      render: (v) =>
        v.offer!.verified ? (
          <Icon name="check" className="mx-auto h-4 w-4 text-savings" />
        ) : (
          <span className="text-[11px] font-bold text-faint">{t("not yet")}</span>
        ),
    },
    {
      label: t("Deposit"),
      render: (v) => {
        const o = v.offer!;
        // EVERY alternative, never only the enum's first pick. "passport or
        // money4000" rendered here as the bare word "passport" while the cash
        // amount sat two lines above in depositAmount - the same field failure
        // as the status-panel chip, fixed with the same shared summary.
        const text = depositSummary(
          {
            deposit: o.deposit,
            depositType: o.depositType,
            depositAmount: o.depositAmount,
            depositCurrency: o.depositCurrency,
            currency: o.currency,
          },
          moneyLocal
        );
        return <span className="text-[11px] font-bold text-soft">{text ?? "?"}</span>;
      },
    },
    {
      label: t("Getting it"),
      render: (v) => {
        const o = v.offer!;
        return (
          <span className="text-[11px] font-bold text-soft">
            {o.fulfillment === "delivery"
              ? `${t("delivered")}${o.deliveryFee ? ` (+${moneyLocal(o.deliveryFee, o.currency)})` : ""}`
              : o.fulfillment === "pickup"
              ? t("they pick you up")
              : o.fulfillment === "on-shop"
              ? t("at the shop")
              : "?"}
          </span>
        );
      },
    },
    {
      label: t("Rating"),
      render: (v) => (
        <span className="text-[11px] font-bold text-soft">
          {v.rating ? `★ ${v.rating.toFixed(1)}` : "-"}
        </span>
      ),
    },
  ];

  return (
    <Modal onClose={onClose}>
      <div className="mb-2 flex items-center justify-between">
        <div>
          <h2 className="text-[16px] font-extrabold text-strong">{t("Side by side")}</h2>
          <p className="text-[11px] text-faint">{t("Real offers only - nothing here is estimated")}</p>
        </div>
        <button onClick={onClose} className="btn btn-sm btn-ghost rounded-xl px-3" aria-label={t("Close")}>
          ✕
        </button>
      </div>

      {cols.length < 2 ? (
        <p className="rounded-2xl bg-card2 p-3 text-[12px] text-soft">
          {t("Not enough priced offers to compare yet - lock in at least two prices first.")}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[300px]">
            <thead>
              <tr>
                <th className="w-[86px]" />
                {cols.map((v) => (
                  <th key={v.id} className="px-1.5 pb-2 text-center">
                    <div className="truncate text-[12px] font-extrabold text-strong">{v.name}</div>
                    {v.id === cheapest?.id && (
                      <span className="mt-0.5 inline-block rounded-full bg-savings-soft px-2 py-0.5 text-[9px] font-extrabold text-savings">
                        {t("BEST PRICE")}
                      </span>
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.label} className="border-t border-line">
                  <td className="py-2 pr-1 text-[10px] font-extrabold uppercase tracking-wide text-faint">
                    {r.label}
                  </td>
                  {cols.map((v) => (
                    <td key={v.id} className="px-1.5 py-2 text-center">
                      {r.render(v)}
                    </td>
                  ))}
                </tr>
              ))}
              <tr className="border-t border-line">
                <td />
                {cols.map((v) => (
                  <td key={v.id} className="px-1.5 pt-2.5 text-center">
                    <button
                      onClick={() => onLock(v)}
                      className={`btn w-full rounded-2xl py-2 text-[12px] font-extrabold ${
                        v.id === cheapest?.id ? "btn-primary" : "btn-ghost"
                      }`}
                    >
                      {t("Lock it")}
                    </button>
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}
