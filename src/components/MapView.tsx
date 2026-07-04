"use client";

import "leaflet/dist/leaflet.css";
import L from "leaflet";
import {
  MapContainer,
  TileLayer,
  Marker,
  Circle,
  useMap,
} from "react-leaflet";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { Vendor } from "@/lib/types";
import { Icon } from "./icons";

// Google-Maps-style map: Voyager cartography (gray roads, white-gray blocks,
// green parks), price-bubble pins like Booking/Airbnb, zoom + locate controls,
// and a fullscreen mode with a browsable shop list at the bottom.

function pinColor(v: Vendor): string {
  switch (v.stage) {
    case "offer-received":
      return "#16a34a";
    case "negotiating":
      return "#ef4444";
    case "awaiting-response":
      return "#e79b00";
    case "no-response":
    case "declined":
      return "#9aa3b2";
    default:
      return "#2f6fed";
  }
}

function priceIcon(v: Vendor, selected: boolean): L.DivIcon {
  const color = pinColor(v);
  const label = v.offer
    ? `$${v.offer.pricePerDay}`
    : v.rating
    ? `★${v.rating.toFixed(1)}`
    : "?";
  const scale = selected ? 1.15 : 1;
  return L.divIcon({
    className: "",
    html: `
      <div style="transform:scale(${scale});transform-origin:bottom center;display:flex;flex-direction:column;align-items:center;filter:drop-shadow(0 2px 4px rgba(0,0,0,0.3))">
        <div style="background:${color};color:#fff;font:800 12px/1 Nunito,system-ui;padding:6px 9px;border-radius:999px;border:2px solid #fff;white-space:nowrap">${label}</div>
        <div style="width:0;height:0;border-left:6px solid transparent;border-right:6px solid transparent;border-top:8px solid ${color};margin-top:-1px"></div>
      </div>`,
    iconSize: [0, 0],
    iconAnchor: [0, 34],
  });
}

const stayIcon = L.divIcon({
  className: "",
  html: `
    <div style="display:flex;flex-direction:column;align-items:center;filter:drop-shadow(0 2px 4px rgba(0,0,0,0.35))">
      <div style="background:#ef4444;border:3px solid #fff;border-radius:999px;width:22px;height:22px;display:flex;align-items:center;justify-content:center;font-size:11px">🏨</div>
      <div style="width:0;height:0;border-left:5px solid transparent;border-right:5px solid transparent;border-top:7px solid #ef4444;margin-top:-1px"></div>
    </div>`,
  iconSize: [0, 0],
  iconAnchor: [0, 30],
});

function Controls({ origin }: { origin: { lat: number; lng: number } }) {
  const map = useMap();
  const btn =
    "flex h-10 w-10 items-center justify-center rounded-xl bg-card text-strong shadow-lg text-lg font-extrabold btn btn-sm";
  return (
    <div className="absolute bottom-6 right-3 z-[500] flex flex-col gap-2">
      <button className={btn} onClick={() => map.zoomIn()} aria-label="Zoom in">+</button>
      <button className={btn} onClick={() => map.zoomOut()} aria-label="Zoom out">−</button>
      <button
        className={btn}
        aria-label="My location"
        onClick={() => {
          navigator.geolocation?.getCurrentPosition(
            (pos) => map.setView([pos.coords.latitude, pos.coords.longitude], 15),
            () => map.setView([origin.lat, origin.lng], 14)
          );
        }}
      >
        ◎
      </button>
    </div>
  );
}

function Recenter({
  origin,
  radiusKm,
  focus,
}: {
  origin: { lat: number; lng: number };
  radiusKm: number;
  focus: { lat: number; lng: number } | null;
}) {
  const map = useMap();
  useEffect(() => {
    const dLat = radiusKm / 111;
    map.fitBounds([
      [origin.lat - dLat, origin.lng - dLat],
      [origin.lat + dLat, origin.lng + dLat],
    ]);
    setTimeout(() => map.invalidateSize(), 250);
  }, [origin.lat, origin.lng, radiusKm, map]);
  useEffect(() => {
    if (focus) map.setView([focus.lat, focus.lng], Math.max(map.getZoom(), 15), { animate: true });
  }, [focus, map]);
  return null;
}

export default function MapView({
  origin,
  radiusKm,
  vendors,
  selectedId,
  onSelect,
  onOpenVendor,
}: {
  origin: { lat: number; lng: number };
  radiusKm: number;
  vendors: Vendor[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onOpenVendor?: (v: Vendor) => void;
}) {
  const [full, setFull] = useState(false);
  const selected = vendors.find((v) => v.id === selectedId) ?? null;

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
      <Recenter origin={origin} radiusKm={radiusKm} focus={selected} />
      <Controls origin={origin} />

      <Circle
        center={[origin.lat, origin.lng]}
        radius={radiusKm * 1000}
        pathOptions={{ color: "#2f6fed", fillColor: "#2f6fed", fillOpacity: 0.04, weight: 1.5 }}
      />
      <Marker position={[origin.lat, origin.lng]} icon={stayIcon} />

      {vendors.map((v) => (
        <Marker
          key={v.id}
          position={[v.lat, v.lng]}
          icon={priceIcon(v, v.id === selectedId)}
          eventHandlers={{ click: () => onSelect(v.id) }}
        />
      ))}
    </MapContainer>
  );

  if (full) {
    return createPortal(
      <div className="fixed inset-0 z-[1100] bg-base">
        <div className="absolute inset-0">{map}</div>

        <button
          onClick={() => setFull(false)}
          className="btn absolute right-4 z-[1150] rounded-2xl bg-card px-4 py-2.5 text-sm font-extrabold text-strong shadow-lg"
          style={{ top: "calc(env(safe-area-inset-top, 0px) + 12px)" }}
        >
          ✕ Close map
        </button>

        {/* Booking-style browsable shop list */}
        <div className="absolute inset-x-0 bottom-0 z-[1140] pb-safe">
          <div className="no-scrollbar flex gap-3 overflow-x-auto px-4 pb-3">
            {vendors.map((v) => (
              <button
                key={v.id}
                onClick={() => onSelect(v.id)}
                className={`surface-strong w-72 shrink-0 overflow-hidden rounded-blob text-left transition ${
                  v.id === selectedId ? "border-2 !border-brandblue" : ""
                }`}
              >
                {v.photoUrl && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={v.photoUrl} alt="" className="h-20 w-full object-cover" />
                )}
                <div className="p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-[14px] font-extrabold text-strong">{v.name}</span>
                    <span className="shrink-0 text-[15px] font-extrabold text-strong">
                      {v.offer ? `$${v.offer.pricePerDay}/d` : "..."}
                    </span>
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-soft">
                    <span className="inline-flex items-center gap-0.5">
                      <Icon name="star" className="h-3 w-3 text-brandyellow" />
                      {v.rating ? v.rating.toFixed(1) : "New"} ({v.reviews} reviews)
                    </span>
                    <span>{v.distanceKm?.toFixed(1)} km</span>
                    {v.openNow !== undefined && (
                      <span className={v.openNow ? "font-bold text-savings" : "font-bold text-brandred"}>
                        {v.openNow ? "Open now" : "Closed"}
                      </span>
                    )}
                  </div>
                  {v.todayHours && (
                    <div className="mt-0.5 truncate text-[10px] font-bold text-faint">
                      🕒 {v.todayHours}
                    </div>
                  )}
                  {v.address && (
                    <div className="truncate text-[10px] text-faint">{v.address}</div>
                  )}
                  <div className="mt-1">
                    {(v.orders ?? 0) > 0 ? (
                      <span className="rounded-md bg-savings-soft px-1.5 py-0.5 text-[9px] font-extrabold text-savings">
                        ✓ {v.orders} booked here
                      </span>
                    ) : (
                      <span className="rounded-md bg-brandblue-soft px-1.5 py-0.5 text-[9px] font-extrabold text-brandblue">
                        ✨ New on WheelDeal
                      </span>
                    )}
                  </div>
                  {onOpenVendor && (
                    <span
                      onClick={(e) => {
                        e.stopPropagation();
                        setFull(false);
                        onOpenVendor(v);
                      }}
                      className="btn btn-sm mt-2 block w-full rounded-xl bg-brandblue py-1.5 text-center text-[12px] font-extrabold text-white"
                    >
                      View details
                    </span>
                  )}
                </div>
              </button>
            ))}
          </div>
        </div>
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
