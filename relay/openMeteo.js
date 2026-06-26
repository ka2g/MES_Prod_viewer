'use strict'

/** WMO weather code → 한글 (Open-Meteo) */
function wmoLabel(code) {
  const c = parseInt(String(code), 10)
  if (!Number.isFinite(c)) return '—'
  if (c === 0) return '맑음'
  if (c === 1) return '대체로 맑음'
  if (c === 2) return '구름 조금'
  if (c === 3) return '흐림'
  if (c === 45 || c === 48) return '안개'
  if (c >= 51 && c <= 57) return '이슬비'
  if (c >= 61 && c <= 67) return '비'
  if (c >= 71 && c <= 77) return '눈'
  if (c >= 80 && c <= 82) return '소나기'
  if (c >= 85 && c <= 86) return '눈보라'
  if (c >= 95 && c <= 99) return '뇌우'
  return '—'
}

function round1(v) {
  return Math.round(v * 10) / 10
}

function dayLabel(dateStr, index) {
  if (index === 0) return '오늘'
  if (index === 1) return '내일'
  const d = new Date(`${dateStr}T12:00:00`)
  const w = ['일', '월', '화', '수', '목', '금', '토']
  return `${d.getMonth() + 1}/${d.getDate()}(${w[d.getDay()]})`
}

/**
 * @param {{ latitude: number, longitude: number, location: string }} opts
 */
async function fetchOpenMeteo(opts) {
  const { latitude, longitude, location } = opts
  const params = new URLSearchParams({
    latitude: String(latitude),
    longitude: String(longitude),
    timezone: 'Asia/Seoul',
    forecast_days: '3',
    current: 'temperature_2m,relative_humidity_2m,apparent_temperature,weather_code',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min',
  })
  const url = `https://api.open-meteo.com/v1/forecast?${params}`
  const { getJson } = require('./httpUtil')
  const j = await getJson(url)
  const cur = j.current || {}
  const daily = j.daily || {}
  const dates = daily.time || []

  const forecast = dates.slice(0, 3).map((date, i) => {
    const code = daily.weather_code ? daily.weather_code[i] : null
    return {
      date,
      label: dayLabel(date, i),
      tempMin: round1(Number(daily.temperature_2m_min[i])),
      tempMax: round1(Number(daily.temperature_2m_max[i])),
      humidityPct: null,
      weatherCode: code,
      weatherLabel: wmoLabel(code),
    }
  })

  const code = cur.weather_code
  const feelsRaw = Number(cur.apparent_temperature)
  const feelsLikeC = Number.isFinite(feelsRaw) ? round1(feelsRaw) : null
  return {
    ok: true,
    source: 'open-meteo',
    location,
    fetchedAt: new Date().toISOString(),
    current: {
      tempC: round1(Number(cur.temperature_2m)),
      feelsLikeC,
      humidityPct: round1(Number(cur.relative_humidity_2m)),
      weatherCode: code,
      weatherLabel: wmoLabel(code),
    },
    forecast,
  }
}

module.exports = { fetchOpenMeteo, wmoLabel, dayLabel }
