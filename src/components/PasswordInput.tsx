"use client";

import { useState } from "react";

// Password field with a show/hide eye - used for EVERY password input in the
// app (login, signup, profile, key vault).
export function PasswordInput({
  value,
  onChange,
  placeholder,
  required,
  minLength,
  autoComplete,
  className = "",
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  required?: boolean;
  minLength?: number;
  autoComplete?: string;
  className?: string;
}) {
  const [show, setShow] = useState(false);
  return (
    <div
      className={`flex items-center gap-1 rounded-2xl border-2 border-line bg-card pr-1 focus-within:border-brandblue ${className}`}
    >
      <input
        type={show ? "text" : "password"}
        value={value}
        required={required}
        minLength={minLength}
        autoComplete={autoComplete}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full bg-transparent p-3 text-sm text-strong placeholder:text-faint focus:outline-none"
      />
      <button
        type="button"
        onClick={() => setShow((s) => !s)}
        aria-label={show ? "Hide password" : "Show password"}
        className="btn btn-sm shrink-0 rounded-xl px-2 text-base text-faint hover:text-strong"
      >
        {show ? "🙈" : "👁"}
      </button>
    </div>
  );
}
