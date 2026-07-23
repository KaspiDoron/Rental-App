"use client";

// Tap-to-build request CAROUSEL (R3): a sleek, progressive step-by-step flow -
// ONE decision per screen with Next / Back navigation and a progress rail. Zero
// typing required. Its output is a Partial<StructuredRFQ> that /api/profile
// turns into a real RFQ with NO LLM call. The free-text box stays available
// alongside - this is an alternative, not a replacement.

import { useMemo, useState } from "react";
import type { StructuredRFQ, VehicleClass, Transmission } from "@/lib/types";
import { useI18n } from "@/lib/i18n";
import { Icon } from "./icons";

const SCOOTER_CC = [110, 125, 150, 160] as const;
const MOTORBIKE_CC = [150, 200, 250, "300+"] as const;
const CAR_TYPES = ["economy", "sedan", "suv", "van", "luxury"] as const;

type Vehicle = "scooter" | "motorbike" | "car";

function OptionCard({
  active,
  onClick,
  emoji,
  title,
  sub,
}: {
  active: boolean;
  onClick: () => void;
  emoji?: string;
  title: string;
  sub?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`btn flex w-full items-center gap-3 rounded-2xl border-2 p-3 text-left transition ${
        active
          ? "border-brandblue bg-brandblue-soft shadow-md"
          : "border-line bg-card hover:border-brandblue/50"
      }`}
    >
      {emoji && <span className="text-2xl">{emoji}</span>}
      <span className="min-w-0 flex-1">
        <span className={`block text-[14px] font-extrabold ${active ? "text-brandblue" : "text-strong"}`}>
          {title}
        </span>
        {sub && <span className="block text-[11px] font-bold text-faint">{sub}</span>}
      </span>
      {active && <Icon name="check" className="h-5 w-5 shrink-0 text-brandblue" />}
    </button>
  );
}

function Pill({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`btn btn-sm rounded-2xl border-2 px-3.5 py-2 text-[13px] font-extrabold transition ${
        active ? "border-brandblue bg-brandblue text-white shadow" : "border-line bg-card text-soft hover:border-brandblue/50"
      }`}
    >
      {children}
    </button>
  );
}

function Stepper({ value, min, max, onChange, suffix }: { value: number; min: number; max: number; onChange: (n: number) => void; suffix?: string }) {
  return (
    <div className="inline-flex items-center gap-3 rounded-2xl border-2 border-line bg-card px-3 py-1.5">
      <button type="button" aria-label="decrease" onClick={() => onChange(Math.max(min, value - 1))} className="btn h-8 w-8 rounded-xl bg-card2 text-xl font-extrabold text-strong">−</button>
      <span className="min-w-[4rem] text-center text-[15px] font-extrabold text-strong">{value}{suffix ? ` ${suffix}` : ""}</span>
      <button type="button" aria-label="increase" onClick={() => onChange(Math.min(max, value + 1))} className="btn h-8 w-8 rounded-xl bg-card2 text-xl font-extrabold text-strong">+</button>
    </div>
  );
}

// BUG 4: the rental duration must be directly EDITABLE - not only nudged one day
// at a time. This control keeps the -/+ steppers but the number itself is a
// typeable input (clamped 1-90), so a 30-day rental is one keystroke.
function DurationField({ value, onChange, t }: { value: number; onChange: (n: number) => void; t: (s: string) => string }) {
  const clamp = (n: number) => Math.max(1, Math.min(90, n));
  return (
    <div className="inline-flex items-center gap-2 rounded-2xl border-2 border-line bg-card px-2 py-1.5">
      <button type="button" aria-label="decrease" onClick={() => onChange(clamp(value - 1))} className="btn h-8 w-8 rounded-xl bg-card2 text-xl font-extrabold text-strong">−</button>
      <input
        type="number"
        inputMode="numeric"
        min={1}
        max={90}
        value={value}
        aria-label={t("Rental days")}
        onChange={(e) => {
          const n = parseInt(e.target.value, 10);
          if (Number.isFinite(n)) onChange(clamp(n));
        }}
        className="w-12 bg-transparent text-center text-[15px] font-extrabold text-strong outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
      />
      <span className="text-[12px] font-bold text-faint">{t("days")}</span>
      <button type="button" aria-label="increase" onClick={() => onChange(clamp(value + 1))} className="btn h-8 w-8 rounded-xl bg-card2 text-xl font-extrabold text-strong">+</button>
    </div>
  );
}

export function RequestBuilder({ onLock, busy }: { onLock: (fields: Partial<StructuredRFQ>) => void; busy?: boolean }) {
  const { t } = useI18n();
  const [step, setStep] = useState(0);
  const [vehicle, setVehicle] = useState<Vehicle | null>(null);
  const [transmission, setTransmission] = useState<Transmission>("any");
  const [cc, setCc] = useState<number | null>(null);
  const [carType, setCarType] = useState<(typeof CAR_TYPES)[number] | null>(null);
  const [days, setDays] = useState(4);
  const [helmets, setHelmets] = useState(0);
  const [maxMileage, setMaxMileage] = useState<number | null>(null);
  const [storageBox, setStorageBox] = useState(false);
  const [delivery, setDelivery] = useState<"any" | "hotel-delivery" | "in-store">("any");
  const [custom, setCustom] = useState("");

  const isTwoWheel = vehicle === "scooter" || vehicle === "motorbike";

  // BUG 4: the gearbox is IMPLIED for two-wheelers (scooter = automatic,
  // motorbike = manual), so the transmission step is redundant for them and is
  // shown ONLY for cars, where auto vs manual is a real choice. The step list is
  // keyed by NAME (not a fixed index) so it can shrink/grow with the vehicle.
  type StepName = "vehicle" | "transmission" | "specs" | "extras" | "lock";
  const steps = useMemo<StepName[]>(() => {
    return vehicle === "car"
      ? ["vehicle", "transmission", "specs", "extras", "lock"]
      : ["vehicle", "specs", "extras", "lock"];
  }, [vehicle]);
  const total = steps.length;
  const current: StepName = steps[Math.min(step, total - 1)] ?? "vehicle";
  const canNext = current === "vehicle" ? vehicle !== null : true;

  function go(delta: number) {
    setStep((s) => Math.min(total - 1, Math.max(0, s + delta)));
  }

  function lock() {
    if (!vehicle || busy) return;
    const vehicleClass: VehicleClass = vehicle as VehicleClass;
    const fields: Partial<StructuredRFQ> = {
      vehicleClass,
      durationDays: days,
      transmission: isTwoWheel ? transmission : transmission,
      accessories: [],
      fulfillment: delivery,
    };
    if (isTwoWheel && cc) fields.engineSizeCc = cc;
    if (isTwoWheel && helmets > 0) fields.helmetCount = helmets;
    if (vehicle === "car" && carType) fields.carType = carType;
    if (maxMileage) fields.maxMileageKm = maxMileage;
    const notes = [storageBox ? "storage box / top box" : "", custom.trim()].filter(Boolean).join("; ");
    if (notes) fields.notes = notes.slice(0, 240);
    onLock(fields);
  }

  const ccOptions = vehicle === "motorbike" ? MOTORBIKE_CC : SCOOTER_CC;
  const TITLES: Record<StepName, string> = {
    vehicle: "Pick your ride",
    transmission: "Gears",
    specs: "Size & spec",
    extras: "Extras",
    lock: "Lock it in",
  };
  const stepTitle = TITLES[current];

  return (
    <div data-tour="builder" className="overflow-hidden rounded-2xl border-2 border-line bg-card2">
      {/* Progress rail */}
      <div className="flex items-center gap-1.5 px-3 pt-3">
        {steps.map((_, i) => (
          <span key={i} className={`h-1.5 flex-1 rounded-full transition-colors ${i <= step ? "bg-brandblue" : "bg-line"}`} />
        ))}
      </div>
      <div className="flex items-center justify-between px-3 pt-2">
        <span className="text-[11px] font-bold text-faint">{t("Step")} {step + 1} / {total}</span>
        <span className="text-[13px] font-extrabold text-strong">{t(stepTitle)}</span>
      </div>

      <div className="min-h-[200px] p-3">
        {/* STEP - vehicle. Picking a two-wheeler stamps its implied gearbox
            (scooter = automatic, motorbike = manual) so no gearbox step is
            needed; a car defaults to "any" and gets the gearbox step. */}
        {current === "vehicle" && (
          <div className="space-y-2">
            <OptionCard emoji="🛵" title={t("Scooter")} sub={t("Automatic, easy - the traveller favourite")} active={vehicle === "scooter"} onClick={() => { setVehicle("scooter"); setCc(null); setTransmission("automatic"); }} />
            <OptionCard emoji="🏍️" title={t("Motorbike")} sub={t("Manual gears, more power")} active={vehicle === "motorbike"} onClick={() => { setVehicle("motorbike"); setCc(null); setTransmission("manual"); }} />
            <OptionCard emoji="🚗" title={t("Car")} sub={t("4 seats and up, doors and A/C")} active={vehicle === "car"} onClick={() => { setVehicle("car"); setCc(null); setTransmission("any"); }} />
          </div>
        )}

        {/* STEP - transmission (cars only) */}
        {current === "transmission" && (
          <div className="space-y-2">
            <p className="mb-1 text-[12px] font-bold text-soft">{t("Which gearbox do you want?")}</p>
            <OptionCard title={t("Either is fine")} sub={t("Cheapest wins")} active={transmission === "any"} onClick={() => setTransmission("any")} />
            <OptionCard emoji="⚙️" title={t("Automatic")} sub={t("Twist and go")} active={transmission === "automatic"} onClick={() => setTransmission("automatic")} />
            <OptionCard emoji="🕹️" title={t("Manual")} sub={t("Clutch and gears")} active={transmission === "manual"} onClick={() => setTransmission("manual")} />
          </div>
        )}

        {/* STEP - specs */}
        {current === "specs" && (
          <div className="space-y-3">
            {isTwoWheel ? (
              <>
                <p className="text-[12px] font-bold text-soft">{t("Engine size")}</p>
                <div className="flex flex-wrap gap-2">
                  <Pill active={cc === null} onClick={() => setCc(null)}>{t("Any / cheapest")}</Pill>
                  {ccOptions.map((c) => (
                    <Pill key={String(c)} active={cc === (typeof c === "number" ? c : 300)} onClick={() => setCc(typeof c === "number" ? c : 300)}>
                      {typeof c === "number" ? `${c}cc` : "300cc+"}
                    </Pill>
                  ))}
                </div>
              </>
            ) : (
              <>
                <p className="text-[12px] font-bold text-soft">{t("Car type")}</p>
                <div className="flex flex-wrap gap-2">
                  {CAR_TYPES.map((c) => (
                    <Pill key={c} active={carType === c} onClick={() => setCarType(carType === c ? null : c)}>
                      {t(c[0].toUpperCase() + c.slice(1))}
                    </Pill>
                  ))}
                </div>
              </>
            )}
            <div className="flex items-center justify-between gap-2 rounded-xl bg-card p-2.5">
              <span className="text-[13px] font-extrabold text-strong">{t("For how many days?")}</span>
              <DurationField value={days} onChange={setDays} t={t} />
            </div>
          </div>
        )}

        {/* STEP - extras */}
        {current === "extras" && (
          <div className="space-y-3">
            {isTwoWheel && (
              <div className="flex items-center justify-between gap-2 rounded-xl bg-card p-2.5">
                <span className="text-[13px] font-bold text-soft">🪖 {t("Helmets")}</span>
                <Stepper value={helmets} min={0} max={4} onChange={setHelmets} />
              </div>
            )}
            <div className="rounded-xl bg-card p-2.5">
              <p className="mb-1.5 text-[12px] font-bold text-soft">{t("Max mileage per day")}</p>
              <div className="flex flex-wrap gap-2">
                {[null, 100, 150, 200].map((m) => (
                  <Pill key={String(m)} active={maxMileage === m} onClick={() => setMaxMileage(m)}>{m === null ? t("Any") : `${m} km`}</Pill>
                ))}
              </div>
            </div>
            <div className="rounded-xl bg-card p-2.5">
              <p className="mb-1.5 text-[12px] font-bold text-soft">{t("How do you get it?")}</p>
              <div className="flex flex-wrap gap-2">
                <Pill active={delivery === "any"} onClick={() => setDelivery("any")}>{t("Either")}</Pill>
                <Pill active={delivery === "hotel-delivery"} onClick={() => setDelivery("hotel-delivery")}>🛵 {t("Delivered to me")}</Pill>
                <Pill active={delivery === "in-store"} onClick={() => setDelivery("in-store")}>🏪 {t("Pick up at shop")}</Pill>
              </div>
            </div>
            {isTwoWheel && (
              <button type="button" onClick={() => setStorageBox((s) => !s)} className={`btn flex w-full items-center justify-between rounded-xl border-2 p-2.5 ${storageBox ? "border-brandblue bg-brandblue-soft" : "border-line bg-card"}`}>
                <span className="text-[13px] font-bold text-soft">🧳 {t("Storage / top box")}</span>
                <span className={`text-[12px] font-extrabold ${storageBox ? "text-brandblue" : "text-faint"}`}>{storageBox ? t("Yes") : t("Off")}</span>
              </button>
            )}
            <input
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              placeholder={t("Anything else? e.g. child seat, phone mount")}
              maxLength={240}
              className="w-full rounded-xl border-2 border-line bg-card px-3 py-2.5 text-[16px] text-strong placeholder:text-faint"
            />
          </div>
        )}

        {/* STEP - lock */}
        {current === "lock" && (
          <div className="space-y-3">
            <p className="text-[12px] font-bold text-soft">{t("Here's your request - lock it and I'll find the shops.")}</p>
            <div className="flex flex-wrap gap-1.5">
              {vehicle && <span className="rounded-full bg-brandblue-soft px-3 py-1 text-[12px] font-extrabold text-brandblue">{t(vehicle[0].toUpperCase() + vehicle.slice(1))}</span>}
              {isTwoWheel && transmission !== "any" && <span className="rounded-full bg-card px-3 py-1 text-[12px] font-bold text-soft">{t(transmission)}</span>}
              {isTwoWheel && cc && <span className="rounded-full bg-card px-3 py-1 text-[12px] font-bold text-soft">{cc}cc</span>}
              {vehicle === "car" && carType && <span className="rounded-full bg-card px-3 py-1 text-[12px] font-bold text-soft">{t(carType)}</span>}
              <span className="rounded-full bg-card px-3 py-1 text-[12px] font-bold text-soft">{days} {t("days")}</span>
              {helmets > 0 && <span className="rounded-full bg-card px-3 py-1 text-[12px] font-bold text-soft">{helmets} 🪖</span>}
              {maxMileage && <span className="rounded-full bg-card px-3 py-1 text-[12px] font-bold text-soft">&lt;{maxMileage}km</span>}
              {delivery !== "any" && <span className="rounded-full bg-card px-3 py-1 text-[12px] font-bold text-soft">{delivery === "hotel-delivery" ? t("Delivered") : t("Pickup")}</span>}
            </div>
            <button type="button" onClick={lock} disabled={busy} className="btn w-full rounded-2xl bg-brandblue py-3 text-[15px] font-extrabold text-white shadow-md hover:opacity-90 disabled:opacity-50">
              🔒 {t("Lock request & find deals")}
            </button>
          </div>
        )}
      </div>

      {/* Nav */}
      <div className="flex items-center justify-between gap-2 border-t border-line/50 p-3">
        <button type="button" onClick={() => go(-1)} disabled={step === 0} className="btn btn-sm rounded-xl px-4 py-2 text-[13px] font-extrabold text-soft disabled:opacity-30">
          ← {t("Back")}
        </button>
        {step < total - 1 ? (
          <button type="button" onClick={() => go(1)} disabled={!canNext} className="btn btn-sm rounded-xl bg-brandblue px-5 py-2 text-[13px] font-extrabold text-white disabled:opacity-40">
            {t("Next")} →
          </button>
        ) : (
          <span className="text-[11px] font-bold text-faint">{t("Tap lock above")}</span>
        )}
      </div>
    </div>
  );
}
