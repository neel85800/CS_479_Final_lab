"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import {
  createDeadReckoningState,
  distanceMeters,
  interpolateGeoPoint,
  resetDeadReckoningState,
  updateDeadReckoningPosition,
} from "@/lib/deadReckon";

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
  accelMagDelta: number;
  accelJerk: number;
  gyroMag: number;
  moving: number;
  turning: number;
}

type OriginSource = "none" | "browser" | "serial";

const DEFAULT_SENSOR: Sensor = {
  lat: 0,
  lng: 0,
  accuracy: 0,
  heading: 0,
  temp: 0,
  pressure: 0,
  altitude: 0,
  ppm: 0,
  accelX: 0,
  accelY: 0,
  accelZ: 0,
  gyroX: 0,
  gyroY: 0,
  gyroZ: 0,
  accelMagDelta: 0,
  accelJerk: 0,
  gyroMag: 0,
  moving: 0,
  turning: 0,
};

const GPS_CORRECTION_ACCURACY_METERS = 25;
const GPS_APPEND_METERS = 1;
const POSITION_MOTION_METERS = 1;
const POSITION_MOTION_HOLD_MS = 1800;

mapboxgl.accessToken = process.env.NEXT_PUBLIC_MAPBOX_SECRET_KEY;

export default function OnlineMap() {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const userMarkerRef = useRef<mapboxgl.Marker | null>(null);
  const compassRef = useRef<HTMLCanvasElement>(null);
  const livePathRef = useRef<LivePoint[]>([]);
  const returnGuideRef = useRef<LivePoint[]>([]);
  const originRef = useRef<LivePoint | null>(null);
  const lastRealPositionRef = useRef<LivePoint | null>(null);
  const positionMotionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const trackingRef = useRef(createDeadReckoningState());
  const isRecordingRef = useRef(false);
  const isReturnModeRef = useRef(false);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const portRef = useRef<any>(null);

  const [arduinoConnected, setArduinoConnected] = useState(false);
  const [sensor, setSensor] = useState<Sensor>(DEFAULT_SENSOR);
  const [mapLoaded, setMapLoaded] = useState(false);
  const [livePath, setLivePath] = useState<LivePoint[]>([]);
  const [isRecording, setIsRecording] = useState(false);
  const [isReturnMode, setIsReturnMode] = useState(false);
  const [originSource, setOriginSource] = useState<OriginSource>("none");
  const [gpsStatus, setGpsStatus] = useState<"pending" | "ok" | "error">("pending");
  const [positionMoving, setPositionMoving] = useState(false);

  const hasOrigin = originSource !== "none";
  const fusedMoving = sensor.moving > 0 || positionMoving;
  const motionLabel = fusedMoving ? "MOVING" : sensor.turning > 0 ? "TURNING" : "STILL";
  const motionColor = fusedMoving ? "#22c55e" : sensor.turning > 0 ? "#eab308" : "#9ca3af";

  useEffect(() => {
    livePathRef.current = livePath;
  }, [livePath]);

  useEffect(() => {
    isRecordingRef.current = isRecording;
  }, [isRecording]);

  useEffect(() => {
    isReturnModeRef.current = isReturnMode;
  }, [isReturnMode]);

  useEffect(() => {
    if (!mapContainerRef.current) return;

    const map = new mapboxgl.Map({
      container: mapContainerRef.current,
      style: "mapbox://styles/mapbox/dark-v11",
      center: [-98, 39],
      zoom: 3,
      pitch: 35,
      attributionControl: false,
    });

    map.on("load", () => {
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
          "line-opacity": 0.8,
          "line-dasharray": [4, 3],
        },
      });

      mapRef.current = map;
      setMapLoaded(true);
    });

    return () => map.remove();
  }, []);

  const markPositionMoving = useCallback(() => {
    setPositionMoving(true);
    if (positionMotionTimerRef.current) clearTimeout(positionMotionTimerRef.current);
    positionMotionTimerRef.current = setTimeout(() => {
      setPositionMoving(false);
      positionMotionTimerRef.current = null;
    }, POSITION_MOTION_HOLD_MS);
  }, []);

  useEffect(() => () => {
    if (positionMotionTimerRef.current) clearTimeout(positionMotionTimerRef.current);
  }, []);

  const applyRealPosition = useCallback((
    point: LivePoint,
    accuracy: number,
    source: Exclude<OriginSource, "none">
  ) => {
    const previous = lastRealPositionRef.current;
    const accuracyOk = accuracy <= 0 || accuracy <= GPS_CORRECTION_ACCURACY_METERS;
    if (previous && accuracyOk && distanceMeters(previous, point) >= POSITION_MOTION_METERS) {
      markPositionMoving();
    }
    lastRealPositionRef.current = point;

    originRef.current = point;
    setOriginSource(source);
    if (source === "browser") setGpsStatus("ok");
    setSensor((s) => ({
      ...s,
      lat: point.lat,
      lng: point.lng,
      accuracy,
    }));

    if (!isRecordingRef.current) {
      setLivePath((path) => (path.length === 0 ? [point] : path));
      if (mapRef.current && livePathRef.current.length <= 1) {
        mapRef.current.flyTo({ center: [point.lng, point.lat], zoom: 17, duration: 1200 });
      }
      return;
    }

    if (accuracy > GPS_CORRECTION_ACCURACY_METERS) return;

    setLivePath((path) => {
      if (path.length === 0) return [point];
      const last = path[path.length - 1];
      const meters = distanceMeters(last, point);
      if (meters < 1) return path;

      const blend = accuracy <= 8 ? 1 : accuracy <= 15 ? 0.75 : 0.45;
      const corrected = interpolateGeoPoint(last, point, blend);
      return meters >= GPS_APPEND_METERS
        ? [...path, corrected]
        : [...path.slice(0, -1), corrected];
    });
  }, [markPositionMoving]);

  useEffect(() => {
    if (!mapLoaded) return;
    if (!navigator.geolocation) {
      window.setTimeout(() => setGpsStatus("error"), 0);
      return;
    }

    const onPosition = (pos: GeolocationPosition) => {
      applyRealPosition(
        { lat: pos.coords.latitude, lng: pos.coords.longitude },
        Math.round(pos.coords.accuracy ?? 0),
        "browser"
      );
    };

    const onError = (err: GeolocationPositionError) => {
      console.warn("Geolocation failed:", err.message);
      if (!originRef.current) setGpsStatus("error");
    };

    navigator.geolocation.getCurrentPosition(onPosition, onError, {
      enableHighAccuracy: true,
      timeout: 15000,
      maximumAge: 5000,
    });
    const watchId = navigator.geolocation.watchPosition(onPosition, onError, {
      enableHighAccuracy: true,
      timeout: 15000,
      maximumAge: 5000,
    });

    return () => navigator.geolocation.clearWatch(watchId);
  }, [applyRealPosition, mapLoaded]);

  useEffect(() => {
    if (!mapRef.current || !mapLoaded) return;

    const source = mapRef.current.getSource("live-path-source") as mapboxgl.GeoJSONSource | undefined;
    const coords: [number, number][] = livePath.map((p) => [p.lng, p.lat]);
    source?.setData(
      coords.length > 1
        ? {
            type: "Feature",
            properties: {},
            geometry: { type: "LineString", coordinates: coords },
          }
        : { type: "FeatureCollection", features: [] }
    );

    if (livePath.length === 0) return;
    const last = livePath[livePath.length - 1];
    if (!userMarkerRef.current) {
      const el = document.createElement("div");
      el.className = "w-5 h-5 bg-cyan-400 border-2 border-white rounded-full shadow-[0_0_15px_rgba(34,211,238,0.9)]";
      userMarkerRef.current = new mapboxgl.Marker(el).setLngLat([last.lng, last.lat]).addTo(mapRef.current);
    } else {
      userMarkerRef.current.setLngLat([last.lng, last.lat]);
    }

    mapRef.current.easeTo({
      center: [last.lng, last.lat],
      bearing: sensor.heading,
      zoom: Math.max(mapRef.current.getZoom(), 17),
      duration: 700,
    });
  }, [livePath, mapLoaded, sensor.heading]);

  useEffect(() => {
    if (compassRef.current) renderCompass(compassRef.current, sensor.heading);
  }, [sensor.heading]);

  const appendLivePoint = useCallback((update: Partial<Sensor>): LivePoint | null => {
    if (update.lat !== undefined && update.lng !== undefined) {
      const serialPoint = { lat: update.lat, lng: update.lng };
      const accuracy = update.accuracy ?? 0;
      applyRealPosition(serialPoint, accuracy, "serial");
      return serialPoint;
    }

    if (!isRecordingRef.current) return null;
    if (
      update.heading === undefined ||
      update.accelX === undefined ||
      update.accelY === undefined ||
      update.accelZ === undefined ||
      update.gyroX === undefined ||
      update.gyroY === undefined ||
      update.gyroZ === undefined
    ) return null;

    const path = livePathRef.current;
    const seedPath = path.length === 0;
    const origin = seedPath ? originRef.current : path[path.length - 1];
    if (!origin) return null;

    const result = updateDeadReckoningPosition(
      origin,
      {
        heading: update.heading,
        accelX: update.accelX,
        accelY: update.accelY,
        accelZ: update.accelZ,
        gyroX: update.gyroX,
        gyroY: update.gyroY,
        gyroZ: update.gyroZ,
        moving: update.moving,
      },
      trackingRef.current,
      { accelMode: "rawDelta" }
    );

    const nextPoint = result.point;
    if (!nextPoint) {
      if (seedPath) setLivePath([origin]);
      return seedPath ? origin : null;
    }

    setLivePath((pathNow) => (pathNow.length === 0 ? [origin, nextPoint] : [...pathNow, nextPoint]));
    return nextPoint;
  }, [applyRealPosition]);

  const connectArduino = useCallback(async () => {
    if (portRef.current) return;
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
        if (!value) continue;
        buffer += value;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const update = parseArduinoLine(line.trim());
          if (!update) continue;
          const trackedPoint = appendLivePoint(update);
          setSensor((prev) => ({
            ...prev,
            ...update,
            ...(trackedPoint ? { lat: trackedPoint.lat, lng: trackedPoint.lng } : {}),
          }));
        }
      }
    } catch (err) {
      console.error("Serial connection failed:", err);
      setArduinoConnected(false);
    }
  }, [appendLivePoint]);

  const retryGps = useCallback(() => {
    if (!navigator.geolocation) return;
    setGpsStatus("pending");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        applyRealPosition(
          { lat: pos.coords.latitude, lng: pos.coords.longitude },
          Math.round(pos.coords.accuracy ?? 0),
          "browser"
        );
      },
      (err) => {
        console.warn("GPS retry failed:", err.message);
        setGpsStatus("error");
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 }
    );
  }, [applyRealPosition]);

  const clearRecording = useCallback(() => {
    setIsRecording(false);
    setIsReturnMode(false);
    setLivePath(originRef.current ? [originRef.current] : []);
    returnGuideRef.current = [];
    resetDeadReckoningState(trackingRef.current);
    (mapRef.current?.getSource("live-path-source") as mapboxgl.GeoJSONSource | undefined)
      ?.setData({ type: "FeatureCollection", features: [] });
    (mapRef.current?.getSource("return-guide-source") as mapboxgl.GeoJSONSource | undefined)
      ?.setData({ type: "FeatureCollection", features: [] });
  }, []);

  const showReturnRoute = useCallback(() => {
    const outbound = livePathRef.current;
    if (outbound.length < 2) return;
    const reversed = [...outbound].reverse();
    returnGuideRef.current = reversed;
    resetDeadReckoningState(trackingRef.current);

    (mapRef.current?.getSource("return-guide-source") as mapboxgl.GeoJSONSource | undefined)
      ?.setData({
        type: "Feature",
        properties: {},
        geometry: {
          type: "LineString",
          coordinates: reversed.map((p) => [p.lng, p.lat]),
        },
      });

    const returnOrigin = outbound[outbound.length - 1];
    originRef.current = returnOrigin;
    setLivePath([returnOrigin]);
    setIsReturnMode(true);
    setIsRecording(true);
  }, []);

  const toggleRecord = useCallback(() => {
    setIsRecording((prev) => {
      if (prev) return false;
      const origin = originRef.current;
      if (!origin) {
        setGpsStatus("error");
        return false;
      }

      resetDeadReckoningState(trackingRef.current);
      if (!isReturnModeRef.current) returnGuideRef.current = [];
      setLivePath([origin]);
      mapRef.current?.flyTo({ center: [origin.lng, origin.lat], zoom: 17, duration: 900 });
      return true;
    });
  }, []);

  const aq = aqStatus(sensor.ppm);
  const coordText = hasOrigin ? `${sensor.lat.toFixed(6)}, ${sensor.lng.toFixed(6)}` : "--";

  return (
    <div className="flex flex-col h-screen w-full bg-black text-white font-mono select-none overflow-hidden">
      <header className="flex items-center justify-between px-4 py-2 border-b border-gray-800 shrink-0">
        <div className="flex items-center gap-3">
          <span className="text-sm font-bold tracking-widest">TrailBack</span>
          <span className="text-[10px] bg-cyan-700 text-white px-2 py-0.5 rounded font-bold tracking-widest">
            Grp5 - Kirtan, Neel, Nundun, Jose
          </span>
        </div>
        <div className="flex items-center gap-4">
          <span className={`text-xs flex items-center gap-1.5 ${gpsStatus === "ok" || originSource === "serial" ? "text-green-400" : gpsStatus === "error" ? "text-yellow-400" : "text-gray-400"}`}>
            <span className={`w-2 h-2 rounded-full inline-block ${gpsStatus === "ok" || originSource === "serial" ? "bg-green-500" : gpsStatus === "error" ? "bg-yellow-500" : "bg-gray-500 animate-pulse"}`} />
            {originSource === "serial" ? "Serial GPS" : gpsStatus === "ok" ? "GPS" : gpsStatus === "error" ? "Origin Needed" : "Locating"}
            {gpsStatus === "error" && originSource !== "serial" && (
              <button onClick={retryGps} className="text-[10px] underline text-yellow-400 cursor-pointer ml-0.5">retry</button>
            )}
          </span>
          <span className="text-xs flex items-center gap-1.5 text-green-400">
            <span className={`w-2 h-2 rounded-full inline-block ${arduinoConnected ? "bg-green-500" : "bg-gray-600"}`} />
            Arduino
          </span>
          {!isReturnMode && (
            <button
              onClick={toggleRecord}
              disabled={!hasOrigin}
              className={`text-[11px] px-3 py-1 rounded border transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
                isRecording
                  ? "border-red-500 text-red-400 bg-red-500/10"
                  : "border-gray-600 text-gray-300 hover:border-gray-500"
              }`}
            >
              {isRecording ? "● Tracking" : "Start Track"}
            </button>
          )}
          {isReturnMode && (
            <button
              onClick={toggleRecord}
              disabled={!hasOrigin}
              className={`text-[11px] px-3 py-1 rounded border transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
                isRecording
                  ? "border-orange-500 text-orange-400 bg-orange-500/10"
                  : "border-gray-600 text-gray-300 hover:border-gray-500"
              }`}
            >
              {isRecording ? "↩ Returning" : "↩ Return"}
            </button>
          )}
          {!isRecording && livePath.length > 1 && !isReturnMode && (
            <button
              onClick={showReturnRoute}
              className="text-[11px] px-3 py-1 rounded border border-orange-600 text-orange-400 hover:border-orange-500 cursor-pointer transition-colors"
            >
              ↩ Return Route
            </button>
          )}
          {!isRecording && (livePath.length > 1 || isReturnMode) && (
            <button
              onClick={clearRecording}
              className="text-[11px] px-3 py-1 rounded border border-gray-600 text-gray-300 hover:border-gray-500 cursor-pointer transition-colors"
            >
              Clear
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

      <div className="flex flex-1 overflow-hidden relative">
        <main className="flex-1 relative bg-zinc-900">
          <div ref={mapContainerRef} className="absolute inset-0 w-full h-full" />
          <div className="absolute top-4 left-4 p-3 bg-black/70 border border-gray-800 backdrop-blur-md rounded-sm z-10 pointer-events-none min-w-[190px]">
            <p className="text-[9px] text-gray-500 mb-1 tracking-tighter">LIVE_POSITION</p>
            <p className="text-xs text-cyan-300 tabular-nums">{coordText}</p>
            <p className="text-[10px] text-gray-400 mt-1">Source: {originSource === "none" ? "--" : originSource}</p>
          </div>
        </main>

        <aside className="w-52 shrink-0 border-l border-gray-800 overflow-y-auto bg-black">
          <SidePanel label="POSITION">
            <SideRow label="Lat" value={hasOrigin ? sensor.lat.toFixed(6) : "--"} />
            <SideRow label="Lng" value={hasOrigin ? sensor.lng.toFixed(6) : "--"} />
            <SideRow label="Accuracy" value={sensor.accuracy > 0 ? `±${sensor.accuracy} m` : "--"} />
            <SideRow
              label="Motion"
              value={motionLabel}
              valueColor={motionColor}
            />
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
            <AltitudeSparkline value={sensor.altitude} />
          </SidePanel>

          <SidePanel label="AIR QUALITY - MQ135">
            <SideRow label="CO2" value={aq.label} valueColor={aq.color} />
            <SideRow label="PPM" value={`${sensor.ppm} ppm`} />
          </SidePanel>

          <SidePanel label="ACCEL - MPU6050">
            <BarRow label="X" value={sensor.accelX} range={8000} />
            <BarRow label="Y" value={sensor.accelY} range={8000} />
            <BarRow label="Z" value={sensor.accelZ} range={8000} />
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

function headingToDir(h: number): string {
  const d = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];
  return d[Math.round(h / 22.5) % 16];
}

function aqStatus(ppm: number) {
  if (ppm <= 0) return { label: "NO DATA", color: "#6b7280" };
  if (ppm < 450) return { label: "POOR", color: "#ef4444" };
  if (ppm < 1000) return { label: "MODERATE", color: "#eab308" };
  return { label: "EXCELLENT", color: "#22c55e" };
}

function renderCompass(canvas: HTMLCanvasElement, heading: number) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const { width: w, height: h } = canvas;
  const cx = w / 2, cy = h / 2, r = (w / 2) - 5;

  ctx.clearRect(0, 0, w, h);
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.strokeStyle = "#333";
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate((heading * Math.PI) / 180);

  ctx.beginPath();
  ctx.moveTo(0, -r + 10);
  ctx.lineTo(6, 0);
  ctx.lineTo(-6, 0);
  ctx.fillStyle = "#ef4444";
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(0, r - 10);
  ctx.lineTo(6, 0);
  ctx.lineTo(-6, 0);
  ctx.fillStyle = "#fff";
  ctx.fill();
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
      case "AMG": update.accelMagDelta = v; any = true; break;
      case "JRK": update.accelJerk = v; any = true; break;
      case "GMG": update.gyroMag = v; any = true; break;
      case "MOV":
      case "MOVE":
      case "MOTION":
      case "MOVING": update.moving = v; any = true; break;
      case "TURN":
      case "ROT":
      case "ROTATE":
      case "ROTATING": update.turning = v; any = true; break;
    }
  }
  return any ? update : null;
}

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
      <span className="text-[11px] text-white w-8 text-right shrink-0">{Math.round(value)}</span>
    </div>
  );
}

function AltitudeSparkline({ value }: { value: number }) {
  const [history, setHistory] = useState<number[]>([]);

  useEffect(() => {
    if (!Number.isFinite(value) || value <= 0) return;
    setHistory((prev) => [...prev, value].slice(-48));
  }, [value]);

  const values = history.length > 0 ? history : Number.isFinite(value) && value > 0 ? [value] : [];
  const width = 100;
  const height = 36;
  const pad = 4;

  if (values.length === 0) {
    return <div className="h-10 rounded-sm bg-gray-950 border border-gray-900" />;
  }

  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);
  const center = (minValue + maxValue) / 2;
  const range = Math.max(maxValue - minValue, 0.6);
  const min = center - range / 2;
  const latest = values[values.length - 1];
  const first = values[0];
  const delta = latest - first;

  const points = values.length === 1
    ? `0,${height / 2} ${width},${height / 2}`
    : values
        .map((altitude, index) => {
          const x = (index / (values.length - 1)) * width;
          const normalized = (altitude - min) / range;
          const y = height - pad - normalized * (height - pad * 2);
          return `${x.toFixed(1)},${y.toFixed(1)}`;
        })
        .join(" ");

  return (
    <div className="mt-2 rounded-sm border border-gray-800 bg-gray-950 px-2 py-1">
      <div className="flex items-center justify-between text-[9px]">
        <span className="text-gray-500">Height</span>
        <span className={delta >= 0 ? "text-cyan-300" : "text-orange-300"}>
          {delta >= 0 ? "+" : ""}{delta.toFixed(1)} m
        </span>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} className="mt-1 h-9 w-full" aria-hidden="true">
        <line x1="0" y1={height / 2} x2={width} y2={height / 2} stroke="#1f2937" strokeWidth="1" strokeDasharray="2 3" />
        <polyline points={points} fill="none" stroke="#67e8f9" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  );
}
