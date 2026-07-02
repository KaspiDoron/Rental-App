"use client";

import { useMemo, useState } from "react";

// Phone input with a searchable country-code picker (flag + name + dial code).
const COUNTRIES: { flag: string; name: string; dial: string }[] = [
  { flag: "🇮🇱", name: "Israel", dial: "+972" },
  { flag: "🇺🇸", name: "United States", dial: "+1" },
  { flag: "🇬🇧", name: "United Kingdom", dial: "+44" },
  { flag: "🇮🇩", name: "Indonesia", dial: "+62" },
  { flag: "🇹🇭", name: "Thailand", dial: "+66" },
  { flag: "🇻🇳", name: "Vietnam", dial: "+84" },
  { flag: "🇵🇭", name: "Philippines", dial: "+63" },
  { flag: "🇮🇳", name: "India", dial: "+91" },
  { flag: "🇩🇪", name: "Germany", dial: "+49" },
  { flag: "🇫🇷", name: "France", dial: "+33" },
  { flag: "🇪🇸", name: "Spain", dial: "+34" },
  { flag: "🇮🇹", name: "Italy", dial: "+39" },
  { flag: "🇵🇹", name: "Portugal", dial: "+351" },
  { flag: "🇬🇷", name: "Greece", dial: "+30" },
  { flag: "🇹🇷", name: "Turkey", dial: "+90" },
  { flag: "🇦🇪", name: "UAE", dial: "+971" },
  { flag: "🇲🇽", name: "Mexico", dial: "+52" },
  { flag: "🇧🇷", name: "Brazil", dial: "+55" },
  { flag: "🇦🇷", name: "Argentina", dial: "+54" },
  { flag: "🇨🇴", name: "Colombia", dial: "+57" },
  { flag: "🇦🇺", name: "Australia", dial: "+61" },
  { flag: "🇳🇿", name: "New Zealand", dial: "+64" },
  { flag: "🇯🇵", name: "Japan", dial: "+81" },
  { flag: "🇰🇷", name: "South Korea", dial: "+82" },
  { flag: "🇨🇳", name: "China", dial: "+86" },
  { flag: "🇸🇬", name: "Singapore", dial: "+65" },
  { flag: "🇲🇾", name: "Malaysia", dial: "+60" },
  { flag: "🇳🇱", name: "Netherlands", dial: "+31" },
  { flag: "🇨🇭", name: "Switzerland", dial: "+41" },
  { flag: "🇨🇦", name: "Canada", dial: "+1" },
  { flag: "🇿🇦", name: "South Africa", dial: "+27" },
  { flag: "🇪🇬", name: "Egypt", dial: "+20" },
  { flag: "🇲🇦", name: "Morocco", dial: "+212" },
  { flag: "🇵🇱", name: "Poland", dial: "+48" },
  { flag: "🇷🇴", name: "Romania", dial: "+40" },
];

export function CountryPhoneInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (full: string) => void;
}) {
  const [country, setCountry] = useState(COUNTRIES[0]);
  const [local, setLocal] = useState("");
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return COUNTRIES;
    return COUNTRIES.filter(
      (c) => c.name.toLowerCase().includes(needle) || c.dial.includes(needle)
    );
  }, [q]);

  function emit(c: typeof country, l: string) {
    onChange(l ? `${c.dial} ${l}` : "");
  }

  return (
    <div className="relative">
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="btn btn-sm chip flex shrink-0 items-center gap-1.5 rounded-2xl border-2 border-line bg-card px-3 text-[15px] font-bold text-strong"
        >
          <span className="text-lg leading-none">{country.flag}</span>
          {country.dial}
          <span className="text-[10px] text-faint">▾</span>
        </button>
        <input
          type="tel"
          inputMode="tel"
          value={local}
          onChange={(e) => {
            const l = e.target.value.replace(/[^\d\s-]/g, "");
            setLocal(l);
            emit(country, l);
          }}
          placeholder="812 345 678"
          className="w-full rounded-2xl border-2 border-line bg-card p-3 text-sm text-strong placeholder:text-faint focus:border-brandblue focus:outline-none"
        />
      </div>

      {open && (
        <div className="surface-strong absolute inset-x-0 top-full z-50 mt-2 max-h-64 overflow-y-auto rounded-2xl p-2">
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search country or code..."
            className="mb-1 w-full rounded-xl border-2 border-line bg-card p-2.5 text-sm text-strong placeholder:text-faint focus:border-brandblue focus:outline-none"
          />
          {filtered.map((c) => (
            <button
              key={c.name}
              type="button"
              onClick={() => {
                setCountry(c);
                emit(c, local);
                setOpen(false);
                setQ("");
              }}
              className="btn btn-sm flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left hover:bg-card2"
            >
              <span className="text-lg">{c.flag}</span>
              <span className="flex-1 text-[13px] font-bold text-strong">{c.name}</span>
              <span className="text-[13px] font-bold text-faint">{c.dial}</span>
            </button>
          ))}
          {filtered.length === 0 && (
            <div className="p-2 text-center text-[12px] text-faint">No match</div>
          )}
        </div>
      )}
      {/* keep the parent form informed even before typing */}
      <input type="hidden" value={value} readOnly />
    </div>
  );
}
