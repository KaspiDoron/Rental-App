// Sponsored shops: owner-managed paid placements. Google results matching an
// active sponsorship (by phone digits or shop name) are tagged sponsored -
// the UI pins them first with a glowing frame and a "Recommended" tag.

import "server-only";
import { sbSelect, sbInsert, sbDelete, sbUpdate } from "./runtime-config";
import type { Vendor } from "./types";
import { digitsOnly } from "./phone";

export interface SponsoredRow {
  id: number;
  name: string;
  place_query: string | null;
  phone: string | null;
  active: boolean;
  notes: string | null;
  created_at?: string;
}

declare global {
  // eslint-disable-next-line no-var
  var __wd_sponsored__: { at: number; rows: SponsoredRow[] } | undefined;
}

async function activeSponsors(): Promise<SponsoredRow[]> {
  const cached = globalThis.__wd_sponsored__;
  if (cached && Date.now() - cached.at < 5 * 60_000) return cached.rows;
  const rows = await sbSelect<SponsoredRow>(
    "sponsored_shops",
    "select=id,name,place_query,phone,active,notes&active=eq.true&limit=200"
  );
  globalThis.__wd_sponsored__ = { at: Date.now(), rows };
  return rows;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Tag every vendor that matches an active sponsorship. Mutates in place. */
export async function tagSponsored(vendors: Vendor[]): Promise<void> {
  try {
    const sponsors = await activeSponsors();
    if (!sponsors.length) return;
    for (const v of vendors) {
      const phone = digitsOnly(v.whatsapp);
      const name = norm(v.name);
      const hit = sponsors.some((s) => {
        if (s.phone && phone && phone.endsWith(digitsOnly(s.phone).slice(-9)))
          return true;
        const sname = norm(s.name);
        return sname.length >= 4 && (name.includes(sname) || sname.includes(name));
      });
      if (hit) v.sponsored = true;
    }
  } catch {
    /* sponsorship is decorative - never break search */
  }
}

export async function listSponsors(): Promise<SponsoredRow[]> {
  return sbSelect<SponsoredRow>(
    "sponsored_shops",
    "select=id,name,place_query,phone,active,notes,created_at&order=created_at.desc&limit=200"
  );
}

export async function addSponsor(row: {
  name: string;
  place_query?: string;
  phone?: string;
  notes?: string;
}): Promise<void> {
  await sbInsert("sponsored_shops", [
    {
      name: row.name.trim(),
      place_query: row.place_query?.trim() || null,
      phone: digitsOnly(row.phone) || null,
      notes: row.notes?.trim() || null,
      active: true,
    },
  ]);
  globalThis.__wd_sponsored__ = undefined;
}

export async function setSponsorActive(id: number, active: boolean): Promise<void> {
  await sbUpdate("sponsored_shops", `id=eq.${id}`, { active });
  globalThis.__wd_sponsored__ = undefined;
}

export async function removeSponsor(id: number): Promise<void> {
  await sbDelete("sponsored_shops", `id=eq.${id}`);
  globalThis.__wd_sponsored__ = undefined;
}
