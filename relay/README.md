# 실외 날씨 중계 (Open-Meteo → MES)

MES 서버(`10.201.219.240`)는 **외부 인터넷 불가**일 때, **인터넷 가능 PC**(`10.201.219.119` 등)에서 실행합니다.

## exe 배포 (Windows 7 포함, Node 설치 불필요)

개발 PC에서 빌드:

```bash
npm run build:relay-exe
```

생성: `dist/outdoor-relay.exe`

### 119 PC에 복사할 것

```
C:\mes-outdoor-relay\
  outdoor-relay.exe
  outdoor-relay.env
  start-outdoor-relay-hidden.vbs   ← 백그라운드 실행 (권장)
  start-outdoor-relay-tray.ps1     ← 트레이 아이콘 (선택)
```

**Node.js 설치 필요 없음** (exe 안에 Node 12 런타임 포함).

### 설정 파일 (Win7)

Windows 7 탐색기는 **`.env`로 이름 변경이 안 됩니다** (`You must type a file name`).  
대신 **`outdoor-relay.env`** 를 쓰세요 (exe가 자동 인식).

1. `dist/outdoor-relay.env.example`을 119 PC 폴더에 복사
2. 탐색기에서 `outdoor-relay.env.example` → **`outdoor-relay.env`** 로 이름 변경 (정상 동작)
3. 메모장으로 `outdoor-relay.env` 열어 값 수정

`.env`가 꼭 필요하면 **cmd**에서:

```cmd
cd C:\mes-outdoor-relay
copy outdoor-relay.env.example .env
notepad .env
```

### outdoor-relay.env 예

```env
OUTDOOR_LOCATION=안산시 원시동
MES_PUSH_URL=http://10.201.219.240:3000/api/env/outdoor
OUTDOOR_INGEST_KEY=change-me-outdoor-key
RELAY_PUSH=1
RELAY_HTTP=1
RELAY_PORT=8080
```

`OUTDOOR_INGEST_KEY` = MES 서버 `.env`의 `ENV_OUTDOOR_INGEST_KEY` 와 **동일**.

### 실행 (콘솔 창 — 테스트용)

```cmd
cd C:\mes-outdoor-relay
outdoor-relay.exe
```

콘솔 창 **X** 를 누르면 중지됩니다. 119 PC 상시 운영에는 아래 **숨김/트레이** 방식을 쓰세요.

### 백그라운드 실행 (권장, Win7)

`start-outdoor-relay-hidden.vbs` 더블클릭 → **검은 콘솔 창 없이** exe만 실행됩니다.

작업 스케줄러 등록 예:

| 항목 | 값 |
|------|-----|
| 프로그램 | `C:\mes-outdoor-relay\start-outdoor-relay-hidden.vbs` |
| 인수 | (없음) |
| 시작 위치 | `C:\mes-outdoor-relay` |
| 트리거 | 로그온 시 |

종료: 작업 관리자 → `outdoor-relay.exe` 프로세스 종료.

### 트레이 아이콘 (선택)

작업 표시줄 **알림 영역**에 아이콘이 보입니다. 우클릭 → **종료** 로만 끌 수 있습니다.

바로가기 대상:

```text
powershell.exe -WindowStyle Hidden -ExecutionPolicy Bypass -File "C:\mes-outdoor-relay\start-outdoor-relay-tray.ps1"
```

작업 스케줄러에도 위 `powershell.exe` 경로와 `-File ...` 인수를 등록하면 됩니다.

### Push만 사용 (8080 불필요)

`outdoor-relay.env`에 `RELAY_HTTP=0` → MES로 POST만. Windows 방화벽 설정 생략 가능.

---

## 개발 PC에서 node로 실행 (선택)

```bash
copy relay\.env.example relay\.env
npm run relay:outdoor
```

---

## 역할

| 방식 | 방향 | 설명 |
|------|------|------|
| **Push** | 중계 → MES | `POST /api/env/outdoor` (권장) |
| **Pull** | MES → 중계 | MES `ENV_OUTDOOR_PULL_URL=http://119:8080/weather` |

---

## 데이터

- **현재**: **기온**(`temperature_2m`), **체감온도**(`apparent_temperature`), 습도, WMO 날씨 코드·한글 라벨
- **예보**: 3일 (최저·최고·날씨·아이콘)
- **지역**: 안산시 원시동 (좌표 `OUTDOOR_LAT` / `OUTDOOR_LON`에서 변경)
- **갱신**: 기본 10분 (`RELAY_REFRESH_MS=600000`)

Open-Meteo는 **기상 모델 격자값**이라 기상청·네이버 관측/체감과 수 ℃ 차이날 수 있습니다. MES 화면은 **기온**과 **체감**을 함께 표시합니다.

**페이로드 예** (`current`):

```json
{
  "tempC": 24.4,
  "feelsLikeC": 26.3,
  "humidityPct": 66,
  "weatherCode": 1,
  "weatherLabel": "대체로 맑음"
}
```

상세 스펙: [`outdoor-relay.exe.spec.json`](./outdoor-relay.exe.spec.json)
