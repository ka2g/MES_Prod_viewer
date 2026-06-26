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

const OUTDOOR_FILE = () => path.join(dataDir(), 'outdoor-latest.json')

function round1(v) {
  return Math.round(v * 10) / 10
}

function clampNum(v, min, max) {
  if (!Number.isFinite(v)) return null
  return Math.min(max, Math.max(min, v))
}

/** @param {unknown} body */
function normalizeOutdoor(body) {
  if (!body || typeof body !== 'object') return null
  const o = /** @type {Record<string, unknown>} */ (body)
  const cur = o.current && typeof o.current === 'object' ? o.current : o
  const c = /** @type {Record<string, unknown>} */ (cur)

  const tempC = clampNum(Number(c.tempC), -50, 50)
  const humidityPct = clampNum(Number(c.humidityPct), 0, 100)
  if (tempC === null || humidityPct === null) return null

  const weatherCodeRaw = c.weatherCode != null ? parseInt(String(c.weatherCode), 10) : null
  const weatherCode = Number.isFinite(weatherCodeRaw) ? weatherCodeRaw : null
  const feelsLikeC = clampNum(Number(c.feelsLikeC), -50, 50)

  let forecast = []
  if (Array.isArray(o.forecast)) {
    forecast = o.forecast
      .slice(0, 3)
      .map((row) => {
        if (!row || typeof row !== 'object') return null
        const r = /** @type {Record<string, unknown>} */ (row)
        const tMin = clampNum(Number(r.tempMin), -50, 50)
        const tMax = clampNum(Number(r.tempMax), -50, 50)
        if (tMin === null || tMax === null || !r.date) return null
        const codeRaw = r.weatherCode != null ? parseInt(String(r.weatherCode), 10) : null
        return {
          date: String(r.date),
          label: r.label != null ? String(r.label) : String(r.date),
          tempMin: round1(tMin),
          tempMax: round1(tMax),
          humidityPct:
            r.humidityPct != null ? clampNum(Number(r.humidityPct), 0, 100) : null,
          weatherCode: Number.isFinite(codeRaw) ? codeRaw : null,
          weatherLabel: r.weatherLabel != null ? String(r.weatherLabel) : null,
        }
      })
      .filter(Boolean)
  }

  const fetchedRaw = o.fetchedAt != null ? new Date(String(o.fetchedAt)).getTime() : Date.now()
  const fetchedAt = Number.isFinite(fetchedRaw) ? fetchedRaw : Date.now()

  return {
    ok: true,
    source: o.source != null ? String(o.source) : 'relay',
    location: o.location != null ? String(o.location) : '',
    fetchedAt,
    receivedAt: Date.now(),
    current: {
      tempC: round1(tempC),
      feelsLikeC: feelsLikeC != null ? round1(feelsLikeC) : null,
      humidityPct: round1(humidityPct),
      weatherCode,
      weatherLabel: c.weatherLabel != null ? String(c.weatherLabel) : null,
    },
    forecast,
  }
}

function saveOutdoor(body) {
  const normalized = normalizeOutdoor(body)
  if (!normalized) throw new Error('Invalid outdoor payload')
  fs.writeFileSync(OUTDOOR_FILE(), JSON.stringify(normalized, null, 2), 'utf8')
  return normalized
}

function getOutdoor() {
  try {
    const file = OUTDOOR_FILE()
    if (!fs.existsSync(file)) return null
    const o = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!o || !o.current) return null
    return o
  } catch {
    return null
  }
}

module.exports = { normalizeOutdoor, saveOutdoor, getOutdoor }
