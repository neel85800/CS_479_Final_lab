export interface GeoPoint {
  lat: number;
  lng: number;
}

export interface DeadReckoningSample {
  heading: number;
  accelX: number;
  accelY: number;
  accelZ: number;
  gyroX: number;
  gyroY: number;
  gyroZ: number;
  moving?: number;
  timestampMs?: number;
}

export interface DeadReckoningState {
  smoothedHeading: number | null;
  stepArmed: boolean;
  lastStepAtMs: number | null;
}

export interface DeadReckoningOptions {
  accelMode?: "rawAbsolute" | "rawDelta" | "si";
  guidePath?: GeoPoint[];
  baseStepMeters?: number;
  minStepMeters?: number;
  maxStepMeters?: number;
  minStepIntervalMs?: number;
  fallbackStepIntervalMs?: number;
  headingSmoothingAlpha?: number;
  snapMaxDistanceMeters?: number;
  snapBlend?: number;
}

export interface DeadReckoningUpdate {
  point: GeoPoint | null;
  moving: boolean;
  stepDetected: boolean;
  heading: number;
  stepMeters: number;
  dynamicG: number;
  gyroDps: number;
}

const RAW_ACCEL_GRAVITY = 16384;
const SI_ACCEL_GRAVITY = 9.80665;
const RAW_GYRO_LSB_PER_DPS = 131;
const METERS_PER_DEG_LAT = 111000;

const MOVE_DYNAMIC_G_THRESHOLD = 0.08;
const STEP_DYNAMIC_G_THRESHOLD = 0.16;
const STEP_REARM_DYNAMIC_G = 0.07;
const RAW_DELTA_STEP_DYNAMIC_G_THRESHOLD = 0.012;
const RAW_DELTA_REARM_DYNAMIC_G = 0.006;
const RAW_DELTA_EXTERNAL_STEP_DYNAMIC_G = 0.004;
const GYRO_DPS_MOVE_THRESHOLD = 8;
const MAX_REARM_INTERVAL_MS = 1200;

const DEFAULT_BASE_STEP_METERS = 0.62;
const DEFAULT_MIN_STEP_METERS = 0.42;
const DEFAULT_MAX_STEP_METERS = 0.86;
const DEFAULT_MIN_STEP_INTERVAL_MS = 360;
const DEFAULT_FALLBACK_STEP_INTERVAL_MS = 760;
const DEFAULT_HEADING_ALPHA = 0.32;
const DEFAULT_SNAP_DISTANCE_METERS = 18;
const DEFAULT_SNAP_BLEND = 0.85;

export function createDeadReckoningState(): DeadReckoningState {
  return {
    smoothedHeading: null,
    stepArmed: true,
    lastStepAtMs: null,
  };
}

export function resetDeadReckoningState(state: DeadReckoningState): void {
  state.smoothedHeading = null;
  state.stepArmed = true;
  state.lastStepAtMs = null;
}

export function isMpu6050Moving(
  ax: number,
  ay: number,
  az: number,
  gx: number,
  gy: number,
  gz: number
): boolean {
  const metrics = getMpu6050MotionMetrics(ax, ay, az, gx, gy, gz);
  return metrics.dynamicG > MOVE_DYNAMIC_G_THRESHOLD || metrics.gyroDps > GYRO_DPS_MOVE_THRESHOLD;
}

export function updateDeadReckoningPosition(
  origin: GeoPoint,
  sample: DeadReckoningSample,
  state: DeadReckoningState,
  options: DeadReckoningOptions = {}
): DeadReckoningUpdate {
  const now = sample.timestampMs ?? Date.now();
  const metrics = getMpu6050MotionMetrics(
    sample.accelX,
    sample.accelY,
    sample.accelZ,
    sample.gyroX,
    sample.gyroY,
    sample.gyroZ,
    options.accelMode
  );
  const hasExternalMotionFlag = sample.moving !== undefined;
  const externalMoving = sample.moving !== undefined && sample.moving > 0;
  const moving = hasExternalMotionFlag
    ? externalMoving
    : metrics.dynamicG > MOVE_DYNAMIC_G_THRESHOLD || metrics.gyroDps > GYRO_DPS_MOVE_THRESHOLD;

  const heading = smoothHeading(
    state.smoothedHeading,
    sample.heading,
    options.headingSmoothingAlpha ?? DEFAULT_HEADING_ALPHA
  );
  state.smoothedHeading = heading;

  const minStepIntervalMs = options.minStepIntervalMs ?? DEFAULT_MIN_STEP_INTERVAL_MS;
  const fallbackStepIntervalMs =
    options.fallbackStepIntervalMs ?? DEFAULT_FALLBACK_STEP_INTERVAL_MS;
  const elapsedMs =
    state.lastStepAtMs === null ? Number.POSITIVE_INFINITY : now - state.lastStepAtMs;
  const rawDeltaMode = options.accelMode === "rawDelta";
  const stepDynamicThreshold = rawDeltaMode
    ? RAW_DELTA_STEP_DYNAMIC_G_THRESHOLD
    : STEP_DYNAMIC_G_THRESHOLD;
  const rearmDynamicThreshold = rawDeltaMode ? RAW_DELTA_REARM_DYNAMIC_G : STEP_REARM_DYNAMIC_G;
  const externalStepDynamicThreshold = rawDeltaMode ? RAW_DELTA_EXTERNAL_STEP_DYNAMIC_G : 0.035;

  if (!moving) {
    state.stepArmed = true;
    return {
      point: null,
      moving,
      stepDetected: false,
      heading,
      stepMeters: 0,
      dynamicG: metrics.dynamicG,
      gyroDps: metrics.gyroDps,
    };
  }

  if (elapsedMs > MAX_REARM_INTERVAL_MS) {
    state.stepArmed = true;
  }

  const peakStep =
    state.stepArmed &&
    metrics.dynamicG >= stepDynamicThreshold &&
    elapsedMs >= minStepIntervalMs;
  const cadenceFallbackStep =
    externalMoving &&
    metrics.dynamicG >= externalStepDynamicThreshold &&
    elapsedMs >= fallbackStepIntervalMs;
  const stepDetected = peakStep || cadenceFallbackStep;

  if (!stepDetected) {
    if (metrics.dynamicG <= rearmDynamicThreshold) {
      state.stepArmed = true;
    }
    return {
      point: null,
      moving,
      stepDetected: false,
      heading,
      stepMeters: 0,
      dynamicG: metrics.dynamicG,
      gyroDps: metrics.gyroDps,
    };
  }

  const stepMeters = estimateStepMeters(metrics.dynamicG, elapsedMs, options);
  state.lastStepAtMs = now;
  state.stepArmed = false;

  let point = movePoint(origin, heading, stepMeters);
  if (options.guidePath && options.guidePath.length > 1) {
    point = snapPointToPath(
      point,
      options.guidePath,
      options.snapMaxDistanceMeters ?? DEFAULT_SNAP_DISTANCE_METERS,
      options.snapBlend ?? DEFAULT_SNAP_BLEND
    );
  }

  return {
    point,
    moving,
    stepDetected,
    heading,
    stepMeters,
    dynamicG: metrics.dynamicG,
    gyroDps: metrics.gyroDps,
  };
}

export function deadReckon(
  lat: number,
  lng: number,
  heading: number,
  ax: number,
  ay: number,
  az: number,
  gx: number,
  gy: number,
  gz: number,
  forceStep = false
): GeoPoint {
  if (!forceStep && !isMpu6050Moving(ax, ay, az, gx, gy, gz)) return { lat, lng };
  return movePoint({ lat, lng }, heading, DEFAULT_BASE_STEP_METERS);
}

export function bearing(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const phi1 = (lat1 * Math.PI) / 180;
  const phi2 = (lat2 * Math.PI) / 180;
  const dLambda = ((lng2 - lng1) * Math.PI) / 180;
  const y = Math.sin(dLambda) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda);
  return normalizeHeading((Math.atan2(y, x) * 180) / Math.PI);
}

export function distanceMeters(a: GeoPoint, b: GeoPoint): number {
  const meanLat = ((a.lat + b.lat) / 2) * (Math.PI / 180);
  const metersPerDegLng = METERS_PER_DEG_LAT * Math.cos(meanLat);
  const dx = (b.lng - a.lng) * metersPerDegLng;
  const dy = (b.lat - a.lat) * METERS_PER_DEG_LAT;
  return Math.sqrt(dx * dx + dy * dy);
}

export function interpolateGeoPoint(a: GeoPoint, b: GeoPoint, amount: number): GeoPoint {
  const t = clamp(amount, 0, 1);
  return {
    lat: a.lat + (b.lat - a.lat) * t,
    lng: a.lng + (b.lng - a.lng) * t,
  };
}

function getMpu6050MotionMetrics(
  ax: number,
  ay: number,
  az: number,
  gx: number,
  gy: number,
  gz: number,
  accelMode: DeadReckoningOptions["accelMode"] = "rawAbsolute"
): { dynamicG: number; gyroDps: number } {
  const accelMag = Math.sqrt(ax * ax + ay * ay + az * az);
  const gyroMag = Math.sqrt(gx * gx + gy * gy + gz * gz);
  const mode = accelMode ?? "rawAbsolute";
  const dynamicG = mode === "rawDelta"
    ? accelMag / RAW_ACCEL_GRAVITY
    : mode === "si"
      ? Math.abs(accelMag - SI_ACCEL_GRAVITY) / SI_ACCEL_GRAVITY
      : Math.abs(accelMag - RAW_ACCEL_GRAVITY) / RAW_ACCEL_GRAVITY;
  const gyroDps = mode === "si" ? (gyroMag * 180) / Math.PI : gyroMag / RAW_GYRO_LSB_PER_DPS;
  return { dynamicG, gyroDps };
}

function estimateStepMeters(
  dynamicG: number,
  elapsedMs: number,
  options: DeadReckoningOptions
): number {
  const baseStepMeters = options.baseStepMeters ?? DEFAULT_BASE_STEP_METERS;
  const minStepMeters = options.minStepMeters ?? DEFAULT_MIN_STEP_METERS;
  const maxStepMeters = options.maxStepMeters ?? DEFAULT_MAX_STEP_METERS;
  const intervalMs = Number.isFinite(elapsedMs) ? elapsedMs : 650;
  const cadenceFactor = clamp(650 / intervalMs, 0.85, 1.18);
  const intensity = clamp((dynamicG - STEP_REARM_DYNAMIC_G) / 0.38, 0, 1);
  const stride = (baseStepMeters + intensity * 0.16) * cadenceFactor;
  return clamp(stride, minStepMeters, maxStepMeters);
}

function movePoint(origin: GeoPoint, heading: number, meters: number): GeoPoint {
  const rad = (normalizeHeading(heading) * Math.PI) / 180;
  const dLat = (meters * Math.cos(rad)) / METERS_PER_DEG_LAT;
  const metersPerDegLng = METERS_PER_DEG_LAT * Math.cos((origin.lat * Math.PI) / 180);
  const dLng = (meters * Math.sin(rad)) / Math.max(Math.abs(metersPerDegLng), 1);
  return { lat: origin.lat + dLat, lng: origin.lng + dLng };
}

function snapPointToPath(
  point: GeoPoint,
  path: GeoPoint[],
  maxDistanceMeters: number,
  blend: number
): GeoPoint {
  let best: { point: GeoPoint; distance: number } | null = null;

  for (let i = 1; i < path.length; i++) {
    const projected = projectPointToSegment(point, path[i - 1], path[i]);
    if (!best || projected.distance < best.distance) {
      best = projected;
    }
  }

  if (!best || best.distance > maxDistanceMeters) return point;
  return interpolateGeoPoint(point, best.point, blend);
}

function projectPointToSegment(
  point: GeoPoint,
  start: GeoPoint,
  end: GeoPoint
): { point: GeoPoint; distance: number } {
  const refLat = start.lat * (Math.PI / 180);
  const metersPerDegLng = METERS_PER_DEG_LAT * Math.cos(refLat);
  const px = (point.lng - start.lng) * metersPerDegLng;
  const py = (point.lat - start.lat) * METERS_PER_DEG_LAT;
  const sx = (end.lng - start.lng) * metersPerDegLng;
  const sy = (end.lat - start.lat) * METERS_PER_DEG_LAT;
  const lengthSq = sx * sx + sy * sy;

  if (lengthSq === 0) {
    return { point: start, distance: distanceMeters(point, start) };
  }

  const t = clamp((px * sx + py * sy) / lengthSq, 0, 1);
  const projected = {
    lat: start.lat + (end.lat - start.lat) * t,
    lng: start.lng + (end.lng - start.lng) * t,
  };

  return {
    point: projected,
    distance: distanceMeters(point, projected),
  };
}

function smoothHeading(previous: number | null, current: number, alpha: number): number {
  const heading = normalizeHeading(current);
  if (previous === null) return heading;

  const prevRad = (previous * Math.PI) / 180;
  const currRad = (heading * Math.PI) / 180;
  const x = (1 - alpha) * Math.cos(prevRad) + alpha * Math.cos(currRad);
  const y = (1 - alpha) * Math.sin(prevRad) + alpha * Math.sin(currRad);
  return normalizeHeading((Math.atan2(y, x) * 180) / Math.PI);
}

function normalizeHeading(heading: number): number {
  return ((heading % 360) + 360) % 360;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
