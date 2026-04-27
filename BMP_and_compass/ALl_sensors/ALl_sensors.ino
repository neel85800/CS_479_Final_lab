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

float temperature = 21.0; // Assume current temperature. Recommended to measure with DHT22
float humidity = 25.0; // Assume current humidity. Recommended to measure with DHT22
int16_t ax, ay, az;
int16_t gx, gy, gz;
bool blinkState;

const int MPU_CALIBRATION_SAMPLES = 250;
const float IMU_FILTER_ALPHA = 0.18;        // Lower = smoother, higher = more responsive.
const float GYRO_DEADBAND = 85.0;           // Raw MPU6050 units; ignores table jitter.
const float ACCEL_DELTA_MOVE = 2200.0;      // Raw accel vector change from resting baseline.
const float GYRO_MOVE = 950.0;              // Raw gyro vector magnitude after bias removal.
const byte MOTION_REQUIRED_SAMPLES = 3;     // Motion must persist before MOV becomes 1.

float accelBaseX = 0.0, accelBaseY = 0.0, accelBaseZ = 0.0;
float gyroBaseX = 0.0, gyroBaseY = 0.0, gyroBaseZ = 0.0;
float filtAx = 0.0, filtAy = 0.0, filtAz = 0.0;
float filtGx = 0.0, filtGy = 0.0, filtGz = 0.0;
byte motionCount = 0;
bool isMoving = false;

float applyDeadband(float value, float deadband) {
  return abs(value) < deadband ? 0.0 : value;
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
  gyroBaseX = (float)sumGx / MPU_CALIBRATION_SAMPLES;
  gyroBaseY = (float)sumGy / MPU_CALIBRATION_SAMPLES;
  gyroBaseZ = (float)sumGz / MPU_CALIBRATION_SAMPLES;

  filtAx = accelBaseX;
  filtAy = accelBaseY;
  filtAz = accelBaseZ;
  filtGx = 0.0;
  filtGy = 0.0;
  filtGz = 0.0;
}

void setup() {
  Serial.begin(115200);
  Wire.begin();

  // LSM303 compass
  compass.init();
  compass.enableDefault();
  compass.m_min = (LSM303::vector<int16_t>){-32767, -32767, -32767};
  compass.m_max = (LSM303::vector<int16_t>){+32767, +32767, +32767};

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
  calibrateMpu6050();

  pinMode(LED_BUILTIN, OUTPUT);
}

void loop() {
  compass.read();
  // LSM303 is mounted reversed on the rig — rotate heading 180°.
  float heading = compass.heading() + 180.0;
  if (heading >= 360.0) heading -= 360.0;

  mpu.getMotion6(&ax, &ay, &az, &gx, &gy, &gz);
  float correctedGx = applyDeadband((float)gx - gyroBaseX, GYRO_DEADBAND);
  float correctedGy = applyDeadband((float)gy - gyroBaseY, GYRO_DEADBAND);
  float correctedGz = applyDeadband((float)gz - gyroBaseZ, GYRO_DEADBAND);

  filtAx += IMU_FILTER_ALPHA * ((float)ax - filtAx);
  filtAy += IMU_FILTER_ALPHA * ((float)ay - filtAy);
  filtAz += IMU_FILTER_ALPHA * ((float)az - filtAz);
  filtGx += IMU_FILTER_ALPHA * (correctedGx - filtGx);
  filtGy += IMU_FILTER_ALPHA * (correctedGy - filtGy);
  filtGz += IMU_FILTER_ALPHA * (correctedGz - filtGz);

  float accelDeltaX = filtAx - accelBaseX;
  float accelDeltaY = filtAy - accelBaseY;
  float accelDeltaZ = filtAz - accelBaseZ;
  float accelDeltaMag = sqrt(
    accelDeltaX * accelDeltaX +
    accelDeltaY * accelDeltaY +
    accelDeltaZ * accelDeltaZ
  );
  float gyroMag = sqrt(filtGx * filtGx + filtGy * filtGy + filtGz * filtGz);
  bool motionSample = accelDeltaMag > ACCEL_DELTA_MOVE || gyroMag > GYRO_MOVE;

  if (motionSample) {
    if (motionCount < MOTION_REQUIRED_SAMPLES) motionCount++;
  } else {
    motionCount = 0;
  }
  isMoving = motionCount >= MOTION_REQUIRED_SAMPLES;

  float temp = bmp.readTemperature();
  float pressure = bmp.readPressure() / 100.0; // hPa
  float altitude = bmp.readAltitude(1013.25);
  float ppm = mq135_sensor.getCorrectedPPM(temperature, humidity);

  Serial.print("HDG:"); Serial.print(heading, 1);
  Serial.print(",TEMP:"); Serial.print(temp, 1);
  Serial.print(",PRES:"); Serial.print(pressure, 1);
  Serial.print(",ALT:"); Serial.print(altitude, 1);
  Serial.print(",PPM:"); Serial.print(ppm, 0);
  Serial.print(",AX:"); Serial.print((int)round(filtAx));
  Serial.print(",AY:"); Serial.print((int)round(filtAy));
  Serial.print(",AZ:"); Serial.print((int)round(filtAz));
  Serial.print(",GX:"); Serial.print((int)round(filtGx));
  Serial.print(",GY:"); Serial.print((int)round(filtGy));
  Serial.print(",GZ:"); Serial.print((int)round(filtGz));
  Serial.print(",MOV:"); Serial.println(isMoving ? 1 : 0);

  delay(300);
}
