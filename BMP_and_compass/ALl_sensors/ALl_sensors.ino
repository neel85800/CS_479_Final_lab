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

  pinMode(LED_BUILTIN, OUTPUT);
}

void loop() {
  compass.read();
  // LSM303 is mounted reversed on the rig — rotate heading 180°.
  float heading = compass.heading() + 180.0;
  if (heading >= 360.0) heading -= 360.0;

  mpu.getMotion6(&ax, &ay, &az, &gx, &gy, &gz);

  float temp = bmp.readTemperature();
  float pressure = bmp.readPressure() / 100.0; // hPa
  float altitude = bmp.readAltitude(1013.25);
  float ppm = mq135_sensor.getCorrectedPPM(temperature, humidity);

  Serial.print("HDG:"); Serial.print(heading, 1);
  Serial.print(",TEMP:"); Serial.print(temp, 1);
  Serial.print(",PRES:"); Serial.print(pressure, 1);
  Serial.print(",ALT:"); Serial.print(altitude, 1);
  Serial.print(",PPM:"); Serial.print(ppm, 0);
  Serial.print(",AX:"); Serial.print(ax);
  Serial.print(",AY:"); Serial.print(ay);
  Serial.print(",AZ:"); Serial.print(az);
  Serial.print(",GX:"); Serial.print(gx);
  Serial.print(",GY:"); Serial.print(gy);
  Serial.print(",GZ:"); Serial.println(gz);

  delay(300);
}
