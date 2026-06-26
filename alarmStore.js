'use strict'

const fs = require('fs')
const path = require('path')

function dataDir() {
  const base = process.pkg
    ? path.join(path.dirname(process.execPath), 'data', 'env')
    : path.join(__dirname, 'data', 'env')
  if (!fs.existsSync(base)) fs.mkdirSync(base, { recursive: true })
  return base
}

function monthKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

function fileForMonth(d) {
  return path.join(dataDir(), `alarms-${monthKey(d)}.jsonl`)
}

function listAlarmFiles() {
  const dir = dataDir()
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((f) => f.startsWith('alarms-') && f.endsWith('.jsonl'))
    .sort()
}

/** @type {{ tempMin:number, tempMax:number, humMin:number, humMax:number, sustainMs:number, staleAlarmMs:number }} */
let config = {
  tempMin: 22,
  tempMax: 28,
  humMin: 40,
  humMax: 60,
  sustainMs: 3 * 60 * 1000,
  staleAlarmMs: 15 * 60 * 1000,
}

function configure(partial) {
  config = { ...config, ...partial }
}

function getThresholds() {
  return {
    tempMin: config.tempMin,
    tempMax: config.tempMax,
    humMin: config.humMin,
    humMax: config.humMax,
  }
}

/**
 * 메트릭별 상태머신.
 * candidateSince: 이탈이 처음 감지된 시각(연속 이탈 추적용), null이면 정상 후보 없음
 * active: 현재 경보 활성 이벤트(없으면 null)
 * @type {Map<string, { temp: any, hum: any, sensor: any }>}
 */
const deviceState = new Map()

function freshDeviceState() {
  return {
    temp: { candidateSince: null, candidateKind: null, active: null },
    hum: { candidateSince: null, candidateKind: null, active: null },
    sensor: { active: null },
  }
}

function getDeviceState(deviceId) {
  let s = deviceState.get(deviceId)
  if (!s) {
    s = freshDeviceState()
    deviceState.set(deviceId, s)
  }
  return s
}

function classify(value, min, max) {
  if (!Number.isFinite(value)) return null
  if (value > max) return 'high'
  if (value < min) return 'low'
  return null
}

function writeEvent(event) {
  const line = JSON.stringify(event) + '\n'
  fs.appendFileSync(fileForMonth(new Date(event.ts)), line, 'utf8')
}

function limitForKind(metric, kind) {
  if (metric === 'temp') return kind === 'high' ? config.tempMax : config.tempMin
  if (metric === 'hum') return kind === 'high' ? config.humMax : config.humMin
  return null
}

/** 한 메트릭(temp/hum)의 이탈 상태 갱신. 새 이벤트 배열 반환 */
function stepMetric(deviceId, metric, value, ts, min, max, out) {
  const st = getDeviceState(deviceId)[metric]
  const kind = classify(value, min, max)

  if (kind) {
    if (st.candidateKind !== kind) {
      st.candidateSince = ts
      st.candidateKind = kind
    }
    const sustained = ts - st.candidateSince >= config.sustainMs
    if (sustained && !st.active) {
      const event = {
        ts,
        deviceId,
        metric,
        kind,
        state: 'raised',
        value,
        limit: limitForKind(metric, kind),
        since: st.candidateSince,
      }
      st.active = event
      writeEvent(event)
      out.push(event)
    } else if (st.active && st.active.kind !== kind) {
      // high <-> low 전환: 이전 해제 후 신규 발생
      const cleared = {
        ts,
        deviceId,
        metric,
        kind: st.active.kind,
        state: 'cleared',
        value,
        limit: st.active.limit,
        durationMs: ts - st.active.ts,
      }
      writeEvent(cleared)
      out.push(cleared)
      const raised = {
        ts,
        deviceId,
        metric,
        kind,
        state: 'raised',
        value,
        limit: limitForKind(metric, kind),
        since: ts,
      }
      st.active = raised
      st.candidateSince = ts
      writeEvent(raised)
      out.push(raised)
    }
  } else {
    st.candidateSince = null
    st.candidateKind = null
    if (st.active) {
      const cleared = {
        ts,
        deviceId,
        metric,
        kind: st.active.kind,
        state: 'cleared',
        value,
        limit: st.active.limit,
        durationMs: ts - st.active.ts,
      }
      st.active = null
      writeEvent(cleared)
      out.push(cleared)
    }
  }
}

/** 수신 1건 평가. 발생/해제된 새 이벤트 배열 반환 */
function evaluateReading(deviceId, ts, tempC, humidityPct) {
  const out = []
  stepMetric(deviceId, 'temp', tempC, ts, config.tempMin, config.tempMax, out)
  stepMetric(deviceId, 'hum', humidityPct, ts, config.humMin, config.humMax, out)
  // 수신이 오면 센서 단절 해제
  const st = getDeviceState(deviceId)
  if (st.sensor.active) {
    const cleared = {
      ts,
      deviceId,
      metric: 'sensor',
      kind: 'offline',
      state: 'cleared',
      durationMs: ts - st.sensor.active.ts,
    }
    st.sensor.active = null
    writeEvent(cleared)
    out.push(cleared)
  }
  return out
}

/** 마지막 수신 이후 경과로 센서 단절 판정. 상태 변할 때만 이벤트 반환 */
function checkSensorWatchdog(deviceId, now, lastReadingTs) {
  const out = []
  const st = getDeviceState(deviceId).sensor
  const offline =
    lastReadingTs != null && now - lastReadingTs >= config.staleAlarmMs
  if (offline && !st.active) {
    const event = {
      ts: now,
      deviceId,
      metric: 'sensor',
      kind: 'offline',
      state: 'raised',
      lastReadingTs,
    }
    st.active = event
    writeEvent(event)
    out.push(event)
  }
  return out
}

/** payload용 현재 활성 알람 목록 */
function getActiveAlarms(deviceId) {
  const s = deviceState.get(deviceId)
  if (!s) return []
  const out = []
  if (s.temp.active) out.push(s.temp.active)
  if (s.hum.active) out.push(s.hum.active)
  if (s.sensor.active) out.push(s.sensor.active)
  return out
}

function readAlarms(deviceId, fromMs, toMs) {
  const out = []
  for (const f of listAlarmFiles()) {
    let text
    try {
      text = fs.readFileSync(path.join(dataDir(), f), 'utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      let o
      try {
        o = JSON.parse(line)
      } catch {
        continue
      }
      if (deviceId && o.deviceId !== deviceId) continue
      if (o.ts < fromMs || o.ts > toMs) continue
      out.push(o)
    }
  }
  out.sort((a, b) => b.ts - a.ts)
  return out
}

function purgeOlderThan(days) {
  if (!days || days < 1) return 0
  const cutoff = new Date(Date.now() - days * 24 * 3600 * 1000)
  const cutoffMonth = monthKey(cutoff)
  let n = 0
  for (const f of listAlarmFiles()) {
    const m = f.slice('alarms-'.length, -'.jsonl'.length)
    if (m < cutoffMonth) {
      try {
        fs.unlinkSync(path.join(dataDir(), f))
        n += 1
      } catch (_) {}
    }
  }
  return n
}

module.exports = {
  configure,
  getThresholds,
  evaluateReading,
  checkSensorWatchdog,
  getActiveAlarms,
  readAlarms,
  purgeOlderThan,
}
