import { BrandPulseVeil } from "@/components/BrandPulse";
import { AmbientRaiser } from "@/components/AmbientRaiser";

// INSTANT ROUTE FALLBACK. With client-side tab navigation the App Router
// paints this the moment the hop starts, so the first frame of every
// navigation is the brand heartbeat instead of a frozen old page. Same
// component NavVeil renders - one loading vocabulary.
export default function Loading() {
  return (
    <>
      {/* The wash behind the heartbeat - the client leaf a server component
          cannot raise itself. */}
      <AmbientRaiser />
      <BrandPulseVeil />
    </>
  );
}
