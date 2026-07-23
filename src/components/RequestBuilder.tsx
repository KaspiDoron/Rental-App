"use client";

// Tap-to-build request panel (F2 / journey Step 2): a premium, zero-typing way
// to assemble an exact rental request. Every step is optional beyond vehicle +
// duration; "Lock this request" is always one tap away. Its output is a
// Partial<StructuredRFQ> that /api/profile turns into a real RFQ with NO LLM
// call. The free-text box stays available alongside - this is an alternative,
// not a replacement.

import { useState } from "react";
import type { StructuredRFQ, VehicleClass, Transmission } from "@/lib/types";
import { useI18n } from "@/lib/i18n";
import { Icon } from "./icons";

const SCOOTER_CC = [110, 125, 150, 155, 160] as const;
const MOTORBIKE_CC = [150, 200, 250, 300, 400] as const;
const CAR_TYPES = ["economy", "sedan", "suv", "van", "luxury"] as const;

type Vehicle = "scooter" | "motorbike" | "car";

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`btn btn-sm rounded-2xl border-2 px-3 py-1.5 text-[13px] font-extrabold transition ${
        active
          ? "border-brandblue bg-brandblue text-white shadow-md"
          : "border-line bg-card text-soft hover:border-brandblue/60"
      }`}
    >
      {children}
    </button>
  );
}

function Stepper({
  value,
  min,
  max,
  onChange,
  suffix,
}: {
  value: number;
  min: number;
  max: number;
  onChange: (n: number) => void;
  suffix?: string;
}) {
  return (
    <div className="inline-flex items-center gap-2 rounded-2xl border-2 border-line bg-card px-2 py-1">
      <button
        type="button"
        aria-label="decrease"
        onClick={() => onChange(Math.max(min, value - 1))}
        className="btn h-7 w-7 rounded-xl bg-card2 text-lg font-extrabold text-strong"
      >
        −
      </button>
      <span className="min-w-[3.5rem] text-center text-[14px] font-extrabold text-strong">
        {value}
        {suffix ? ` ${suffix}` : ""}
      </span>
      <button
        type="button"
        aria-label="increase"
        onClick={() => onChange(Math.min(max, value + 1))}
        className="btn h-7 w-7 rounded-xl bg-card2 text-lg font-extrabold text-strong"
      >
        +
      </button>
    </div>
  );
}

export function RequestBuilder({
  onLock,
  busy,
}: {
  onLock: (fields: Partial<StructuredRFQ>) => void;
  busy?: boolean;
}) {
  const { t } = useI18n();
  const [vehicle, setVehicle] = useState<Vehicle | null>(null);
  const [transmission, setTransmission] = useState<Transmission>("any");
  const [cc, setCc] = useState<number | null>(null);
  const [carType, setCarType] = useState<(typeof CAR_TYPES)[number] | null>(null);
  const [days, setDays] = useState(4);
  const [showExtras, setShowExtras] = useState(false);
  const [helmets, setHelmets] = useState(0);
  const [maxMileage, setMaxMileage] = useState<number | null>(null);
  const [custom, setCustom] = useState("");

  const isTwoWheel = vehicle === "scooter" || vehicle === "motorbike";
  // Enough to lock: a vehicle chosen (duration always has a default).
  const canLock = vehicle !== null;

  function lock() {
    if (!canLock || busy) return;
    const vehicleClass: VehicleClass = vehicle as VehicleClass;
    const fields: Partial<StructuredRFQ> = {
      vehicleClass,
      durationDays: days,
      transmission: isTwoWheel ? transmission : "any",
      accessories: [],
    };
    if (isTwoWheel && cc) fields.engineSizeCc = cc;
    if (isTwoWheel && helmets > 0) fields.helmetCount = helmets;
    if (vehicle === "car" && carType) fields.carType = carType;
    if (maxMileage) fields.maxMileageKm = maxMileage;
    if (custom.trim()) fields.notes = custom.trim().slice(0, 240);
    onLock(fields);
  }

  const ccOptions = vehicle === "motorbike" ? MOTORBIKE_CC : SCOOTER_CC;

  return (
    <div data-tour="builder" className="rounded-2xl bg-card2 p-3">
      <div className="mb-2 flex items-center gap-1.5 text-[12px] font-extrabold text-soft">
        <Icon name="sparkles" className="h-4 w-4 text-brandblue" />
        {t("Build it in taps - no typing")}
      </div>

      {/* 1. Vehicle type */}
      <div className="mb-2.5 flex flex-wrap gap-1.5">
        <Chip active={vehicle === "scooter"} onClick={() => { setVehicle("scooter"); setCc(null); }}>
          🛵 {t("Scooter")}
        </Chip>
        <Chip active={vehicle === "motorbike"} onClick={() => { setVehicle("motorbike"); setCc(null); }}>
          🏍️ {t("Motorbike")}
        </Chip>
        <Chip active={vehicle === "car"} onClick={() => { setVehicle("car"); setCc(null); }}>
          🚗 {t("Car")}
        </Chip>
      </div>

      {/* 2. Transmission (two-wheel) */}
      {isTwoWheel && (
        <div className="mb-2.5">
          <div className="mb-1 text-[11px] font-bold text-faint">{t("Gears")}</div>
          <div className="flex flex-wrap gap-1.5">
            <Chip active={transmission === "any"} onClick={() => setTransmission("any")}>
              {t("Either")}
            </Chip>
            <Chip active={transmission === "automatic"} onClick={() => setTransmission("automatic")}>
              {t("Automatic")}
            </Chip>
            <Chip active={transmission === "manual"} onClick={() => setTransmission("manual")}>
              {t("Manual")}
            </Chip>
          </div>
        </div>
      )}

      {/* 3. Engine size (two-wheel) or car type */}
      {isTwoWheel && (
        <div className="mb-2.5">
          <div className="mb-1 text-[11px] font-bold text-faint">{t("Engine size")}</div>
          <div className="flex flex-wrap gap-1.5">
            {ccOptions.map((c) => (
              <Chip key={c} active={cc === c} onClick={() => setCc(cc === c ? null : c)}>
                {c}cc
              </Chip>
            ))}
          </div>
        </div>
      )}
      {vehicle === "car" && (
        <div className="mb-2.5">
          <div className="mb-1 text-[11px] font-bold text-faint">{t("Car type")}</div>
          <div className="flex flex-wrap gap-1.5">
            {CAR_TYPES.map((c) => (
              <Chip key={c} active={carType === c} onClick={() => setCarType(carType === c ? null : c)}>
                {t(c[0].toUpperCase() + c.slice(1))}
              </Chip>
            ))}
          </div>
        </div>
      )}

      {/* 4. Duration - only revealed once a vehicle is chosen */}
      {vehicle && (
        <div className="mb-2.5 flex items-center justify-between gap-2">
          <span className="text-[12px] font-extrabold text-strong">{t("For how many days?")}</span>
          <Stepper value={days} min={1} max={90} onChange={setDays} suffix={t("days")} />
        </div>
      )}

      {/* 5. Extras (progressive) + lock */}
      {vehicle && (
        <>
          <button
            type="button"
            onClick={() => setShowExtras((s) => !s)}
            className="mb-2 text-[11px] font-bold text-brandblue underline"
          >
            {showExtras ? t("Hide extras") : t("+ Add extras (helmets, mileage, a note)")}
          </button>
          {showExtras && (
            <div className="mb-2.5 space-y-2 rounded-xl bg-card p-2.5">
              {isTwoWheel && (
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[12px] font-bold text-soft">🪖 {t("Helmets")}</span>
                  <Stepper value={helmets} min={0} max={4} onChange={setHelmets} />
                </div>
              )}
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[12px] font-bold text-soft">{t("Max mileage/day")}</span>
                {[null, 100, 150, 200].map((m) => (
                  <Chip key={String(m)} active={maxMileage === m} onClick={() => setMaxMileage(m)}>
                    {m === null ? t("Any") : `${m} km`}
                  </Chip>
                ))}
              </div>
              <input
                value={custom}
                onChange={(e) => setCustom(e.target.value)}
                placeholder={t("Anything else? e.g. child seat, top box")}
                maxLength={240}
                className="w-full rounded-xl border-2 border-line bg-card2 px-3 py-2 text-[16px] text-strong placeholder:text-faint"
              />
            </div>
          )}
          <button
            type="button"
            onClick={lock}
            disabled={!canLock || busy}
            className="btn w-full rounded-2xl bg-brandblue py-3 text-[14px] font-extrabold text-white shadow-md hover:opacity-90 disabled:opacity-50"
          >
            🔒 {t("Lock this request")}
          </button>
        </>
      )}
    </div>
  );
}
