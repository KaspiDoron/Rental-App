import { BrandPulseVeil } from "@/components/BrandPulse";
import { AmbientRaiser } from "@/components/AmbientRaiser";

// Instant fallback for the Profile hop - see src/app/loading.tsx.
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
