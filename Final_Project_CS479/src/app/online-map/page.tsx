"use client";

import { useRef, useEffect, useState, useCallback } from "react";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";

// --- Types ---
interface TrailPoint {
  lat: number;
  lng: number;
  elevation: number;
}

interface Sensor {
  lat: number;
  lng: number;
  accuracy: number;
  heading: number;
  temp: number;
  pressure: number;
  altitude: number;
  ppm: number;
  accelX: number;
  accelY: number;
  accelZ: number;
  gyroX: number;
  gyroY: number;
  gyroZ: number;
}

const DEFAULT_SENSOR: Sensor = {
  lat: 0, lng: 0, accuracy: 0, heading: 0,
  temp: 0, pressure: 0, altitude: 0, ppm: 0,
  accelX: 0, accelY: 0, accelZ: 0, gyroX: 0, gyroY: 0, gyroZ: 0,
};


mapboxgl.accessToken = process.env.NEXT_PUBLIC_MAPBOX_SECRET_KEY;

export default function OnlineMap() {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const userMarkerRef = useRef<mapboxgl.Marker | null>(null);
  const compassRef = useRef<HTMLCanvasElement>(null);

  const [trail, setTrail] = useState<TrailPoint[]>([]);
  const [arduinoConnected, setArduinoConnected] = useState(false);
  const [sensor, setSensor] = useState<Sensor>(DEFAULT_SENSOR);
  const [mapLoaded, setMapLoaded] = useState(false);
  const [isDemoMode, setIsDemoMode] = useState(false);
  const trailRef = useRef<TrailPoint[]>([]);
  

  // 1. Initialize Map
  useEffect(() => {
    if (!mapContainerRef.current) return;

    const map = new mapboxgl.Map({
      container: mapContainerRef.current,
      style: "mapbox://styles/mapbox/dark-v11",
      center: [0, 0], // Starts at Null Island
      zoom: 2,
      pitch: 45,
      attributionControl: false,
    });

    map.on("load", () => {
      // Add Trail Source
      map.addSource("trail-source", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });

      // Add Trail Layer
      map.addLayer({
        id: "trail-layer",
        type: "line",
        source: "trail-source",
        layout: { "line-join": "round", "line-cap": "round" },
        paint: {
          "line-color": "#f97316",
          "line-width": 4,
          "line-opacity": 0.8,
        },
      });

      mapRef.current = map;
      setMapLoaded(true);
    });

    return () => map.remove();
  }, []);

  // 2. Load Trail Data via API
  useEffect(() => {
    fetch("/api/trail")
      .then((r) => r.json())
      .then((data: TrailPoint[]) => setTrail(data))
      .catch((err) => console.error("Trail fetch error:", err));
  }, []);

  // 3. Update Trail GeoJSON on Map
  useEffect(() => {
    if (!mapRef.current || !mapLoaded || trail.length === 0) return;

    const coords = trail.map((p) => [p.lng, p.lat]);
    const source = mapRef.current.getSource("trail-source") as mapboxgl.GeoJSONSource;
    
    if (source) {
      source.setData({
        type: "Feature",
        properties: {},
        geometry: { type: "LineString", coordinates: coords as any },
      });

      // Fit map to show the whole trail
      const bounds = new mapboxgl.LngLatBounds();
      coords.forEach((c) => bounds.extend(c as [number, number]));
      mapRef.current.fitBounds(bounds, { padding: 50, duration: 1500 });
    }
  }, [trail, mapLoaded]);

  // 4. Update Marker & Camera based on Sensor Data
  useEffect(() => {
    if (!mapRef.current || !mapLoaded || sensor.lat === 0) return;

    // Initialize or Move Marker
    if (!userMarkerRef.current) {
      const el = document.createElement("div");
      el.className = "w-5 h-5 bg-blue-500 border-2 border-white rounded-full shadow-[0_0_15px_rgba(59,130,246,0.9)]";
      userMarkerRef.current = new mapboxgl.Marker(el)
        .setLngLat([sensor.lng, sensor.lat])
        .addTo(mapRef.current);
    } else {
      userMarkerRef.current.setLngLat([sensor.lng, sensor.lat]);
    }

    // Follow User
    mapRef.current.easeTo({
      center: [sensor.lng, sensor.lat],
      bearing: sensor.heading,
      duration: 800,
    });
  }, [sensor.lat, sensor.lng, sensor.heading, mapLoaded]);

  // 5. Arduino Serial Logic
  const connectArduino = useCallback(async () => {
    try {
      const nav = navigator as any;
      if (!nav.serial) {
        alert("Web Serial is only supported in Chrome or Edge.");
        return;
      }
      const port = await nav.serial.requestPort();
      await port.open({ baudRate: 115200 });
      setArduinoConnected(true);

      const decoder = new TextDecoderStream();
      port.readable?.pipeThrough(decoder);
      const reader = decoder.readable.getReader();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          parseArduinoLine(line.trim(), setSensor);
        }
      }
    } catch (err) {
      console.error("Serial connection failed:", err);
      setArduinoConnected(false);
    }
  }, []);
  
  const toggleDemo = useCallback(() => {
    setIsDemoMode((prev) => {
      if (!prev && trailRef.current.length > 0) {
        const first = trailRef.current[0];
        setSensor((s) => ({ ...s, lat: first.lat, lng: first.lng, altitude: first.elevation }));
      }
      return !prev;
    });
  }, []);
  // 6. Canvas Compass Render
  useEffect(() => {
    if (compassRef.current) {
      renderCompass(compassRef.current, sensor.heading);
    }
  }, [sensor.heading]);

  const aq = aqStatus(sensor.ppm);

  return (
    <div className="flex flex-col h-screen w-full bg-black text-white font-mono select-none overflow-hidden">
      {/* Header */}
      <header className="flex items-center justify-between px-4 py-2 border-b border-gray-800 shrink-0">
        <div className="flex items-center gap-3">
          <span className="text-sm font-bold tracking-widest">Online Trail Navigator</span>
          <span className="text-[10px] bg-orange-600 text-white px-2 py-0.5 rounded font-bold tracking-widest">
            ONLINE
          </span>
        </div>
        <div className="flex items-center gap-4">
          <span className="text-xs flex items-center gap-1.5 text-green-400">
            <span className="w-2 h-2 rounded-full bg-green-500 inline-block" />
            GPS
          </span>
          <span className="text-xs flex items-center gap-1.5 text-green-400">
            <span className={`w-2 h-2 rounded-full inline-block ${arduinoConnected ? "bg-green-500" : "bg-gray-600"}`} />
            Arduino
          </span>
          <button
            onClick={toggleDemo}
            className={`text-[11px] px-3 py-1 rounded border transition-colors cursor-pointer ${
              isDemoMode
                ? "border-white text-white bg-white/10"
                : "border-gray-600 text-gray-300 hover:border-gray-500"
            }`}
          >
            Demo Mode
          </button>
          {!arduinoConnected && (
            <button
              onClick={connectArduino}
              className="text-[11px] px-3 py-1 rounded border border-gray-600 text-gray-300 hover:border-gray-500 cursor-pointer transition-colors"
            >
              Connect Arduino
            </button>
          )}
        </div>
      </header>

      {/* Body */}
      <div className="flex flex-1 overflow-hidden relative">
        {/* Map Container */}
        <main className="flex-1 relative bg-zinc-900">
          <div 
            ref={mapContainerRef} 
            className="absolute inset-0 w-full h-full" 
          />
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex flex-col items-center gap-1 pointer-events-none">
            <span className="text-[10px] text-gray-400 tracking-widest font-mono">ALTITUDE</span>
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-white font-mono">Low</span>
              <div
                className="w-40 h-3 rounded"
                style={{ background: "linear-gradient(to right, rgb(0,255,0), rgb(255,255,0), rgb(255,165,0), rgb(255,0,0))" }}
              />
              <span className="text-[10px] text-white font-mono">High</span>
            </div>
          </div>
          {/* Top-Left HUD */}
          <div className="absolute top-4 left-4 p-3 bg-black/70 border border-gray-800 backdrop-blur-md rounded-sm z-10 pointer-events-none min-w-[140px]">
            <p className="text-[9px] text-gray-500 mb-1 tracking-tighter">GPS_COORDINATES</p>
            <p className="text-xs text-blue-400 tabular-nums">LAT: {sensor.lat.toFixed(6)}</p>
            <p className="text-xs text-blue-400 tabular-nums">LNG: {sensor.lng.toFixed(6)}</p>
          </div>
        </main>

        {/* Sidebar */}
        <aside className="w-52 shrink-0 border-l border-gray-800 overflow-y-auto bg-black">
          <SidePanel label="GPS POSITION">
            <SideRow label="Lat" value={sensor.lat.toFixed(6)} />
            <SideRow label="Lng" value={sensor.lng.toFixed(6)} />
            <SideRow label="Accuracy" value={`±${sensor.accuracy} m`} />
          </SidePanel>

          <SidePanel label="COMPASS - LSM303">
            <div className="flex justify-center py-1">
              <canvas ref={compassRef} width={76} height={76} />
            </div>
            <SideRow label="Heading" value={`${sensor.heading.toFixed(1)}°`} />
            <SideRow label="Dir" value={headingToDir(sensor.heading)} />
          </SidePanel>

          <SidePanel label="ENVIRONMENT - BMP280">
            <SideRow label="Temp" value={`${sensor.temp.toFixed(1)} °C`} />
            <SideRow label="Pressure" value={`${sensor.pressure} hPa`} />
            <SideRow label="Altitude" value={`${sensor.altitude.toFixed(1)} m`} />
          </SidePanel>

          <SidePanel label="AIR QUALITY - MQ135">
            <SideRow label="CO₂" value={aq.label} valueColor={aq.color} />
            <SideRow label="PPM" value={`${sensor.ppm} ppm`} />
          </SidePanel>

          <SidePanel label="ACCEL - MPU6050">
            <BarRow label="X" value={sensor.accelX} range={32768} />
            <BarRow label="Y" value={sensor.accelY} range={32768} />
            <BarRow label="Z" value={sensor.accelZ} range={32768} />
          </SidePanel>

          <SidePanel label="GYRO - MPU6050">
            <BarRow label="X" value={sensor.gyroX} range={250} />
            <BarRow label="Y" value={sensor.gyroY} range={250} />
            <BarRow label="Z" value={sensor.gyroZ} range={250} />
          </SidePanel>
        </aside>
      </div>
    </div>
  );
}

// --- UTILITY FUNCTIONS ---

function headingToDir(h: number): string {
  const d = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];
  return d[Math.round(h / 22.5) % 16];
}

function aqStatus(ppm: number) {
  if (ppm < 450) return { label: "EXCELLENT", color: "#22c55e" };
  if (ppm < 1000) return { label: "MODERATE", color: "#eab308" };
  return { label: "POOR", color: "#ef4444" };
}

function renderCompass(canvas: HTMLCanvasElement, heading: number) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const { width: w, height: h } = canvas;
  const cx = w / 2, cy = h / 2, r = (w / 2) - 5;

  ctx.clearRect(0, 0, w, h);
  
  // Outer Ring
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.strokeStyle = "#333"; ctx.lineWidth = 2; ctx.stroke();

  // Cardinal labels
  const ha = (heading - 90) * (Math.PI / 180);
  ctx.font = "bold 12px monospace";
  ctx.fillStyle = "#ef4444";
  ctx.textAlign = "center";
  
  // Rotating needle
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(heading * Math.PI / 180);
  
  ctx.beginPath();
  ctx.moveTo(0, -r + 10); ctx.lineTo(6, 0); ctx.lineTo(-6, 0);
  ctx.fillStyle = "#ef4444"; ctx.fill();
  
  ctx.beginPath();
  ctx.moveTo(0, r - 10); ctx.lineTo(6, 0); ctx.lineTo(-6, 0);
  ctx.fillStyle = "#fff"; ctx.fill();
  ctx.restore();
}

function parseArduinoLine(line: string, setSensor: React.Dispatch<React.SetStateAction<Sensor>>) {
  const pairs = line.split(",");
  const update: any = {};
  for (const pair of pairs) {
    const [key, val] = pair.split(":");
    if (!key || val === undefined) continue;
    const cleanKey = key.trim().toUpperCase();
    const v = parseFloat(val);

    switch(cleanKey) {
      case "LAT": update.lat = v; break;
      case "LNG": update.lng = v; break;
      case "ACC": update.accuracy = v; break;
      case "HDG": update.heading = v; break;
      case "TEMP": update.temp = v; break;
      case "ALT": update.altitude = v; break;
      case "PPM": update.ppm = v; break;
      case "AX": update.accelX = v; break;
      case "AY": update.accelY = v; break;
      case "AZ": update.accelZ = v; break;
    }
  }
  setSensor((prev) => ({ ...prev, ...update }));
}

// --- UI COMPONENTS ---

function SidePanel({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-gray-800 px-3 py-2">
      <p className="text-[10px] text-gray-400 tracking-widest mb-2">{label}</p>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

function SideRow({
  label,
  value,
  valueColor,
}: {
  label: string;
  value: string;
  valueColor?: string;
}) {
  return (
    <div className="flex justify-between items-center">
      <span className="text-[11px] text-gray-400">{label}</span>
      <span className="text-[11px]" style={{ color: valueColor ?? "#ffffff" }}>
        {value}
      </span>
    </div>
  );
}

function BarRow({ label, value, range }: { label: string; value: number; range: number }) {
  const pct = Math.min(Math.abs(value) / range, 1) * 100;
  return (
    <div className="flex items-center gap-2">
      <span className="text-[11px] text-gray-400 w-3 shrink-0">{label}</span>
      <div className="flex-1 h-[3px] bg-gray-800 rounded-full">
        <div className="h-[3px] bg-white rounded-full" style={{ width: `${pct}%` }} />
      </div>
      <span className="text-[11px] text-white w-8 text-right shrink-0">{value}</span>
    </div>
  );
}
