"use client";

import { useRef, useEffect, useState, useCallback } from "react";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import { deadReckon, bearing } from "@/lib/deadReckon";

// --- Types ---
interface TrailPoint {
  lat: number;
  lng: number;
  elevation: number;
}

interface LivePoint {
  lat: number;
  lng: number;
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
  const [livePath, setLivePath] = useState<LivePoint[]>([]);
  const [isRecording, setIsRecording] = useState(false);
  const [isReturnMode, setIsReturnMode] = useState(false);
  const [gpsStatus, setGpsStatus] = useState<"pending" | "ok" | "error">("pending");
  const trailRef = useRef<TrailPoint[]>([]);
  const livePathRef = useRef<LivePoint[]>([]);
  const gpsOriginRef = useRef<LivePoint | null>(null);
  const isRecordingRef = useRef(false);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const portRef = useRef<any>(null);
  const demoIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const demoIndexRef = useRef(0);
  livePathRef.current = livePath;
  trailRef.current = trail;
  isRecordingRef.current = isRecording;
  

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

      // Live (Arduino dead-reckoned) path — drawn as two layers to give the line a glow.
      map.addSource("live-path-source", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      map.addLayer({
        id: "live-path-glow",
        type: "line",
        source: "live-path-source",
        layout: { "line-join": "round", "line-cap": "round" },
        paint: {
          "line-color": "#22d3ee",
          "line-width": 12,
          "line-opacity": 0.25,
          "line-blur": 4,
        },
      });
      map.addLayer({
        id: "live-path-layer",
        type: "line",
        source: "live-path-source",
        layout: { "line-join": "round", "line-cap": "round" },
        paint: {
          "line-color": "#22d3ee",
          "line-width": 5,
        },
      });

      // Return-route guide — the reversed outbound path shown as an orange dashed overlay.
      map.addSource("return-guide-source", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      map.addLayer({
        id: "return-guide-layer",
        type: "line",
        source: "return-guide-source",
        layout: { "line-join": "round", "line-cap": "round" },
        paint: {
          "line-color": "#f97316",
          "line-width": 3,
          "line-opacity": 0.75,
          "line-dasharray": [4, 3],
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

  // 4a. Bootstrap origin from device GPS once
  useEffect(() => {
    if (!mapLoaded) return;
    if (!navigator.geolocation) {
      setGpsStatus("error");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const origin: LivePoint = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        gpsOriginRef.current = origin;
        setGpsStatus("ok");
        setLivePath((p) => (p.length === 0 ? [origin] : p));
        setSensor((s) => ({
          ...s,
          lat: origin.lat,
          lng: origin.lng,
          accuracy: Math.round(pos.coords.accuracy ?? 0),
        }));
        mapRef.current?.flyTo({ center: [origin.lng, origin.lat], zoom: 17, duration: 1500 });
      },
      (err) => {
        console.warn("Geolocation failed:", err.message);
        setGpsStatus("error");
      },
      { enableHighAccuracy: false, timeout: 20000, maximumAge: 120000 }
    );
  }, [mapLoaded]);

  // 4b. Push live path to Mapbox + move marker / camera with the latest point
  useEffect(() => {
    if (!mapRef.current || !mapLoaded || livePath.length === 0) return;

    const coords = livePath.map((p) => [p.lng, p.lat]);
    const source = mapRef.current.getSource("live-path-source") as mapboxgl.GeoJSONSource | undefined;
    if (source) {
      source.setData({
        type: "Feature",
        properties: {},
        geometry: { type: "LineString", coordinates: coords },
      });
    }

    const last = livePath[livePath.length - 1];
    if (!userMarkerRef.current) {
      const el = document.createElement("div");
      el.className = "w-5 h-5 bg-blue-500 border-2 border-white rounded-full shadow-[0_0_15px_rgba(59,130,246,0.9)]";
      userMarkerRef.current = new mapboxgl.Marker(el)
        .setLngLat([last.lng, last.lat])
        .addTo(mapRef.current);
    } else {
      userMarkerRef.current.setLngLat([last.lng, last.lat]);
    }

    mapRef.current.easeTo({
      center: [last.lng, last.lat],
      bearing: sensor.heading,
      duration: 800,
    });
  }, [livePath, sensor.heading, mapLoaded]);

  // Hide the reference Glen trail whenever there's any recorded data (during or after recording),
  // so the user keeps the focus on their own path until they explicitly clear it.
  useEffect(() => {
    if (!mapRef.current || !mapLoaded) return;
    const map = mapRef.current;
    const hideGlen = isRecording || livePath.length > 1 || isReturnMode;
    if (map.getLayer("trail-layer")) {
      map.setLayoutProperty("trail-layer", "visibility", hideGlen ? "none" : "visible");
    }
  }, [isRecording, isReturnMode, livePath.length, mapLoaded]);

  // Append a dead-reckoned point to the live path. Origin = device GPS (set on mount).
  // Only runs while Record Trail is active.
  const appendLivePoint = useCallback((update: Partial<Sensor>) => {
    if (!isRecordingRef.current) return;
    if (
      update.heading === undefined ||
      update.accelX === undefined ||
      update.accelY === undefined ||
      update.accelZ === undefined
    ) return;

    const path = livePathRef.current;
    let origin: LivePoint | null;
    if (path.length === 0) {
      origin = gpsOriginRef.current;
      if (!origin) return; // wait for GPS fix
      setLivePath([origin]);
    } else {
      origin = path[path.length - 1];
    }

    const next = deadReckon(
      origin.lat, origin.lng,
      update.heading,
      update.accelX, update.accelY, update.accelZ
    );

    if (next.lat === origin.lat && next.lng === origin.lng && path.length > 0) return;
    setLivePath((p) => [...p, next]);
  }, []);

  // 5. Arduino Serial Logic
  const connectArduino = useCallback(async () => {
    if (portRef.current) return; // already connected — ignore duplicate clicks / Strict Mode double invokes
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const nav = navigator as any;
      if (!nav.serial) {
        alert("Web Serial is only supported in Chrome or Edge.");
        return;
      }
      const port = await nav.serial.requestPort();
      try {
        await port.open({ baudRate: 115200 });
      } catch (e) {
        // Port may already be open from a prior HMR reload — proceed anyway.
        if (!(e instanceof DOMException && e.name === "InvalidStateError")) throw e;
      }
      portRef.current = port;
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
          const update = parseArduinoLine(line.trim());
          if (!update) continue;
          setSensor((prev) => ({ ...prev, ...update }));
          appendLivePoint(update);
        }
      }
    } catch (err) {
      console.error("Serial connection failed:", err);
      setArduinoConnected(false);
    }
  }, [appendLivePoint]);
  
  // Manually retry GPS if it failed on page load.
  const retryGps = useCallback(() => {
    if (!navigator.geolocation) return;
    setGpsStatus("pending");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const origin: LivePoint = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        gpsOriginRef.current = origin;
        setGpsStatus("ok");
        setSensor((s) => ({
          ...s, lat: origin.lat, lng: origin.lng,
          accuracy: Math.round(pos.coords.accuracy ?? 0),
        }));
        mapRef.current?.flyTo({ center: [origin.lng, origin.lat], zoom: 17, duration: 1500 });
      },
      (err) => { console.warn("GPS retry failed:", err.message); setGpsStatus("error"); },
      { enableHighAccuracy: false, timeout: 20000 }
    );
  }, []);

  // Clear a finished recording (or return journey) and restore the Glen view.
  const clearRecording = useCallback(() => {
    setIsRecording(false);
    setIsReturnMode(false);
    setLivePath([]);
    if (userMarkerRef.current) {
      userMarkerRef.current.remove();
      userMarkerRef.current = null;
    }
    (mapRef.current?.getSource("live-path-source") as mapboxgl.GeoJSONSource | undefined)
      ?.setData({ type: "FeatureCollection", features: [] });
    (mapRef.current?.getSource("return-guide-source") as mapboxgl.GeoJSONSource | undefined)
      ?.setData({ type: "FeatureCollection", features: [] });
    const trail = trailRef.current;
    if (mapRef.current && trail.length > 0) {
      const bounds = new mapboxgl.LngLatBounds();
      trail.forEach((p) => bounds.extend([p.lng, p.lat]));
      mapRef.current.fitBounds(bounds, { padding: 50, duration: 1200 });
    }
  }, []);

  // Show the reversed outbound path as an orange guide and start tracking
  // the return journey from where recording stopped.
  const showReturnRoute = useCallback(() => {
    const outbound = livePathRef.current;
    if (outbound.length < 2) return;

    (mapRef.current?.getSource("return-guide-source") as mapboxgl.GeoJSONSource | undefined)
      ?.setData({
        type: "Feature", properties: {},
        geometry: {
          type: "LineString",
          coordinates: [...outbound].reverse().map((p) => [p.lng, p.lat]),
        },
      });

    const returnOrigin = outbound[outbound.length - 1];
    gpsOriginRef.current = returnOrigin;
    setLivePath([returnOrigin]);
    setIsReturnMode(true);
    setIsRecording(true);
    mapRef.current?.flyTo({ center: [returnOrigin.lng, returnOrigin.lat], zoom: 17, duration: 800 });
  }, []);

  // Record Trail — uses the GPS origin captured at page load (GPS called only once).
  // Falls back to trail start or last known origin when GPS is unavailable.
  const toggleRecord = useCallback(() => {
    setIsRecording((prev) => {
      if (prev) return false; // stop

      const origin: LivePoint =
        gpsOriginRef.current ??
        (trailRef.current.length > 0
          ? { lat: trailRef.current[0].lat, lng: trailRef.current[0].lng }
          : { lat: 0, lng: 0 });

      gpsOriginRef.current = origin;
      setLivePath([origin]);
      setSensor((s) => ({ ...s, lat: origin.lat, lng: origin.lng }));
      mapRef.current?.flyTo({ center: [origin.lng, origin.lat], zoom: 17, duration: 1200 });
      return true;
    });
  }, []);

  const stopDemo = useCallback(() => {
    if (demoIntervalRef.current) {
      clearInterval(demoIntervalRef.current);
      demoIntervalRef.current = null;
    }
  }, []);

  const toggleDemo = useCallback(() => {
    setIsDemoMode((prev) => {
      const next = !prev;
      if (!next) {
        stopDemo();
        return next;
      }

      const trail = trailRef.current;
      if (trail.length < 2) return prev; // nothing to walk

      // Reset path to trail start so the demo trip animates from the beginning.
      demoIndexRef.current = 0;
      const start = trail[0];
      setLivePath([{ lat: start.lat, lng: start.lng }]);
      setSensor((s) => ({ ...s, lat: start.lat, lng: start.lng, altitude: start.elevation }));
      mapRef.current?.flyTo({ center: [start.lng, start.lat], zoom: 17, duration: 1200 });

      demoIntervalRef.current = setInterval(() => {
        const t = trailRef.current;
        const i = ++demoIndexRef.current;
        if (i >= t.length) {
          stopDemo();
          setIsDemoMode(false);
          return;
        }
        const p = t[i];
        const q = t[i - 1];
        const hdg = bearing(q.lat, q.lng, p.lat, p.lng);
        setSensor((s) => ({ ...s, lat: p.lat, lng: p.lng, heading: hdg, altitude: p.elevation }));
        setLivePath((lp) => [...lp, { lat: p.lat, lng: p.lng }]);
      }, 200);

      return next;
    });
  }, [stopDemo]);

  useEffect(() => () => stopDemo(), [stopDemo]);
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
          <span className={`text-xs flex items-center gap-1.5 ${gpsStatus === "ok" ? "text-green-400" : gpsStatus === "error" ? "text-yellow-400" : "text-gray-400"}`}>
            <span className={`w-2 h-2 rounded-full inline-block ${gpsStatus === "ok" ? "bg-green-500" : gpsStatus === "error" ? "bg-yellow-500" : "bg-gray-500 animate-pulse"}`} />
            {gpsStatus === "ok" ? "GPS" : gpsStatus === "error" ? "GPS N/A" : "GPS…"}
            {gpsStatus === "error" && (
              <button onClick={retryGps} className="text-[10px] underline text-yellow-400 cursor-pointer ml-0.5">retry</button>
            )}
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
          {!isReturnMode && (
            <button
              onClick={toggleRecord}
              disabled={!arduinoConnected}
              className={`text-[11px] px-3 py-1 rounded border transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
                isRecording
                  ? "border-red-500 text-red-400 bg-red-500/10"
                  : "border-gray-600 text-gray-300 hover:border-gray-500"
              }`}
            >
              {isRecording ? "● Recording" : "Record Trail"}
            </button>
          )}
          {isReturnMode && (
            <button
              onClick={toggleRecord}
              disabled={!arduinoConnected}
              className={`text-[11px] px-3 py-1 rounded border transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
                isRecording
                  ? "border-orange-500 text-orange-400 bg-orange-500/10"
                  : "border-gray-600 text-gray-300 hover:border-gray-500"
              }`}
            >
              {isRecording ? "↩ Returning" : "↩ Return Route"}
            </button>
          )}
          {!isRecording && livePath.length > 1 && !isReturnMode && (
            <button
              onClick={showReturnRoute}
              disabled={!arduinoConnected}
              className="text-[11px] px-3 py-1 rounded border border-orange-600 text-orange-400 hover:border-orange-500 cursor-pointer transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              ↩ Return Route
            </button>
          )}
          {!isRecording && (livePath.length > 1 || isReturnMode) && (
            <button
              onClick={clearRecording}
              className="text-[11px] px-3 py-1 rounded border border-gray-600 text-gray-300 hover:border-gray-500 cursor-pointer transition-colors"
            >
              ✕ Clear
            </button>
          )}
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
  if (ppm <= 0) return { label: "NO DATA", color: "#6b7280" };
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

function parseArduinoLine(line: string): Partial<Sensor> | null {
  if (!line) return null;
  const pairs = line.split(",");
  const update: Partial<Sensor> = {};
  let any = false;
  for (const pair of pairs) {
    const [key, val] = pair.split(":");
    if (!key || val === undefined) continue;
    const v = parseFloat(val);
    if (Number.isNaN(v)) continue;
    switch (key.trim().toUpperCase()) {
      case "LAT": update.lat = v; any = true; break;
      case "LNG": update.lng = v; any = true; break;
      case "ACC": update.accuracy = v; any = true; break;
      case "HDG": update.heading = v; any = true; break;
      case "TEMP": update.temp = v; any = true; break;
      case "PRES": update.pressure = v; any = true; break;
      case "ALT": update.altitude = v; any = true; break;
      case "PPM": update.ppm = v; any = true; break;
      case "AX": update.accelX = v; any = true; break;
      case "AY": update.accelY = v; any = true; break;
      case "AZ": update.accelZ = v; any = true; break;
      case "GX": update.gyroX = v; any = true; break;
      case "GY": update.gyroY = v; any = true; break;
      case "GZ": update.gyroZ = v; any = true; break;
    }
  }
  return any ? update : null;
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
