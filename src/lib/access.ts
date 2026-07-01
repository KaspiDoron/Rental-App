// Access-control store for the admin "User Entry Panel".
//
// Process-level singleton in demo mode; a Supabase `app_users` table in prod.

interface UserRecord {
  email: string;
  status: "active" | "blocked";
  addedAt: number;
  lastSeen: number;
}

declare global {
  // eslint-disable-next-line no-var
  var __wheeldeal_users__: Map<string, UserRecord> | undefined;
}

function store() {
  if (!globalThis.__wheeldeal_users__) {
    globalThis.__wheeldeal_users__ = new Map();
  }
  return globalThis.__wheeldeal_users__;
}

export function touchUser(email: string) {
  const s = store();
  const key = email.toLowerCase();
  const existing = s.get(key);
  if (existing) {
    existing.lastSeen = Date.now();
  } else {
    s.set(key, {
      email: key,
      status: "active",
      addedAt: Date.now(),
      lastSeen: Date.now(),
    });
  }
}

export function isBlocked(email: string): boolean {
  return store().get(email.toLowerCase())?.status === "blocked";
}

export function listUsers(): UserRecord[] {
  return [...store().values()].sort((a, b) => b.lastSeen - a.lastSeen);
}

export function setUserStatus(email: string, status: "active" | "blocked") {
  const s = store();
  const key = email.toLowerCase();
  const rec = s.get(key);
  if (rec) rec.status = status;
  else
    s.set(key, {
      email: key,
      status,
      addedAt: Date.now(),
      lastSeen: Date.now(),
    });
}
