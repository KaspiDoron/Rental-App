"use client";

import "leaflet/dist/leaflet.css";
import {
  MapContainer,
  TileLayer,
  CircleMarker,
  Circle,
  Tooltip,
  useMap,
} from "react-leaflet";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { Vendor } from "@/lib/types";
import { Icon } from "./icons";

// Map view. Cartography matches classic Google Maps defaults (light gray
// roads, white-gray blocks, green parks) via CARTO Voyager tiles. Includes a
// fullscreen expand/collapse control and stays under the navigation bars.

function stageColor(v: Vendor): string {
  switch (v.stage) {
    case "offer-received":
      return "#16a34a";
    case "negotiating":
      return "#ef4444";
    case "awaiting-response":
      return "#ffb703";
    case "rfq-sent":
      return "#2f6fed";
    case "no-response":
    case "declined":
      return "#9aa3b2";
    default:
      return "#2f6fed";
  }
}

function Recenter({
  origin,
  radiusKm,
}: {
  origin: { lat: number; lng: number };
  radiusKm: number;
}) {
  const map = useMap();
  useEffect(() => {
    const dLat = radiusKm / 111;
    map.fitBounds([
      [origin.lat - dLat, origin.lng - dLat],
      [origin.lat + dLat, origin.lng + dLat],
    ]);
    // Leaflet needs a poke when its container is resized (fullscreen toggle).
    setTimeout(() => map.invalidateSize(), 250);
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
  const [full, setFull] = useState(false);

  const map = (
    <MapContainer
      center={[origin.lat, origin.lng]}
      zoom={13}
      scrollWheelZoom
      className="h-full w-full"
      zoomControl={false}
    >
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/attributions">CARTO</a>'
        url="https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png"
      />
      <Recenter origin={origin} radiusKm={radiusKm} />

      <Circle
        center={[origin.lat, origin.lng]}
        radius={radiusKm * 1000}
        pathOptions={{ color: "#2f6fed", fillColor: "#2f6fed", fillOpacity: 0.05, weight: 1.5 }}
      />
      <CircleMarker
        center={[origin.lat, origin.lng]}
        radius={8}
        pathOptions={{ color: "#ffffff", fillColor: "#ef4444", fillOpacity: 1, weight: 3 }}
      >
        <Tooltip permanent direction="top" offset={[0, -10]}>
          <span className="text-[11px] font-bold">Your stay</span>
        </Tooltip>
      </CircleMarker>

      {vendors.map((v) => {
        const color = stageColor(v);
        const selected = v.id === selectedId;
        return (
          <CircleMarker
            key={v.id}
            center={[v.lat, v.lng]}
            radius={selected ? 13 : 9}
            pathOptions={{
              color: "#ffffff",
              fillColor: color,
              fillOpacity: 1,
              weight: selected ? 3.5 : 2,
            }}
            eventHandlers={{ click: () => onSelect(v.id) }}
          >
            <Tooltip direction="top" offset={[0, -10]}>
              <div className="text-[11px]">
                <div className="font-bold">{v.name}</div>
                <div>
                  {v.offer
                    ? `$${v.offer.pricePerDay}/day`
                    : `${v.distanceKm?.toFixed(1)} km · ★${v.rating || "-"}`}
                </div>
              </div>
            </Tooltip>
          </CircleMarker>
        );
      })}
    </MapContainer>
  );

  if (full) {
    // Portal to <body> so the fullscreen map escapes the page's stacking
    // context and sits above the top bar, tab bar and upgrade chip.
    return createPortal(
      <div className="fixed inset-0 z-[1100] bg-base">
        {map}
        <button
          onClick={() => setFull(false)}
          className="btn absolute right-4 z-[1150] rounded-2xl bg-card px-4 py-2.5 text-sm font-extrabold text-strong shadow-lg"
          style={{ top: "calc(env(safe-area-inset-top, 0px) + 12px)" }}
        >
          <span className="flex items-center gap-1.5">
            <Icon name="chevron" className="h-4 w-4 rotate-90" /> Exit fullscreen
          </span>
        </button>
      </div>,
      document.body
    );
  }

  return (
    <div className="relative z-0 h-full w-full">
      {map}
      <button
        onClick={() => setFull(true)}
        aria-label="Expand map"
        className="btn absolute right-3 top-3 z-[500] rounded-xl bg-card px-3 py-2 text-[12px] font-extrabold text-strong shadow-lg"
      >
        ⛶ Expand
      </button>
    </div>
  );
}
