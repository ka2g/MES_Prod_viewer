# MES 생산라인 모니터링 시스템 (MES Prod Viewer)

KH_MES(SQL Server)의 생산 계획·실적 데이터를 읽어 **SMT / ASSY** 라인별 현황을 웹 대시보드로 보여 주는 Node.js 서버입니다. 브라우저는 **Server-Sent Events(SSE)** 로 일정 주기마다 갱신됩니다.

**저장소:** [https://github.com/ka2g/MES_Prod_viewer](https://github.com/ka2g/MES_Prod_viewer)

---

## 주요 기능

- **공정 구분**: 상단 탭으로 `SMT` / `ASSY` 전환 (각각 조회 대상 라인 집합이 다름).
- **라인 카드**: 계획수량, 생산수량, 경과 시간, 모델·작업면(탑/봇 추정), `prod_lot`(로트·작업지시 표시 영역) 등.
- **실시간 연동**: `MES_REFRESH_MS`(기본 8000ms, 최소 2000ms) 간격으로 DB를 다시 읽어 SSE로 푸시.
- **작업지시(`prod_lot`) 기준 누적 생산수량**: 동일 라인에서 같은 `prod_lot`인 여러 계획 행(주간·야간·익일 인계 등)이 있으면, **대표 행 선정 규칙은 그대로** 두고 **생산수량은 해당 지시에 속한 행들의 합**으로 표시. **시작시각**은 그 그룹의 **`MIN(start_time)`**, **경과(분)** 도 그 시각 기준.
- **`prod_lot`이 비어 있는 경우**: 합산 없이 **현재와 동일하게** 대표 1행의 수량·시작시각만 사용 (샘플·일부 ASSY 등).
- **라인 가동 상태 추정** (`lineActivity.js`): 생산수량 변동 시각을 기준으로 `running` / `idle` / `stopped` 표시 (로컬 `line-activity-state.json`에 상태 보존, `.gitignore` 처리).
- **SMT 현장 온·습도** (SMT 탭 하단, ASSY에서는 숨김):
  - **ESP32 + SHT45(I2C)** 가 POST로 전송 → 서버가 **보정값 적용 후** 저장·표시
  - 실시간 카드: 온도·습도 수치 + **이전 대비 증감(▲/▼)**
  - **오늘 차트**: X축 00:00~24:00(30분 라벨), **10분** 버킷, 10분마다 세로 눈금
  - **한계선**: 온도 22/28℃, 습도 40/60% (점선)
  - **월간 차트**: CSV 기준 **일별 평균**, ◀/▶ 및 드롭다운으로 **과거 월** 조회
  - 상단 **설정** 버튼: PIN 입력 후 **온·습도 보정**(0.1 단위) — **클릭할 때마다** PIN 필요

---

## 시스템 요구 사항

- **Node.js** 18 이상  
- **Microsoft SQL Server** (레거시 버전 호환을 위해 `TRY_CONVERT` 미사용, `ISNUMERIC` + `CAST` 패턴 사용)
- MES DB에 **`dbo.TB_MES_PROD_PLAN`**, **`dbo.TB_MES_MODEL_MASTER`**(조인) 접근 권한

---

## 설치

```bash
git clone https://github.com/ka2g/MES_Prod_viewer.git
cd MES_Prod_viewer
npm install
```

---

## 환경 변수

프로젝트 루트에 `.env` 파일을 두거나, 실행 파일과 같은 폴더에 둡니다 (`pkg` 빌드 시).

사본: [`.env.example`](./.env.example)

| 변수 | 설명 |
|------|------|
| `MSSQL_SERVER` | SQL Server 주소 |
| `MSSQL_DATABASE` | 데이터베이스명 (예: KH_MES) |
| `MSSQL_USER` / `MSSQL_PASSWORD` | 로그인 |
| `MSSQL_ENCRYPT` | TLS 사용 여부 (구 버전 연동 시 `false`가 필요한 경우 있음) |
| `MSSQL_TRUST_SERVER_CERTIFICATE` | 자체 서명 등 (`true`/`false`) |
| `HOST` | 바인드 주소 (예: `0.0.0.0` — LAN 다른 PC에서 접속) |
| `PORT` | HTTP 포트 (기본 `3000`) |
| `MES_REFRESH_MS` | DB 폴링·SSE 주기(ms), 최소 2000 |
| `MES_PLAN_LOOKBACK_DAYS` | `plan_date` 조회 깊이(일), 기본 14 |
| `MES_ASSY_PLAN_LOOKBACK_DAYS` | ASSY 전용 lookback(일). 비우면 공통값과 7일 중 더 작은 값 |
| `ENV_INGEST_KEY` | ESP32 `X-Device-Key` (비우면 검증 생략) |
| `ENV_DEVICE_ID` | 장치 ID (기본 `SMT_SHT-01`, 펌웨어와 동일해야 함) |
| `ENV_REFRESH_MS` | 온습도 SSE 주기(ms), 기본 15000 |
| `ENV_HISTORY_HOURS` | 레거시 history API용 시간(시), 기본 24 |
| `ENV_HISTORY_BUCKET_MIN` | 오늘 차트 버킷(분), 기본 **10** |
| `ENV_RETENTION_DAYS` | raw·CSV 보관 일수, 기본 90 |
| `ENV_SETTINGS_PIN` | 설정 메뉴 PIN (기본 `smt1234`) |

---

## 실행

```bash
npm start
```

개발 시 파일 변경 감지:

```bash
npm run dev
```

브라우저: `http://localhost:3000`  
다른 PC: `http://(서버 IPv4):3000`

---

## Windows 실행 파일 빌드 (선택)

```bash
npm run build:exe
```

`dist/mes-prod-viewer.exe` 가 생성됩니다. `.env`는 exe와 **같은 폴더**에 두면 됩니다.

### pkg 배포 시 주의

- `public/`·`images/` 는 **exe 안에 번들**됩니다. exe 옆 `public` 폴더만 덮어써도 **반영되지 않을 수 있음** → UI·서버 변경 후 **`npm run build:exe` 재빌드** 권장.
- `data/env/`(JSONL, CSV, 보정값)는 exe **옆**에 생성·유지됩니다.
- 빌드 워닝(`xdg-open`, `open`/`import.meta` bytecode 등)은 mssql 의존성에서 흔하며, **Windows exe 동작과는 무관**한 경우가 많습니다.

상세: [`mes-prod-viewer.exe.spec.json`](./mes-prod-viewer.exe.spec.json)

---

## HTTP API

| 메서드 | 경로 | 설명 |
|--------|------|------|
| GET | `/api/health` | 서비스 헬스 |
| GET | `/api/lines?phase=smt` 또는 `phase=assy` | JSON 스냅샷 |
| GET | `/api/lines/stream?phase=...` | MES SSE 스트림 |
| POST | `/api/env/ingest` | ESP32 온·습도 수신 (`X-Device-Key`) |
| GET | `/api/env/snapshot` | 최신값 + 오늘 10분 버킷 history |
| GET | `/api/env/stream` | 온습도 SSE |
| GET | `/api/env/month?year=&month=` | 월간 일별 평균 (CSV 우선) |
| GET | `/api/env/months` | 조회 가능 월 목록 |
| GET | `/api/env/calibration` | 현재 보정값 |
| PUT | `/api/env/calibration` | 보정 저장 (헤더 `X-Settings-Pin`) |

---

## SMT 현장 온·습도 (ESP32 + SHT45)

### 배선 (I2C)

| 센서 선 | ESP32 |
|---------|--------|
| 빨강 VCC | 3.3V |
| 검정 GND | GND |
| 노랑 SCL | GPIO 22 |
| 초록 SDA | GPIO 21 |

센서가 **디지털 I2C** 로 온·습도를 제공합니다. 4–20mA 변환기(HW-685)는 사용하지 않습니다.

### 펌웨어

[`firmware/esp32_smt_env/`](./firmware/esp32_smt_env/) — Arduino IDE에서 **Adafruit SHT4x**, **Adafruit BusIO** 설치 후 업로드.  
Wi-Fi **자동 재연결·장시간 무연결 시 리셋**, **ArduinoOTA** 무선 업데이트 포함.  
상세: [`firmware/esp32_smt_env/README.md`](./firmware/esp32_smt_env/README.md)

### 저장 (서버)

| 경로 | 내용 |
|------|------|
| `data/env/readings-YYYY-MM-DD.jsonl` | 일별 raw 로그 |
| `data/env/csv/env-YYYY-MM.csv` | 월별 CSV (`recorded_at,device_id,temp_c,humidity_pct`) |
| `data/env/calibration.json` | 온·습도 보정값 (`tempOffset`, `humidityOffset`) |

ingest 시 **보정값을 더한 값**이 JSONL·CSV·화면에 기록됩니다. 보정 변경 **이전** 데이터는 소급 수정되지 않습니다.

### 설정 메뉴 (보정)

1. 상단 **실시간 연동** 옆 **설정** 클릭  
2. PIN 입력 (기본 `smt1234`, `.env`의 `ENV_SETTINGS_PIN`)  
3. 온도·습도 보정을 0.1 단위로 조정 후 **적용**

---

## 프로젝트 구조 (요약)

| 파일 | 역할 |
|------|------|
| `server.js` | Express, 정적 파일, API, SSE 루프, ingest 보정 |
| `mesRepository.js` | MSSQL 연결, `TB_MES_PROD_PLAN` 조회, 라인별 대표 행 + `prod_lot` 합산 |
| `lineActivity.js` | 라인별 생산수량 변동 기반 가동 상태 |
| `envStore.js` | JSONL·CSV 저장, 차트용 집계, 보정값, 월 목록 |
| `firmware/esp32_smt_env/` | ESP32 Arduino 스케치 |
| `public/` | `index.html`, `app.js`, `env.js`, `styles.css` |

---

## 데이터·표시 규칙 (요약)

1. **대표 행**: 라인(또는 `process`)당 `ROW_NUMBER() = 1`. 정렬은 당일 `plan_date` 우선, 그다음 `plan_date`·`start_time`·`create_date`·`update_date` 순.
2. **`prod_lot`이 있는 경우**: 같은 라인·같은 `prod_lot`·같은 lookback/ASSY 활성 필터 범위의 행 `prod_qty` 합계, `start_time`은 그 묶음의 최소값.
3. **ASSY**: 설정에 따라 `activated = 'Y'` 행만 조회(본 시스템 정의와 동일하게 합산 서브쿼리에도 적용).

MES 실적 화면과 컬럼 매핑이 다르면 `mesRepository.js`의 조인·집계 키를 환경/스키마에 맞게 조정해야 합니다.

---

## 트러블슈팅 (온·습도)

| 증상 | 확인 |
|------|------|
| 「연결 중…」에서 멈춤 | 브라우저 F12 Console — `env.js` 구문 오류 여부. exe 사용 시 **재빌드** 후 교체 |
| 수치 `—`, 「센서 데이터 없음」 | `ENV_DEVICE_ID`와 펌웨어 `DEVICE_ID` 일치, ESP32 Wi-Fi·POST 200 |
| 월간 차트 비어 있음 | 해당 월 CSV/jsonl 존재 여부, ingest 수신 이력 |

---

## 라이선스

저장소 소유자 정책에 따릅니다. 사내용 배포 시 비밀번호·서버 주소는 저장소에 커밋하지 마세요.

---

## 문의·이슈

버그나 개선은 GitHub Issues에 남겨 주세요.
