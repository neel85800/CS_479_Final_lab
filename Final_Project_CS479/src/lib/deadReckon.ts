// Supports either raw-ish MPU6050 values or Adafruit_MPU6050 event values.
// Adafruit reports acceleration in m/s^2 and gyro rotation in rad/s.
const RAW_ACCEL_GRAVITY = 16384;
const RAW_ACCEL_MOVE_THRESHOLD = 3000;
const SI_ACCEL_GRAVITY = 9.80665;
const SI_ACCEL_MOVE_THRESHOLD = 1.2;
const GYRO_DEG_PER_SEC_MOVE_THRESHOLD = 12;
const GYRO_RAD_PER_SEC_MOVE_THRESHOLD = 0.25;
const STEP_METERS = 0.6;
const METERS_PER_DEG_LAT = 111000;

export function isMpu6050Moving(
  ax: number,
  ay: number,
  az: number,
  gx: number,
  gy: number,
  gz: number
): boolean {
  const accelMag = Math.sqrt(ax * ax + ay * ay + az * az);
  const gyroMag = Math.sqrt(gx * gx + gy * gy + gz * gz);

  const usesSiUnits = accelMag < 100;
  const accelGravity = usesSiUnits ? SI_ACCEL_GRAVITY : RAW_ACCEL_GRAVITY;
  const accelThreshold = usesSiUnits ? SI_ACCEL_MOVE_THRESHOLD : RAW_ACCEL_MOVE_THRESHOLD;
  const gyroThreshold = usesSiUnits
    ? GYRO_RAD_PER_SEC_MOVE_THRESHOLD
    : GYRO_DEG_PER_SEC_MOVE_THRESHOLD;

  return (
    Math.abs(accelMag - accelGravity) > accelThreshold ||
    gyroMag > gyroThreshold
  );
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
): { lat: number; lng: number } {
  if (!forceStep && !isMpu6050Moving(ax, ay, az, gx, gy, gz)) return { lat, lng };

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
