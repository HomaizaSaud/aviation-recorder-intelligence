import React, { useEffect, useMemo, useState } from "react";
import { MapContainer, TileLayer, Marker, Tooltip } from "react-leaflet";
import { DivIcon } from "leaflet";

// Helper to render a round number badge as a marker icon
function numberBadge(count) {
  return new DivIcon({
    className: "", // prevent default leaflet marker styles
    html: `
      <div style="
        display:flex;align-items:center;justify-content:center;
        width:34px;height:34px;border-radius:9999px;
        background:#019348;color:white;font-weight:700;font-size:14px;
        box-shadow:0 4px 10px rgba(0,0,0,0.15);
        border:2px solid rgba(255,255,255,0.9);
      ">
        ${count}
      </div>
    `,
    iconSize: [34, 34],
    iconAnchor: [17, 17], // center the badge
  });
}

const DEFAULT_CENTER = [24.5, 54.4];

const geocodeLocation = async (location) => {
  const response = await fetch(
    `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(location)}&limit=1`,
    {
      headers: {
        "Accept-Language": "en",
      },
    }
  );

  if (!response.ok) {
    return null;
  }

  const results = await response.json();
  const first = Array.isArray(results) ? results[0] : null;

  if (!first) {
    return null;
  }

  return {
    lat: Number(first.lat),
    lon: Number(first.lon),
    label: first.display_name || location,
  };
};

export default function MapCases({ cases = [], isLoading = false }) {
  const locationCounts = useMemo(() => {
    const counts = new Map();

    cases.forEach((caseItem) => {
      const location = String(caseItem.location || "").trim();
      if (!location) {
        return;
      }

      counts.set(location, (counts.get(location) || 0) + 1);
    });

    return counts;
  }, [cases]);

  const locations = useMemo(() => Array.from(locationCounts.keys()), [locationCounts]);
  const [resolvedLocations, setResolvedLocations] = useState([]);
  const [isGeocoding, setIsGeocoding] = useState(false);

  useEffect(() => {
    let isActive = true;

    const fetchLocations = async () => {
      if (locations.length === 0) {
        setResolvedLocations([]);
        return;
      }

      setIsGeocoding(true);

      const results = await Promise.all(
        locations.map(async (location) => {
          try {
            const geo = await geocodeLocation(location);
            if (!geo) {
              return null;
            }

            return {
              location,
              ...geo,
              count: locationCounts.get(location) || 0,
            };
          } catch (error) {
            return null;
          }
        })
      );

      if (!isActive) {
        return;
      }

      setResolvedLocations(results.filter(Boolean));
      setIsGeocoding(false);
    };

    fetchLocations();

    return () => {
      isActive = false;
    };
  }, [locations, locationCounts]);

  const mapCenter = useMemo(() => {
    if (resolvedLocations.length === 0) {
      return DEFAULT_CENTER;
    }

    const totals = resolvedLocations.reduce(
      (acc, item) => {
        return {
          lat: acc.lat + item.lat,
          lon: acc.lon + item.lon,
        };
      },
      { lat: 0, lon: 0 }
    );

    return [totals.lat / resolvedLocations.length, totals.lon / resolvedLocations.length];
  }, [resolvedLocations]);

  const mapKey = `${mapCenter[0]}-${mapCenter[1]}-${resolvedLocations.length}`;

  return (
    <div className="bg-white rounded-xl shadow-md p-6">
      <h3 className="text-lg font-bold mb-4">Cases on Map</h3>

      <div className="rounded-lg overflow-hidden" style={{ height: 260 }}>
        <MapContainer
          key={mapKey}
          center={mapCenter}
          zoom={8}
          style={{ height: "100%", width: "100%" }}
          scrollWheelZoom={false}
        >
          <TileLayer
            attribution="&copy; OpenStreetMap contributors"
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />

          {resolvedLocations.map((loc) => (
            <Marker
              key={loc.location}
              position={[loc.lat, loc.lon]}
              icon={numberBadge(loc.count)}
            >
              <Tooltip direction="top" offset={[0, -10]} opacity={1}>
                <div className="text-sm font-semibold">{loc.label}</div>
                <div className="text-xs text-gray-600">{loc.count} case(s)</div>
              </Tooltip>
            </Marker>
          ))}
        </MapContainer>
      </div>

      {!isLoading && !isGeocoding && locations.length === 0 && (
        <p className="text-xs text-gray-500 mt-3">No case locations have been recorded yet.</p>
      )}
      {(isLoading || isGeocoding) && (
        <p className="text-xs text-gray-500 mt-3">Loading case locations…</p>
      )}
    </div>
  );
}
