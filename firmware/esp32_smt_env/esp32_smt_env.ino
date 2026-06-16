/*
 * SMT 생산실 온·습도 — ESP32 + Sensirion SHT45 (I2C)
 * → MES Prod Viewer POST /api/env/ingest
 *
 * 배선: 빨강 3.3V | 검정 GND | 노랑 SCL→22 | 초록 SDA→21
 *
 * 라이브러리: Adafruit SHT4x, Adafruit Unified Sensor, Adafruit BusIO
 * (ArduinoOTA 는 ESP32 보드 패키지에 포함)
 */

#include <WiFi.h>
#include <HTTPClient.h>
#include <Wire.h>
#include <ArduinoOTA.h>
#include <Adafruit_SHT4x.h>

// ---------- Wi-Fi / 서버 (현장에 맞게 수정) ----------
const char* WIFI_SSID = "YOUR_WIFI_SSID";
const char* WIFI_PASS = "YOUR_WIFI_PASSWORD";

const char* SERVER_BASE = "http://192.168.0.10:3000";
const char* INGEST_PATH = "/api/env/ingest";
const char* DEVICE_KEY = "change-me-env-key";
const char* DEVICE_ID = "SMT_SHT-01";

// OTA (Arduino IDE → 네트워크 포트 업로드). 비우면 비밀번호 없음(비권장)
const char* OTA_HOSTNAME = "smt-sht-01";
const char* OTA_PASSWORD = "change-me-ota";

const int I2C_SDA = 21;
const int I2C_SCL = 22;

const unsigned long SAMPLE_MS = 2000;
const unsigned long POST_MS = 15000;

// ---------- 네트워크 복구 정책 ----------
const unsigned long WIFI_CONNECT_TIMEOUT_MS = 25000;
const unsigned long WIFI_BACKOFF_START_MS = 5000;
const unsigned long WIFI_BACKOFF_MAX_MS = 120000;
const unsigned long WIFI_NO_IP_RESET_MS = 15UL * 60UL * 1000UL;  // 15분 무연결 → esp_restart
const int WIFI_FAIL_STREAK_RESTART = 24;                          // 연속 N회 접속 실패 → 리셋
const int HTTP_FAIL_STREAK_WIFI_RESET = 8;                        // POST 연속 실패 → Wi-Fi 재협상

const int I2C_SDA_PIN = I2C_SDA;
const int I2C_SCL_PIN = I2C_SCL;

Adafruit_SHT4x sht4;
bool sensorOk = false;
bool otaStarted = false;

unsigned long lastSampleMs = 0;
unsigned long lastPostMs = 0;
unsigned long lastWifiConnectedMs = 0;
unsigned long lastWifiAttemptMs = 0;
unsigned long wifiBackoffMs = WIFI_BACKOFF_START_MS;

float lastTempC = 0.0f;
float lastHumPct = 0.0f;

int wifiConnectFailStreak = 0;
int httpPostFailStreak = 0;

enum WifiState { WIFI_STATE_DOWN, WIFI_STATE_CONNECTING, WIFI_STATE_UP };
WifiState wifiState = WIFI_STATE_DOWN;

// ---------- Wi-Fi 이벤트 ----------
void onWiFiEvent(WiFiEvent_t event, WiFiEventInfo_t info) {
  switch (event) {
    case ARDUINO_EVENT_WIFI_STA_GOT_IP:
      Serial.print("[WiFi] IP: ");
      Serial.println(WiFi.localIP());
      wifiState = WIFI_STATE_UP;
      lastWifiConnectedMs = millis();
      wifiConnectFailStreak = 0;
      httpPostFailStreak = 0;
      wifiBackoffMs = WIFI_BACKOFF_START_MS;
      break;

    case ARDUINO_EVENT_WIFI_STA_DISCONNECTED:
      wifiState = WIFI_STATE_DOWN;
      otaStarted = false;
      Serial.printf("[WiFi] disconnected reason=%d\n",
                    info.wifi_sta_disconnected.reason);
      break;

    default:
      break;
  }
}

void setupArduinoOta() {
  if (otaStarted || WiFi.status() != WL_CONNECTED) return;

  ArduinoOTA.setHostname(OTA_HOSTNAME);
  if (OTA_PASSWORD[0] != '\0') {
    ArduinoOTA.setPassword(OTA_PASSWORD);
  }

  ArduinoOTA.onStart([]() {
    Serial.println("[OTA] start");
  });
  ArduinoOTA.onEnd([]() {
    Serial.println("[OTA] end");
  });
  ArduinoOTA.onError([](ota_error_t err) {
    Serial.printf("[OTA] error %u\n", err);
  });

  if (ArduinoOTA.begin()) {
    otaStarted = true;
    Serial.printf("[OTA] ready hostname=%s\n", OTA_HOSTNAME);
  } else {
    Serial.println("[OTA] begin failed");
  }
}

void startWifiConnect() {
  if (wifiState == WIFI_STATE_CONNECTING) return;

  Serial.printf("[WiFi] connect attempt (backoff %lu ms, streak %d)\n",
                wifiBackoffMs, wifiConnectFailStreak);

  WiFi.disconnect(true, false);
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASS);

  wifiState = WIFI_STATE_CONNECTING;
  lastWifiAttemptMs = millis();
}

bool blockingFirstConnect() {
  startWifiConnect();
  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < WIFI_CONNECT_TIMEOUT_MS) {
    delay(200);
    ArduinoOTA.handle();
  }
  if (WiFi.status() == WL_CONNECTED) {
    wifiState = WIFI_STATE_UP;
    lastWifiConnectedMs = millis();
    setupArduinoOta();
    return true;
  }
  wifiState = WIFI_STATE_DOWN;
  wifiConnectFailStreak++;
  return false;
}

void forceWifiReconnect(const char* reason) {
  Serial.printf("[WiFi] force reconnect: %s\n", reason);
  httpPostFailStreak = 0;
  otaStarted = false;
  WiFi.disconnect(true, false);
  wifiState = WIFI_STATE_DOWN;
  lastWifiAttemptMs = millis() - wifiBackoffMs;
}

void checkWifiHardReset() {
  if (wifiState == WIFI_STATE_UP) return;

  unsigned long downMs =
      lastWifiConnectedMs > 0 ? millis() - lastWifiConnectedMs : millis();

  if (downMs >= WIFI_NO_IP_RESET_MS) {
    Serial.printf("[WiFi] no IP for %lu ms → esp_restart\n", downMs);
    delay(100);
    esp_restart();
  }

  if (wifiConnectFailStreak >= WIFI_FAIL_STREAK_RESTART) {
    Serial.println("[WiFi] fail streak → esp_restart");
    delay(100);
    esp_restart();
  }
}

void serviceWifi() {
  if (WiFi.status() == WL_CONNECTED) {
    if (wifiState != WIFI_STATE_UP) {
      wifiState = WIFI_STATE_UP;
      lastWifiConnectedMs = millis();
    }
    setupArduinoOta();
    return;
  }

  if (wifiState == WIFI_STATE_UP) {
    wifiState = WIFI_STATE_DOWN;
    otaStarted = false;
    Serial.println("[WiFi] link lost");
  }

  checkWifiHardReset();

  unsigned long now = millis();

  if (wifiState == WIFI_STATE_CONNECTING) {
    if (now - lastWifiAttemptMs >= WIFI_CONNECT_TIMEOUT_MS) {
      wifiConnectFailStreak++;
      wifiState = WIFI_STATE_DOWN;
      wifiBackoffMs = min(wifiBackoffMs * 2, WIFI_BACKOFF_MAX_MS);
      Serial.println("[WiFi] connect timeout");
    }
    return;
  }

  if (now - lastWifiAttemptMs >= wifiBackoffMs) {
    startWifiConnect();
  }
}

// ---------- SHT45 ----------
bool initSensor() {
  Wire.begin(I2C_SDA_PIN, I2C_SCL_PIN);
  Wire.setClock(100000);

  if (!sht4.begin()) {
    Serial.println("[SHT45] not found (wiring / 3.3V)");
    return false;
  }

  sht4.setPrecision(SHT4X_HIGH_PRECISION);
  sht4.setHeater(SHT4X_NO_HEATER);
  Serial.println("[SHT45] OK");
  return true;
}

bool sampleSensors() {
  if (!sensorOk) {
    sensorOk = initSensor();
    if (!sensorOk) return false;
  }

  sensors_event_t humEvent, tempEvent;
  sht4.getEvent(&humEvent, &tempEvent);

  if (isnan(tempEvent.temperature) || isnan(humEvent.relative_humidity)) {
    Serial.println("[SHT45] NaN");
    sensorOk = false;
    return false;
  }

  lastTempC = tempEvent.temperature;
  lastHumPct = humEvent.relative_humidity;
  if (lastHumPct < 0.0f) lastHumPct = 0.0f;
  if (lastHumPct > 100.0f) lastHumPct = 100.0f;

  Serial.printf("[SHT45] T=%.2f C RH=%.2f %%\n", lastTempC, lastHumPct);
  return true;
}

bool postReading() {
  if (WiFi.status() != WL_CONNECTED) return false;

  String url = String(SERVER_BASE) + String(INGEST_PATH);
  HTTPClient http;
  http.setTimeout(8000);
  http.setReuse(false);

  if (!http.begin(url)) {
    Serial.println("[HTTP] begin failed");
    return false;
  }

  http.addHeader("Content-Type", "application/json");
  http.addHeader("Connection", "close");
  http.addHeader("X-Device-Key", DEVICE_KEY);

  String body = "{";
  body += "\"deviceId\":\"" + String(DEVICE_ID) + "\",";
  body += "\"tempC\":" + String(lastTempC, 2) + ",";
  body += "\"humidityPct\":" + String(lastHumPct, 2);
  body += "}";

  int code = http.POST(body);
  http.end();

  Serial.printf("[HTTP] POST %d\n", code);
  return code >= 200 && code < 300;
}

void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.println("\nSMT env — ESP32 + SHT45");

  WiFi.onEvent(onWiFiEvent);

  sensorOk = initSensor();
  blockingFirstConnect();

  if (sensorOk) sampleSensors();
  lastSampleMs = millis();
  lastPostMs = millis();
}

void loop() {
  ArduinoOTA.handle();
  serviceWifi();

  unsigned long now = millis();

  if (now - lastSampleMs >= SAMPLE_MS) {
    lastSampleMs = now;
    sampleSensors();
  }

  if (now - lastPostMs >= POST_MS) {
    lastPostMs = now;

    if (!sensorOk) {
      return;
    }

    if (WiFi.status() != WL_CONNECTED) {
      return;
    }

    if (postReading()) {
      httpPostFailStreak = 0;
    } else {
      httpPostFailStreak++;
      lastPostMs = now - POST_MS + 5000;
      if (httpPostFailStreak >= HTTP_FAIL_STREAK_WIFI_RESET) {
        forceWifiReconnect("HTTP post fail streak");
      }
    }
  }
}
