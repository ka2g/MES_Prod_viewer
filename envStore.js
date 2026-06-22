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

function csvDir() {
  const dir = path.join(dataDir(), 'csv')
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return dir
}

function dayKey(ts) {
  const d = new Date(ts)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function monthKey(year, month) {
  return `${year}-${String(month).padStart(2, '0')}`
}

function fileForDay(day) {
  return path.join(dataDir(), `readings-${day}.jsonl`)
}

function csvFileForMonth(year, month) {
  return path.join(csvDir(), `env-${monthKey(year, month)}.csv`)
}

function listDayFiles() {
  const dir = dataDir()
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((f) => f.startsWith('readings-') && f.endsWith('.jsonl'))
    .sort()
}

function listCsvFiles() {
  const dir = csvDir()
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((f) => f.startsWith('env-') && f.endsWith('.csv'))
    .sort()
}

function startOfLocalDay(ts = Date.now()) {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

function minutesSinceLocalMidnight(ts) {
  return Math.floor((ts - startOfLocalDay(ts)) / 60000)
}

function formatCsvTime(ts) {
  const d = new Date(ts)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function parseLine(line) {
  try {
    const o = JSON.parse(line)
    if (!o || o.deviceId == null || o.ts == null) return null
    return {
      deviceId: String(o.deviceId),
      ts: Number(o.ts),
      tempC: Number(o.tempC),
      humidityPct: Number(o.humidityPct),
      rawTemp: o.rawTemp != null ? Number(o.rawTemp) : null,
      rawHum: o.rawHum != null ? Number(o.rawHum) : null,
    }
  } catch {
    return null
  }
}

function appendCsv(row) {
  const d = new Date(row.ts)
  const file = csvFileForMonth(d.getFullYear(), d.getMonth() + 1)
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, 'recorded_at,device_id,temp_c,humidity_pct\n', 'utf8')
  }
  const line = `${formatCsvTime(row.ts)},${row.deviceId},${row.tempC},${row.humidityPct}\n`
  fs.appendFileSync(file, line, 'utf8')
}

function insertReading(row) {
  const line =
    JSON.stringify({
      deviceId: row.deviceId,
      ts: row.ts,
      tempC: row.tempC,
      humidityPct: row.humidityPct,
      rawTemp: row.rawTemp ?? null,
      rawHum: row.rawHum ?? null,
    }) + '\n'
  fs.appendFileSync(fileForDay(dayKey(row.ts)), line, 'utf8')
  appendCsv(row)
}

function readSince(deviceId, sinceMs) {
  const out = []
  for (const f of listDayFiles()) {
    const dayStr = f.slice('readings-'.length, -'.jsonl'.length)
    const dayStart = new Date(`${dayStr}T00:00:00`).getTime()
    if (dayStart + 24 * 3600 * 1000 < sinceMs) continue

    const full = path.join(dataDir(), f)
    let text
    try {
      text = fs.readFileSync(full, 'utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      const r = parseLine(line)
      if (!r || r.deviceId !== deviceId || r.ts < sinceMs) continue
      out.push(r)
    }
  }
  out.sort((a, b) => a.ts - b.ts)
  return out
}

function getLatest(deviceId) {
  const files = listDayFiles()
  for (let i = files.length - 1; i >= 0; i--) {
    const full = path.join(dataDir(), files[i])
    let text
    try {
      text = fs.readFileSync(full, 'utf8')
    } catch {
      continue
    }
    const lines = text.split('\n').filter(Boolean)
    for (let j = lines.length - 1; j >= 0; j--) {
      const r = parseLine(lines[j])
      if (r && r.deviceId === deviceId) return r
    }
  }
  return null
}

function getLatestAny() {
  const files = listDayFiles()
  for (let i = files.length - 1; i >= 0; i--) {
    const full = path.join(dataDir(), files[i])
    let text
    try {
      text = fs.readFileSync(full, 'utf8')
    } catch {
      continue
    }
    const lines = text.split('\n').filter(Boolean)
    for (let j = lines.length - 1; j >= 0; j--) {
      const r = parseLine(lines[j])
      if (r) return r
    }
  }
  return null
}

/** 오늘 00:00~24:00, 10분 버킷 (xMin = 자정 이후 분) */
function getTodayHistory10Min(deviceId, bucketMinutes = 10) {
  const since = startOfLocalDay()
  const rows = readSince(deviceId, since)
  const bucketMs = Math.max(1, bucketMinutes) * 60 * 1000
  const buckets = new Map()

  for (const r of rows) {
    const dayStart = startOfLocalDay(r.ts)
    const key = dayStart + Math.floor((r.ts - dayStart) / bucketMs) * bucketMs
    let b = buckets.get(key)
    if (!b) {
      b = { ts: key, xMin: minutesSinceLocalMidnight(key), tempSum: 0, humSum: 0, n: 0 }
      buckets.set(key, b)
    }
    b.tempSum += r.tempC
    b.humSum += r.humidityPct
    b.n += 1
  }

  return [...buckets.values()]
    .sort((a, b) => a.xMin - b.xMin)
    .map((b) => ({
      ts: b.ts,
      xMin: b.xMin,
      tempC: Math.round((b.tempSum / b.n) * 10) / 10,
      humidityPct: Math.round((b.humSum / b.n) * 10) / 10,
    }))
}

function parseCsvRow(line) {
  const parts = line.split(',')
  if (parts.length < 4) return null
  const recordedAt = parts[0].trim()
  const deviceId = parts[1].trim()
  const tempC = Number(parts[2])
  const humidityPct = Number(parts[3])
  const ts = new Date(recordedAt.replace(' ', 'T')).getTime()
  if (!deviceId || !Number.isFinite(ts) || !Number.isFinite(tempC)) return null
  return { ts, deviceId, tempC, humidityPct }
}

function readCsvRowsForMonth(deviceId, year, month) {
  const file = csvFileForMonth(year, month)
  if (!fs.existsSync(file)) return []
  const text = fs.readFileSync(file, 'utf8')
  const out = []
  for (const line of text.split('\n')) {
    if (!line.trim() || line.startsWith('recorded_at')) continue
    const r = parseCsvRow(line)
    if (!r || r.deviceId !== deviceId) continue
    const d = new Date(r.ts)
    if (d.getFullYear() !== year || d.getMonth() + 1 !== month) continue
    out.push(r)
  }
  return out
}

/** CSV 기준 월간 일별 평균 (x = 일 1~말일). CSV 없으면 jsonl 폴백 */
function getMonthDailyFromCsv(deviceId, year, month) {
  let rows = readCsvRowsForMonth(deviceId, year, month)
  if (rows.length === 0) {
    const start = new Date(year, month - 1, 1).getTime()
    const end = new Date(year, month, 1).getTime()
    rows = readSince(deviceId, start).filter((r) => r.ts < end)
  }
  const daysInMonth = new Date(year, month, 0).getDate()
  const byDay = new Map()

  for (const r of rows) {
    const day = new Date(r.ts).getDate()
    let b = byDay.get(day)
    if (!b) {
      b = { day, tempSum: 0, humSum: 0, n: 0 }
      byDay.set(day, b)
    }
    b.tempSum += r.tempC
    b.humSum += r.humidityPct
    b.n += 1
  }

  const history = []
  for (let day = 1; day <= daysInMonth; day++) {
    const b = byDay.get(day)
    if (!b) continue
    history.push({
      day,
      ts: new Date(year, month - 1, day, 12, 0, 0).getTime(),
      tempC: Math.round((b.tempSum / b.n) * 10) / 10,
      humidityPct: Math.round((b.humSum / b.n) * 10) / 10,
    })
  }
  return { year, month, daysInMonth, history }
}

function getHistory(deviceId, hours, bucketMinutes) {
  const since = Date.now() - hours * 3600 * 1000
  const rows = readSince(deviceId, since)
  const bucketMs = Math.max(1, bucketMinutes) * 60 * 1000

  if (bucketMs <= 60 * 1000) {
    return rows.map((r) => ({
      ts: r.ts,
      tempC: r.tempC,
      humidityPct: r.humidityPct,
    }))
  }

  const buckets = new Map()
  for (const r of rows) {
    const key = Math.floor(r.ts / bucketMs) * bucketMs
    let b = buckets.get(key)
    if (!b) {
      b = { ts: key, tempSum: 0, humSum: 0, n: 0 }
      buckets.set(key, b)
    }
    b.tempSum += r.tempC
    b.humSum += r.humidityPct
    b.n += 1
  }

  return [...buckets.values()]
    .sort((a, b) => a.ts - b.ts)
    .map((b) => ({
      ts: b.ts,
      tempC: Math.round((b.tempSum / b.n) * 10) / 10,
      humidityPct: Math.round((b.humSum / b.n) * 10) / 10,
    }))
}

const CALIBRATION_FILE = () => path.join(dataDir(), 'calibration.json')

function round1(v) {
  return Math.round(v * 10) / 10
}

function clampCal(v, min, max) {
  if (!Number.isFinite(v)) return 0
  return Math.min(max, Math.max(min, v))
}

function getCalibration() {
  try {
    const file = CALIBRATION_FILE()
    if (fs.existsSync(file)) {
      const o = JSON.parse(fs.readFileSync(file, 'utf8'))
      return {
        tempOffset: round1(clampCal(Number(o.tempOffset), -50, 50)),
        humidityOffset: round1(clampCal(Number(o.humidityOffset), -50, 50)),
        updatedAt: o.updatedAt || null,
      }
    }
  } catch (_) {}
  return { tempOffset: 0, humidityOffset: 0, updatedAt: null }
}

function setCalibration({ tempOffset, humidityOffset }) {
  const cal = {
    tempOffset: round1(clampCal(Number(tempOffset), -50, 50)),
    humidityOffset: round1(clampCal(Number(humidityOffset), -50, 50)),
    updatedAt: new Date().toISOString(),
  }
  fs.writeFileSync(CALIBRATION_FILE(), JSON.stringify(cal, null, 2), 'utf8')
  return cal
}

function applyCalibration(tempC, humidityPct) {
  const cal = getCalibration()
  return {
    tempC: round1(clampCal(tempC + cal.tempOffset, -50, 80)),
    humidityPct: round1(clampCal(humidityPct + cal.humidityOffset, 0, 100)),
  }
}

/** CSV·jsonl 기준 데이터가 있는 월 목록 (최신순) */
function listAvailableMonths(_deviceId) {
  const byKey = new Map()

  for (const f of listCsvFiles()) {
    const key = f.slice('env-'.length, -'.csv'.length)
    const [yStr, mStr] = key.split('-')
    const year = parseInt(yStr, 10)
    const month = parseInt(mStr, 10)
    if (year && month >= 1 && month <= 12) {
      byKey.set(key, { year, month, key })
    }
  }

  for (const f of listDayFiles()) {
    const dayStr = f.slice('readings-'.length, -'.jsonl'.length)
    const [yStr, mStr] = dayStr.split('-')
    const year = parseInt(yStr, 10)
    const month = parseInt(mStr, 10)
    if (!year || month < 1 || month > 12) continue
    const key = monthKey(year, month)
    if (!byKey.has(key)) byKey.set(key, { year, month, key })
  }

  return [...byKey.values()].sort((a, b) =>
    a.year !== b.year ? b.year - a.year : b.month - a.month,
  )
}

/** 가장 오래된 데이터 월 ~ 당월까지 전체 (최신순, 빈 달 포함) */
function listBrowsableMonths(_deviceId) {
  const withData = listAvailableMonths(_deviceId)
  const now = new Date()
  const endYear = now.getFullYear()
  const endMonth = now.getMonth() + 1

  if (withData.length === 0) {
    const key = monthKey(endYear, endMonth)
    return [{ year: endYear, month: endMonth, key }]
  }

  const oldest = withData[withData.length - 1]
  const out = []
  let y = oldest.year
  let m = oldest.month

  while (y < endYear || (y === endYear && m <= endMonth)) {
    out.push({ year: y, month: m, key: monthKey(y, m) })
    m += 1
    if (m > 12) {
      m = 1
      y += 1
    }
  }

  return out.reverse()
}

function purgeOlderThan(days) {
  if (!days || days < 1) return 0
  const cutoff = Date.now() - days * 24 * 3600 * 1000
  const cutoffDay = dayKey(cutoff)
  let n = 0
  for (const f of listDayFiles()) {
    const d = f.slice('readings-'.length, -'.jsonl'.length)
    if (d < cutoffDay) {
      try {
        fs.unlinkSync(path.join(dataDir(), f))
        n += 1
      } catch (_) {}
    }
  }
  const cutoffDate = new Date(cutoff)
  const cutoffMonth = monthKey(cutoffDate.getFullYear(), cutoffDate.getMonth() + 1)
  for (const f of listCsvFiles()) {
    const m = f.slice('env-'.length, -'.csv'.length)
    if (m < cutoffMonth) {
      try {
        fs.unlinkSync(path.join(csvDir(), f))
        n += 1
      } catch (_) {}
    }
  }
  return n
}

module.exports = {
  insertReading,
  getLatest,
  getLatestAny,
  getHistory,
  getTodayHistory10Min,
  getMonthDailyFromCsv,
  listAvailableMonths,
  listBrowsableMonths,
  getCalibration,
  setCalibration,
  applyCalibration,
  purgeOlderThan,
}
