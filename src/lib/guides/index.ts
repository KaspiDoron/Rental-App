// THE CRAWLABLE SITE WAS FOUR URLS, TWO OF THEM LEGAL BOILERPLATE (W-4);
// wave 4.4 grew it to twenty. The AdSense rejection was "Low value content",
// and the only content worth writing is content that would exist even if
// AdSense did not: the questions this app's own users ask before they rent
// anything. Every number in these articles is a range the agents actually
// negotiate against and the risk screen actually flags, so the pages stay
// true as the product learns rather than rotting into marketing copy.
//
// One file per article, one array assembled here - the hub, the detail
// route, the sitemap and the JSON-LD all derive from this array, so a guide
// cannot exist without being listed, or be listed without existing.

import type { Guide } from "./types";

import scooterRentalPricesSoutheastAsia from "./scooter-rental-prices-southeast-asia";
import thailandScooterRentalPrices from "./thailand-scooter-rental-prices";
import vietnamMotorbikeRentalPrices from "./vietnam-motorbike-rental-prices";
import baliScooterRentalPrices from "./bali-scooter-rental-prices";
import philippinesScooterRentalPrices from "./philippines-scooter-rental-prices";

import rentalDepositPassport from "./rental-deposit-passport";
import scooterRentalCashDeposit from "./scooter-rental-cash-deposit";
import rentalContractChecklist from "./rental-contract-checklist";

import internationalDrivingPermitScooter from "./international-driving-permit-scooter";
import travelInsuranceScooterAccidents from "./travel-insurance-scooter-accidents";
import motorcycleLicenceCategoriesExplained from "./motorcycle-licence-categories-explained";
import carVsScooterRentalAbroad from "./car-vs-scooter-rental-abroad";

import rentalScamWarningSigns from "./rental-scam-warning-signs";
import scooterHandoverChecklist from "./scooter-handover-checklist";
import helmetQualityAbroad from "./helmet-quality-abroad";
import firstWeekRidingSafety from "./first-week-riding-safety";
import rainySeasonScooterRiding from "./rainy-season-scooter-riding";

import howToNegotiateScooterRental from "./how-to-negotiate-scooter-rental";
import messagingRentalShopsWhatsapp from "./messaging-rental-shops-whatsapp";
import monthlyScooterRentalDiscounts from "./monthly-scooter-rental-discounts";

export type { Guide, GuideBlock, GuideSection, GuideFaq, GuideCategory } from "./types";
export { GUIDE_CATEGORY_LABELS, guideText } from "./types";

export const GUIDES: Guide[] = [
  // What things really cost
  scooterRentalPricesSoutheastAsia,
  thailandScooterRentalPrices,
  vietnamMotorbikeRentalPrices,
  baliScooterRentalPrices,
  philippinesScooterRentalPrices,
  // Deposits & paperwork
  rentalDepositPassport,
  scooterRentalCashDeposit,
  rentalContractChecklist,
  // Licences & insurance
  internationalDrivingPermitScooter,
  travelInsuranceScooterAccidents,
  motorcycleLicenceCategoriesExplained,
  carVsScooterRentalAbroad,
  // Risk & safety
  rentalScamWarningSigns,
  scooterHandoverChecklist,
  helmetQualityAbroad,
  firstWeekRidingSafety,
  rainySeasonScooterRiding,
  // Negotiation & logistics
  howToNegotiateScooterRental,
  messagingRentalShopsWhatsapp,
  monthlyScooterRentalDiscounts,
];

export function guideBySlug(slug: string): Guide | undefined {
  return GUIDES.find((g) => g.slug === slug);
}
