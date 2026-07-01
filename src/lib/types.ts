// Shared domain types for WheelDeal.

export type VehicleClass = "car" | "motorbike" | "scooter";
export type Transmission = "automatic" | "manual" | "any";
export type Fulfillment = "hotel-delivery" | "in-store" | "any";

export interface StructuredRFQ {
  vehicleClass: VehicleClass;
  engineSizeCc?: number;
  transmission: Transmission;
  maxMileageKm?: number;
  durationDays: number;
  accessories: string[];
  fulfillment: Fulfillment;
  notes?: string;
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
  // The vendor's opening/list rate before the agent negotiated — savings basis.
  listPricePerDay: number;
  currency: string;
  totalPrice: number;
  includesInsurance: boolean;
  includesDelivery: boolean;
  message: string;
  round: number;
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
  whatsapp: string; // E.164, opted-in partner vendor
  basePricePerDay: number; // internal seed used by the negotiation simulator
  partner: boolean;
  distanceKm?: number;
  // live state (client-side)
  stage?: TrackerStage;
  offer?: Offer;
  sentiment?: number; // 0..1 from the Sentiment agent
}

export interface NegotiationTactic {
  id: string;
  label: string;
  script: string;
  // Learning stats — updated by the Continuous Learning Engine.
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

export interface Session {
  email: string;
  isAdmin: boolean;
  issuedAt: number;
}
