"use client";

import "leaflet/dist/leaflet.css";
import { MapContainer, TileLayer, CircleMarker, Circle, Tooltip, useMap } from "react-leaflet";
import { useEffect } from "react";
import type { Vendor } from "@/lib/types";

function stageColor(v: Vendor): string {
  switch (v.stage) {
    case "offer-received":
      return "#34d399";
    case "negotiating":
      return "#a78bfa";
    case "awaiting-response":
      return "#fbbf24";
    case "rfq-sent":
      return "#818cf8";
    case "no-response":
    case "declined":
      return "#64748b";
    default:
      return "#38bdf8";
  }
}

function Recenter({ origin, radiusKm }: { origin: { lat: number; lng: number }; radiusKm: number }) {
  const map = useMap();
  useEffect(() => {
    map.setView([origin.lat, origin.lng]);
    // Fit to roughly the search radius.
    const dLat = radiusKm / 111;
    map.fitBounds([
      [origin.lat - dLat, origin.lng - dLat],
      [origin.lat + dLat, origin.lng + dLat],
    ]);
  }, [origin.lat, origin.lng, radiusKm, map]);
  return null;
}

export default function MapView({
  origin,
  radiusKm,
  vendors,
  selectedId,
  onSelect,
}: {
  origin: { lat: number; lng: number };
  radiusKm: number;
  vendors: Vendor[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <MapContainer
      center={[origin.lat, origin.lng]}
      zoom={13}
      scrollWheelZoom
      className="h-full w-full"
      zoomControl={false}
    >
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
        url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      <Recenter origin={origin} radiusKm={radiusKm} />

      <Circle
        center={[origin.lat, origin.lng]}
        radius={radiusKm * 1000}
        pathOptions={{ color: "#10b981", fillColor: "#10b981", fillOpacity: 0.05, weight: 1 }}
      />
      <CircleMarker
        center={[origin.lat, origin.lng]}
        radius={7}
        pathOptions={{ color: "#f5c451", fillColor: "#f5c451", fillOpacity: 1, weight: 2 }}
      >
        <Tooltip permanent direction="top" offset={[0, -8]}>
          <span className="text-[11px] font-semibold">Your stay</span>
        </Tooltip>
      </CircleMarker>

      {vendors.map((v) => {
        const color = stageColor(v);
        const selected = v.id === selectedId;
        return (
          <CircleMarker
            key={v.id}
            center={[v.lat, v.lng]}
            radius={selected ? 12 : 8}
            pathOptions={{
              color,
              fillColor: color,
              fillOpacity: selected ? 0.95 : 0.7,
              weight: selected ? 3 : 1.5,
            }}
            eventHandlers={{ click: () => onSelect(v.id) }}
          >
            <Tooltip direction="top" offset={[0, -8]}>
              <div className="text-[11px]">
                <div className="font-semibold">{v.name}</div>
                <div>
                  {v.offer ? `$${v.offer.pricePerDay}/day` : `${v.distanceKm?.toFixed(1)} km`}
                </div>
              </div>
            </Tooltip>
          </CircleMarker>
        );
      })}
    </MapContainer>
  );
}
