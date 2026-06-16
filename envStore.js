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

function dayKey(ts) {
  const d = new Date(ts)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function fileForDay(day) {
  return path.join(dataDir(), `readings-${day}.jsonl`)
}

function listDayFiles() {
  const dir = dataDir()
  return fs
    .readdirSync(dir)
    .filter((f) => f.startsWith('readings-') && f.endsWith('.jsonl'))
    .sort()
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
  return n
}

module.exports = {
  insertReading,
  getLatest,
  getHistory,
  purgeOlderThan,
}
