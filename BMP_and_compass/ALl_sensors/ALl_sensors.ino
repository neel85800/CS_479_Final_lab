#include <Wire.h>
#include <LSM303.h>
#include <SPI.h>
#include <Adafruit_BMP280.h>
#include <MQ135.h>
#include "I2Cdev.h"
#include "MPU6050.h"

#define BMP_SCK  (13)
#define BMP_MISO (12)
#define BMP_MOSI (11)
#define BMP_CS   (10)
#define PIN_MQ135 A2
#define OUTPUT_READABLE_ACCELGYRO

MPU6050 mpu;
LSM303 compass;
Adafruit_BMP280 bmp;
MQ135 mq135_sensor(PIN_MQ135);

float temperature = 21.0;
float humidity = 25.0;
int16_t ax, ay, az;
int16_t gx, gy, gz;
bool blinkState;

// Manual heading offset for the current GY-511 mounting.
const float COMPASS_HEADING_OFFSET_DEG = 90.0;

// A heading offset fixes north only; real min/max values fix east/south/west scale.
const int16_t COMPASS_MIN_X = -32767;
const int16_t COMPASS_MIN_Y = -32767;
const int16_t COMPASS_MIN_Z = -32767;
const int16_t COMPASS_MAX_X = 32767;
const int16_t COMPASS_MAX_Y = 32767;
const int16_t COMPASS_MAX_Z = 32767;

// Tuned from PRES ~= 993.6 hPa and local elevation ~= 600 ft / 183 m.
const float SEA_LEVEL_PRESSURE_HPA = 1015.4;

const int MPU_CALIBRATION_SAMPLES = 500;
const float ACCEL_FILTER_ALPHA = 0.12;      // Low-pass accel so table noise does not look like walking.
const float GYRO_FILTER_ALPHA = 0.20;
const float HEADING_FILTER_ALPHA = 0.25;
const float GYRO_DEADBAND = 110.0;          // Raw MPU6050 units; ignores gyro bias/noise on a table.
const float ACCEL_MAG_MOVE = 75.0;          // Still/turning stayed below ~40; walking was often 90+.
const float ACCEL_JERK_MOVE = 60.0;         // Fast sample-to-sample accel change.
const float ACCEL_JERK_MIN_MAG = 45.0;      // Rejects pure rotations that spike jerk without translation.
const float GYRO_TURN = 650.0;              // Rotation marker only; not used to advance the path.
const byte MOTION_START_SAMPLES = 2;        // Motion must persist before MOV becomes 1.
const byte STILL_REQUIRED_SAMPLES = 5;      // Stillness must persist before MOV returns to 0.

float accelBaseX = 0.0, accelBaseY = 0.0, accelBaseZ = 0.0;
float accelBaseMag = 16384.0;
float gyroBaseX = 0.0, gyroBaseY = 0.0, gyroBaseZ = 0.0;
float filtAx = 0.0, filtAy = 0.0, filtAz = 0.0;
float filtGx = 0.0, filtGy = 0.0, filtGz = 0.0;
float prevFiltAx = 0.0, prevFiltAy = 0.0, prevFiltAz = 0.0;
float filtHeading = 0.0;
byte motionCount = 0;
byte stillCount = 0;
bool isMoving = false;
bool headingReady = false;

float applyDeadband(float value, float deadband) {
  return abs(value) < deadband ? 0.0 : value;
}

float normalizeHeading(float heading) {
  while (heading < 0.0) heading += 360.0;
  while (heading >= 360.0) heading -= 360.0;
  return heading;
}

float smoothHeading(float previous, float current, float alpha) {
  float diff = normalizeHeading(current - previous + 180.0) - 180.0;
  return normalizeHeading(previous + diff * alpha);
}

void calibrateMpu6050() {
  long sumAx = 0, sumAy = 0, sumAz = 0;
  long sumGx = 0, sumGy = 0, sumGz = 0;
  int16_t rawAx, rawAy, rawAz, rawGx, rawGy, rawGz;

  for (int i = 0; i < MPU_CALIBRATION_SAMPLES; i++) {
    mpu.getMotion6(&rawAx, &rawAy, &rawAz, &rawGx, &rawGy, &rawGz);
    sumAx += rawAx;
    sumAy += rawAy;
    sumAz += rawAz;
    sumGx += rawGx;
    sumGy += rawGy;
    sumGz += rawGz;
    delay(5);
  }

  accelBaseX = (float)sumAx / MPU_CALIBRATION_SAMPLES;
  accelBaseY = (float)sumAy / MPU_CALIBRATION_SAMPLES;
  accelBaseZ = (float)sumAz / MPU_CALIBRATION_SAMPLES;
  accelBaseMag = sqrt(accelBaseX * accelBaseX + accelBaseY * accelBaseY + accelBaseZ * accelBaseZ);
  gyroBaseX = (float)sumGx / MPU_CALIBRATION_SAMPLES;
  gyroBaseY = (float)sumGy / MPU_CALIBRATION_SAMPLES;
  gyroBaseZ = (float)sumGz / MPU_CALIBRATION_SAMPLES;

  filtAx = accelBaseX;
  filtAy = accelBaseY;
  filtAz = accelBaseZ;
  filtGx = 0.0;
  filtGy = 0.0;
  filtGz = 0.0;
  prevFiltAx = filtAx;
  prevFiltAy = filtAy;
  prevFiltAz = filtAz;
}

void setup() {
  Serial.begin(115200);
  Wire.begin();

  // LSM303 compass
  compass.init();
  compass.enableDefault();
  compass.m_min = (LSM303::vector<int16_t>){COMPASS_MIN_X, COMPASS_MIN_Y, COMPASS_MIN_Z};
  compass.m_max = (LSM303::vector<int16_t>){COMPASS_MAX_X, COMPASS_MAX_Y, COMPASS_MAX_Z};

  // BMP280
  if (!bmp.begin(0x76)) {
    while (1) delay(10); // halt silently if BMP missing
  }
  bmp.setSampling(Adafruit_BMP280::MODE_NORMAL,
                  Adafruit_BMP280::SAMPLING_X2,
                  Adafruit_BMP280::SAMPLING_X16,
                  Adafruit_BMP280::FILTER_X16,
                  Adafruit_BMP280::STANDBY_MS_500);

  // MPU6050
  mpu.reset();
  delay(100);
  mpu.initialize();
  if (!mpu.testConnection()) {
    while (true) delay(10);
  }
  mpu.setXAccelOffset(0);
  mpu.setYAccelOffset(0);
  mpu.setZAccelOffset(0);
  mpu.setXGyroOffset(0);
  mpu.setYGyroOffset(0);
  mpu.setZGyroOffset(0);
  mpu.setFullScaleAccelRange(MPU6050_ACCEL_FS_2);
  mpu.setFullScaleGyroRange(MPU6050_GYRO_FS_250);
  mpu.setDLPFMode(MPU6050_DLPF_BW_20);
  mpu.setRate(9); // 100 Hz internal sample rate after DLPF.
  calibrateMpu6050();

  pinMode(LED_BUILTIN, OUTPUT);
}

void loop() {
  compass.read();
  float rawHeading = compass.heading();
  float heading = rawHeading + COMPASS_HEADING_OFFSET_DEG;
  heading = normalizeHeading(heading);
  if (!headingReady) {
    filtHeading = heading;
    headingReady = true;
  } else {
    filtHeading = smoothHeading(filtHeading, heading, HEADING_FILTER_ALPHA);
  }

  mpu.getMotion6(&ax, &ay, &az, &gx, &gy, &gz);
  float correctedGx = applyDeadband((float)gx - gyroBaseX, GYRO_DEADBAND);
  float correctedGy = applyDeadband((float)gy - gyroBaseY, GYRO_DEADBAND);
  float correctedGz = applyDeadband((float)gz - gyroBaseZ, GYRO_DEADBAND);

  prevFiltAx = filtAx;
  prevFiltAy = filtAy;
  prevFiltAz = filtAz;

  filtAx += ACCEL_FILTER_ALPHA * ((float)ax - filtAx);
  filtAy += ACCEL_FILTER_ALPHA * ((float)ay - filtAy);
  filtAz += ACCEL_FILTER_ALPHA * ((float)az - filtAz);
  filtGx += GYRO_FILTER_ALPHA * (correctedGx - filtGx);
  filtGy += GYRO_FILTER_ALPHA * (correctedGy - filtGy);
  filtGz += GYRO_FILTER_ALPHA * (correctedGz - filtGz);

  float accelMag = sqrt(filtAx * filtAx + filtAy * filtAy + filtAz * filtAz);
  float accelDeltaMag = abs(accelMag - accelBaseMag);
  float accelMotionX = filtAx - accelBaseX;
  float accelMotionY = filtAy - accelBaseY;
  float accelMotionZ = filtAz - accelBaseZ;
  float accelJerk = sqrt(
    (filtAx - prevFiltAx) * (filtAx - prevFiltAx) +
    (filtAy - prevFiltAy) * (filtAy - prevFiltAy) +
    (filtAz - prevFiltAz) * (filtAz - prevFiltAz)
  );
  float gyroMag = sqrt(filtGx * filtGx + filtGy * filtGy + filtGz * filtGz);
  bool turnSample = gyroMag > GYRO_TURN;
  bool motionSample = accelDeltaMag > ACCEL_MAG_MOVE ||
                      (accelJerk > ACCEL_JERK_MOVE &&
                       accelDeltaMag > ACCEL_JERK_MIN_MAG);

  if (motionSample) {
    if (motionCount < MOTION_START_SAMPLES) motionCount++;
    stillCount = 0;
  } else {
    motionCount = 0;
    if (stillCount < STILL_REQUIRED_SAMPLES) stillCount++;
  }

  if (motionCount >= MOTION_START_SAMPLES) {
    isMoving = true;
  } else if (stillCount >= STILL_REQUIRED_SAMPLES) {
    isMoving = false;
  }

  float temp = bmp.readTemperature();
  float pressure = bmp.readPressure() / 100.0; // hPa
  float altitude = bmp.readAltitude(SEA_LEVEL_PRESSURE_HPA);
  float ppm = mq135_sensor.getCorrectedPPM(temperature, humidity);

  Serial.print("HDG:"); Serial.print(filtHeading, 1);
  Serial.print(",HRW:"); Serial.print(rawHeading, 1);
  Serial.print(",TEMP:"); Serial.print(temp, 1);
  Serial.print(",PRES:"); Serial.print(pressure, 1);
  Serial.print(",ALT:"); Serial.print(altitude, 1);
  Serial.print(",PPM:"); Serial.print(ppm, 0);
  Serial.print(",AX:"); Serial.print((int)round(accelMotionX));
  Serial.print(",AY:"); Serial.print((int)round(accelMotionY));
  Serial.print(",AZ:"); Serial.print((int)round(accelMotionZ));
  Serial.print(",GX:"); Serial.print((int)round(filtGx));
  Serial.print(",GY:"); Serial.print((int)round(filtGy));
  Serial.print(",GZ:"); Serial.print((int)round(filtGz));
  Serial.print(",AMG:"); Serial.print((int)round(accelDeltaMag));
  Serial.print(",JRK:"); Serial.print((int)round(accelJerk));
  Serial.print(",GMG:"); Serial.print((int)round(gyroMag));
  Serial.print(",MOV:"); Serial.print(isMoving ? 1 : 0);
  Serial.print(",TURN:"); Serial.println(turnSample ? 1 : 0);

  delay(300);
}
