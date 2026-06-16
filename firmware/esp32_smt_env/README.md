# ESP32 + SHT45 온·습도 센서

MES Prod Viewer의 `/api/env/ingest` 로 온·습도를 전송합니다.

## 전원 (USB-C 5V 충전기)

```
[5V USB-C 충전기] ──USB-C 케이블──► [ESP32 보드 USB-C]
                                      │
                               보드 내 5V→3.3V 레귤레이터
                                      │
                    3.3V 핀 ──────────┴──► SHT45 VCC (빨강)
                    GND  핀 ─────────────► SHT45 GND (검정)
```

- **5V / 1A 이상** 충전기면 충분합니다 (ESP32+Wi-Fi + SHT45 합쳐도 수백 mA 수준).
- ESP32는 USB **5V(VBUS)** 를 받아 보드 레귤레이터가 **3.3V** 로 공급합니다.
- **SHT45는 반드시 ESP32 `3.3V` 핀**에 연결하세요 (5V 핀·VIN에 직결 금지, 센서 최대 3.6V).
- **데이터 기능 없는 충전 전용 케이블**도 전원만 쓸 때는 대부분 가능합니다. 전원이 안 들어오면 다른 케이블을 시도하세요.
- SMT 현장: 충전기·ESP32·센서 **GND는 한 공통 접지**로 묶입니다.

## 배선도 (ESP32 ↔ SHT45)

```
                    ┌─────────────────────────────┐
   5V USB-C         │         ESP32 Dev           │
  충전기 ──────────►│  [USB-C]                    │
                    │                             │
                    │  3.3V ────────┬── 빨강 VCC   │
                    │               │              │
                    │  GND  ────────┼── 검정 GND   │
                    │               │              │
                    │  GPIO22 ──────┼── 노랑 SCL   │
                    │               │              │
                    │  GPIO21 ──────┼── 초록 SDA   │
                    └───────────────┼──────────────┘
                                    │
                           1m 케이블 (I2C)
                                    │
                    ┌───────────────┴──────────────┐
                    │   SHT45 온·습도 센서 (I2C)    │
                    │   주소 0x44                   │
                    └──────────────────────────────┘
```

| 센서 선색 | 신호 | ESP32 |
|-----------|------|--------|
| 빨강 | VCC | **3.3V** |
| 검정 | GND | **GND** |
| 노랑 | SCL | **GPIO 22** |
| 초록 | SDA | **GPIO 21** |

- I2C 풀업: ESP32·SHT45 보드에 보통 내장. 케이블이 길거나 불안정하면 SCL/SDA에 **4.7kΩ → 3.3V** 추가 검토.
- 펌웨어 기본 핀: SDA=21, SCL=22 (`esp32_smt_env.ino`).

## 하드웨어

| 센서 선 | ESP32 |
|---------|--------|
| 빨강 (VCC) | **3.3V** |
| 검정 (GND) | **GND** |
| 노랑 (SCL) | **GPIO 22** |
| 초록 (SDA) | **GPIO 21** |

- 센서: **SHT45** (I2C)
- I2C 주소: 0x44 (기본)

## Arduino IDE 설정

1. 보드: **ESP32 Dev Module**
2. 라이브러리: **Adafruit SHT4x**, **Adafruit BusIO**, **Adafruit Unified Sensor**
3. `esp32_smt_env.ino` 에서 Wi-Fi, `SERVER_BASE`, `DEVICE_KEY`, `OTA_PASSWORD` 수정
4. USB 업로드 후 시리얼 115200: `[SHT45] OK`, `[HTTP] POST 200`, `[OTA] ready` 확인

## 네트워크 자동 복구

| 상황 | 동작 |
|------|------|
| Wi-Fi 끊김 | 이벤트 감지 → **지수 백오프**(5s~120s)로 재접속 |
| 접속 25초 타임아웃 | 실패 카운트 증가, 백오프 확대 |
| **15분** 연속 무연결 | `esp_restart()` |
| Wi-Fi 연속 **24회** 접속 실패 | `esp_restart()` |
| HTTP POST **8회** 연속 실패 | Wi-Fi disconnect 후 재협상 |

`WiFi.setAutoReconnect(true)`, `WiFi.setSleep(false)` 로 현장 안정성을 높였습니다.

## OTA (무선 펌웨어 업데이트)

**Arduino IDE 네트워크 포트** 방식 (`ArduinoOTA`, ESP32 보드 패키지 기본 포함).

1. 장치와 PC가 **같은 Wi-Fi**에 있어야 합니다.
2. 펌웨어의 `OTA_HOSTNAME`(기본 `smt-sht-01`), `OTA_PASSWORD` 설정.
3. 최초 **USB 업로드** 1회 후, Arduino IDE **도구 → 포트** 에 `smt-sht-01 at …` 네트워크 포트가 나타납니다.
4. 해당 포트 선택 후 **업로드** → USB 없이 갱신.

OTA 중에도 `ArduinoOTA.handle()` 이 `loop()` 에서 호출됩니다.

> **참고:** MES 뷰어 서버 경유 HTTP OTA는 현재 미구현입니다. 필요 시 `ENV_INGEST_KEY` 로 보호된 `/firmware.bin` URL 방식을 별도 검토할 수 있습니다.

## 서버 (.env)

```
ENV_INGEST_KEY=change-me-env-key
ENV_DEVICE_ID=SMT_SHT-01
```

뷰어 PC `npm start` → 브라우저 **SMT** 탭 하단 차트 확인.
