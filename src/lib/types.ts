// Shared domain types for WheelDeal.

export type VehicleClass = "car" | "motorbike" | "scooter";
export type Transmission = "automatic" | "manual" | "any";
export type Fulfillment = "hotel-delivery" | "in-store" | "any";
export type Role = "owner" | "admin" | "user";

export interface StructuredRFQ {
  vehicleClass: VehicleClass;
  engineSizeCc?: number;
  transmission: Transmission;
  maxMileageKm?: number;
  // Car-specific: number of seats and the body type the traveller wants.
  seats?: number;
  carType?: "economy" | "sedan" | "suv" | "van" | "luxury" | "any";
  durationDays: number;
  accessories: string[];
  fulfillment: Fulfillment;
  notes?: string;
  // ---- Rental parameters (real-world funnel) --------------------------------
  // When the rental begins (YYYY-MM-DD). Availability quoted without a date is
  // worthless, so this is sent to shops when known.
  startDate?: string;
  // Return date; when absent it is derived from startDate + durationDays.
  returnDate?: string;
  // Driver details that gate eligibility at many shops.
  driverAge?: number;
  license?: { motorbike?: boolean; idp?: boolean };
  // Preferred insurance level (shops confirm what they actually offer).
  insuranceTier?: "none" | "basic" | "full" | "any";
  // One-way rentals: a different drop-off location (free text place).
  oneWayDropOff?: string;
  // Scooter/motorbike: how many helmets the traveller needs.
  helmetCount?: number;
  // A polished, vendor-ready message produced by the Profiler agent.
  vendorMessage: string;
}

export type TrackerStage =
  | "queued"
  | "locating-contact"
  | "rfq-sent"
  | "awaiting-response"
  | "negotiating"
  | "offer-received"
  | "no-response"
  | "declined";

export interface Offer {
  pricePerDay: number;
  // The vendor's opening/list rate before the agent negotiated - savings basis.
  listPricePerDay: number;
  currency: string;
  totalPrice: number;
  includesInsurance: boolean;
  includesDelivery: boolean;
  message: string;
  round: number;
  // True only after the agent has confirmed the exact vehicle + price with the
  // vendor. Simulated (demo) offers are marked so the UI can label them.
  verified: boolean;
  simulated: boolean;
  // Shop-confirmed conditions (shown as tags ONLY when explicitly stated).
  deposit?: string; // e.g. "Passport only", "3,000 THB cash"
  // ---- Extra shop-confirmed rental terms (only when explicitly stated) ------
  deliveryFee?: number; // in the offer's currency; 0 = free delivery
  kmLimitPerDay?: number | "unlimited";
  fuelPolicy?: string; // e.g. "full-to-full", "same-to-same"
  // Effective daily rate for the traveller's actual duration when the shop
  // quoted a better weekly/monthly rate (so long rentals do not collapse to a
  // single flat day price).
  effectiveDailyRate?: number;
}

export interface Vendor {
  id: string;
  name: string;
  lat: number;
  lng: number;
  rating: number;
  reviews: number;
  vehicleClasses: VehicleClass[];
  fulfillment: Fulfillment[];
  whatsapp: string; // E.164, opted-in partner vendor ("" when unknown yet)
  basePricePerDay: number; // internal seed used by the demo simulator only
  partner: boolean;
  demo: boolean; // true = seeded demo vendor, false = real Google Places result
  placeId?: string;
  address?: string;
  openNow?: boolean;
  photoUrl?: string;
  photoUrls?: string[]; // gallery (Google Places photos, proxied)
  todayHours?: string; // e.g. "Monday: 8:00 AM - 8:00 PM"
  orders?: number; // WheelDeal bookings made at this shop
  priceLevel?: number;
  distanceKm?: number;
  fastResponder?: boolean; // in the fastest-replying quartile (Ultra insight)
  // Reply-VERIFIED shop facts (item #13): each tag was explicitly stated by
  // the shop in >= 2 different replies before it is ever shown.
  verifiedTags?: string[];
  sponsored?: boolean; // paid placement: glowing card, pinned to the top
  // live state (client-side)
  stage?: TrackerStage;
  offer?: Offer;
  sentiment?: number; // 0..1 from the Sentiment agent
  // Status-panel detail (client-side): the EXACT text we sent, its faithful
  // English gloss, when the last state change happened, and - when the shop was
  // closed - the ISO time the queued message will auto-send.
  sentText?: string;
  sentGloss?: string;
  lastEventAt?: number;
  queuedUntil?: string;
}

export interface VendorReview {
  author: string;
  rating: number;
  text: string;
  timeAgo: string;
  timestamp: number;
}

export interface NegotiationTactic {
  id: string;
  label: string;
  script: string;
  // Learning stats - updated by the Continuous Learning Engine.
  uses: number;
  wins: number;
  avgDiscountPct: number;
}

export interface AnalyticsSnapshot {
  totalRuns: number;
  totalOffers: number;
  avgDiscountPct: number;
  avgCycleSeconds: number;
  bestTactic: string | null;
  tactics: NegotiationTactic[];
}

export type PlanId = "free" | "pro" | "ultra";

export interface Session {
  email: string;
  role: Role;
  // Owner and management are automatically Ultra, free of charge.
  plan: PlanId;
  issuedAt: number;
}
