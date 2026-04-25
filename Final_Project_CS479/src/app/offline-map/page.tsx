"use client";

import { useRef, useEffect, useState, useCallback } from "react";

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
  lat: 0, lng: 0, accuracy: 0,
  heading: 0,
  temp: 0, pressure: 0, altitude: 0,
  ppm: 0,
  accelX: 0, accelY: 0, accelZ: 0,
  gyroX: 0, gyroY: 0, gyroZ: 0,
};

function elevToColor(e: number, min: number, max: number): string {
  const t = max === min ? 0 : (e - min) / (max - min);
  if (t < 0.33) {
    const s = t / 0.33;
    return `rgb(${Math.round(s * 255)},255,0)`;
  } else if (t < 0.66) {
    const s = (t - 0.33) / 0.33;
    return `rgb(255,${Math.round(255 - s * 90)},0)`;
  } else {
    const s = (t - 0.66) / 0.34;
    return `rgb(255,${Math.round(165 - s * 165)},0)`;
  }
}

function headingToDir(h: number): string {
  const d = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];
  return d[Math.round(h / 22.5) % 16];
}

function aqStatus(ppm: number): { label: string; color: string } {
  if (ppm < 400) return { label: "Good", color: "#22c55e" };
  if (ppm < 1000) return { label: "Moderate", color: "#eab308" };
  return { label: "Poor", color: "#ef4444" };
}

function renderCompass(canvas: HTMLCanvasElement, heading: number) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const { width: w, height: h } = canvas;
  const cx = w / 2, cy = h / 2;
  const r = Math.min(w, h) / 2 - 2;

  ctx.clearRect(0, 0, w, h);

  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = "#111";
  ctx.fill();
  ctx.strokeStyle = "#333";
  ctx.lineWidth = 1;
  ctx.stroke();

  for (let i = 0; i < 36; i++) {
    const a = (i * 10 - 90) * (Math.PI / 180);
    const isMajor = i % 9 === 0;
    const inner = r - (isMajor ? 10 : 5);
    ctx.beginPath();
    ctx.moveTo(cx + inner * Math.cos(a), cy + inner * Math.sin(a));
    ctx.lineTo(cx + (r - 1) * Math.cos(a), cy + (r - 1) * Math.sin(a));
    ctx.strokeStyle = isMajor ? "#555" : "#2a2a2a";
    ctx.lineWidth = isMajor ? 1.5 : 0.5;
    ctx.stroke();
  }

  const cardinals: [string, number][] = [["N", 0], ["E", 90], ["S", 180], ["W", 270]];
  ctx.font = `${Math.round(r * 0.22)}px monospace`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const [label, deg] of cardinals) {
    const a = (deg - 90) * (Math.PI / 180);
    const lr = r - 14;
    ctx.fillStyle = label === "N" ? "#ef4444" : "#555";
    ctx.fillText(label, cx + lr * Math.cos(a), cy + lr * Math.sin(a));
  }

  const ha = (heading - 90) * (Math.PI / 180);
  const nl = r * 0.52;

  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + nl * Math.cos(ha), cy + nl * Math.sin(ha));
  ctx.strokeStyle = "#ef4444";
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx - nl * 0.5 * Math.cos(ha), cy - nl * 0.5 * Math.sin(ha));
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(cx, cy, 3, 0, Math.PI * 2);
  ctx.fillStyle = "#fff";
  ctx.fill();
}

function renderTrail(canvas: HTMLCanvasElement, trail: TrailPoint[]) {
  const ctx = canvas.getContext("2d");
  if (!ctx || trail.length === 0 || canvas.width === 0 || canvas.height === 0) return;

  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#050505";
  ctx.fillRect(0, 0, w, h);

  let minLat = trail[0].lat, maxLat = trail[0].lat;
  let minLng = trail[0].lng, maxLng = trail[0].lng;
  let minElev = trail[0].elevation, maxElev = trail[0].elevation;

  for (const p of trail) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lng < minLng) minLng = p.lng;
    if (p.lng > maxLng) maxLng = p.lng;
    if (p.elevation < minElev) minElev = p.elevation;
    if (p.elevation > maxElev) maxElev = p.elevation;
  }

  const pad = 50;
  const rangeX = maxLng - minLng || 0.001;
  const rangeY = maxLat - minLat || 0.001;
  const scale = Math.min((w - pad * 2) / rangeX, (h - pad * 2) / rangeY);
  const ox = (w - scale * rangeX) / 2;
  const oy = (h - scale * rangeY) / 2;

  const toXY = (lat: number, lng: number) => ({
    x: ox + (lng - minLng) * scale,
    y: h - (oy + (lat - minLat) * scale),
  });

  // Grid
  ctx.lineWidth = 1;
  for (let i = 0; i <= 10; i++) {
    const { x } = toXY(minLat, minLng + (i / 10) * rangeX);
    ctx.strokeStyle = "#131313";
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();

    const { y } = toXY(minLat + (i / 10) * rangeY, minLng);
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
  }

  // Trail segments colored by elevation
  ctx.lineWidth = 2.5;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  for (let i = 1; i < trail.length; i++) {
    const a = toXY(trail[i - 1].lat, trail[i - 1].lng);
    const b = toXY(trail[i].lat, trail[i].lng);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.strokeStyle = elevToColor(trail[i].elevation, minElev, maxElev);
    ctx.stroke();
  }

  // START marker
  const sp = toXY(trail[0].lat, trail[0].lng);
  ctx.beginPath();
  ctx.arc(sp.x, sp.y, 5, 0, Math.PI * 2);
  ctx.fillStyle = "#000";
  ctx.fill();
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = "#fff";
  ctx.font = "11px monospace";
  ctx.textAlign = "left";
  ctx.fillText("START", sp.x + 9, sp.y - 4);
}

export default function OfflineMap() {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapCanvasRef = useRef<HTMLCanvasElement>(null);
  const compassRef = useRef<HTMLCanvasElement>(null);
  const trailRef = useRef<TrailPoint[]>([]);

  const [trail, setTrail] = useState<TrailPoint[]>([]);
  const [isDemoMode, setIsDemoMode] = useState(false);
  const [arduinoConnected, setArduinoConnected] = useState(false);
  const [sensor, setSensor] = useState<Sensor>(DEFAULT_SENSOR);

  trailRef.current = trail;

  // Load trail from CSV via API
  useEffect(() => {
    fetch("/api/trail")
      .then((r) => r.json())
      .then((data: TrailPoint[]) => setTrail(data))
      .catch(console.error);
  }, []);

  // Resize canvas to fill container, redraw when size changes
  useEffect(() => {
    const container = mapContainerRef.current;
    const canvas = mapCanvasRef.current;
    if (!container || !canvas) return;

    const ro = new ResizeObserver(() => {
      canvas.width = container.clientWidth;
      canvas.height = container.clientHeight;
      if (trailRef.current.length > 0) renderTrail(canvas, trailRef.current);
    });
    ro.observe(container);
    return () => ro.disconnect();
  }, []);

  // Redraw when trail data arrives
  useEffect(() => {
    const canvas = mapCanvasRef.current;
    if (!canvas || trail.length === 0) return;
    renderTrail(canvas, trail);
  }, [trail]);

  // Compass
  useEffect(() => {
    if (compassRef.current) renderCompass(compassRef.current, sensor.heading);
  }, [sensor.heading]);

  const toggleDemo = useCallback(() => {
    setIsDemoMode((prev) => {
      if (!prev && trailRef.current.length > 0) {
        const first = trailRef.current[0];
        setSensor((s) => ({ ...s, lat: first.lat, lng: first.lng, altitude: first.elevation }));
      }
      return !prev;
    });
  }, []);

  const connectArduino = useCallback(async () => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const nav = navigator as any;
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
        if (!value) continue;
        buffer += value;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          parseArduinoLine(line.trim(), setSensor);
        }
      }
    } catch (err) {
      console.error("Serial error:", err);
      setArduinoConnected(false);
    }
  }, []);

  const aq = aqStatus(sensor.ppm);

  return (
    <div className="flex flex-col h-screen bg-black text-white font-mono select-none overflow-hidden">
      {/* Header */}
      <header className="flex items-center justify-between px-4 py-2 border-b border-gray-800 shrink-0">
        <div className="flex items-center gap-3">
          <span className="text-sm font-bold tracking-widest">Offline Trail Navigator</span>
          <span className="text-[10px] bg-orange-600 text-white px-2 py-0.5 rounded font-bold tracking-widest">
            OFFLINE
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
      <div className="flex flex-1 overflow-hidden">
        {/* Map canvas */}
        <div ref={mapContainerRef} className="flex-1 relative overflow-hidden">
          <canvas ref={mapCanvasRef} className="absolute inset-0" />
          {/* Altitude legend */}
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
        </div>

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

function parseArduinoLine(line: string, setSensor: React.Dispatch<React.SetStateAction<Sensor>>) {
  // Expected format: KEY:value pairs separated by commas, e.g. "LAT:41.72,LNG:-87.97,..."
  const pairs = line.split(",");
  const update: Partial<Sensor> = {};
  for (const pair of pairs) {
    const [key, val] = pair.split(":");
    if (!key || val === undefined) continue;
    const v = parseFloat(val);
    switch (key.trim().toUpperCase()) {
      case "LAT": update.lat = v; break;
      case "LNG": update.lng = v; break;
      case "ACC": update.accuracy = v; break;
      case "HDG": update.heading = v; break;
      case "TEMP": update.temp = v; break;
      case "PRES": update.pressure = v; break;
      case "ALT": update.altitude = v; break;
      case "PPM": update.ppm = v; break;
      case "AX": update.accelX = v; break;
      case "AY": update.accelY = v; break;
      case "AZ": update.accelZ = v; break;
      case "GX": update.gyroX = v; break;
      case "GY": update.gyroY = v; break;
      case "GZ": update.gyroZ = v; break;
    }
  }
  setSensor((prev) => ({ ...prev, ...update }));
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
      <span className="text-[11px] text-white w-8 text-right shrink-0">{value}</span>
    </div>
  );
}
