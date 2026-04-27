// Raw MPU6050 accelerometer values are 16-bit signed at ±2g range,
// so 1g ≈ 16384 LSB. We treat any deviation > MOVE_THRESHOLD as a step.
const ACCEL_GRAVITY = 16384;
const MOVE_THRESHOLD = 5000;
const STEP_METERS = 0.6;
const METERS_PER_DEG_LAT = 111000;

export function isMoving(ax: number, ay: number, az: number): boolean {
  const mag = Math.sqrt(ax * ax + ay * ay + az * az);
  return Math.abs(mag - ACCEL_GRAVITY) > MOVE_THRESHOLD;
}

export function deadReckon(
  lat: number,
  lng: number,
  heading: number,
  ax: number,
  ay: number,
  az: number
): { lat: number; lng: number } {
  if (!isMoving(ax, ay, az)) return { lat, lng };

  const rad = (heading * Math.PI) / 180;
  const dLat = (STEP_METERS * Math.cos(rad)) / METERS_PER_DEG_LAT;
  const metersPerDegLng = METERS_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);
  const dLng = (STEP_METERS * Math.sin(rad)) / Math.max(metersPerDegLng, 1);

  return { lat: lat + dLat, lng: lng + dLng };
}

export function bearing(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const phi1 = (lat1 * Math.PI) / 180;
  const phi2 = (lat2 * Math.PI) / 180;
  const dLambda = ((lng2 - lng1) * Math.PI) / 180;
  const y = Math.sin(dLambda) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}
