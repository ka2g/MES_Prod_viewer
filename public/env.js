'use strict'

const envPanelEl = document.getElementById('envPanel')
const envTempValEl = document.getElementById('envTempVal')
const envHumValEl = document.getElementById('envHumVal')
const envUpdatedEl = document.getElementById('envUpdated')
const envStatusEl = document.getElementById('envStatus')
const envChartCanvas = document.getElementById('envChart')

let envEventSource = null
let envChart = null
let lastEnvPayload = null

function envVisible() {
  return document.body.dataset.phase === 'smt'
}

function setEnvPanelVisible(show) {
  if (!envPanelEl) return
  envPanelEl.classList.toggle('hidden', !show)
  if (show && lastEnvPayload) {
    applyEnvPayload(lastEnvPayload)
  }
}

function formatTs(ms) {
  if (!ms) return '—'
  const d = new Date(ms)
  return d.toLocaleString('ko-KR', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
}

function minutesSince(ms) {
  if (!ms) return null
  return Math.max(0, Math.floor((Date.now() - ms) / 60000))
}

function ensureChart() {
  if (!envChartCanvas || typeof Chart === 'undefined') return null
  if (envChart) return envChart

  envChart = new Chart(envChartCanvas, {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        {
          label: '온도 (℃)',
          data: [],
          borderColor: '#dc2626',
          backgroundColor: 'rgba(220, 38, 38, 0.08)',
          yAxisID: 'yTemp',
          tension: 0.25,
          pointRadius: 0,
          borderWidth: 2,
        },
        {
          label: '습도 (%RH)',
          data: [],
          borderColor: '#2563eb',
          backgroundColor: 'rgba(37, 99, 235, 0.08)',
          yAxisID: 'yHum',
          tension: 0.25,
          pointRadius: 0,
          borderWidth: 2,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { position: 'top', labels: { font: { family: "'Noto Sans KR', sans-serif" } } },
      },
      scales: {
        x: {
          ticks: {
            maxTicksLimit: 8,
            font: { size: 11 },
            callback(_v, i, ticks) {
              const lbl = ticks[i]?.label
              return lbl || ''
            },
          },
        },
        yTemp: {
          type: 'linear',
          position: 'left',
          title: { display: true, text: '℃' },
          suggestedMin: -20,
          suggestedMax: 50,
        },
        yHum: {
          type: 'linear',
          position: 'right',
          title: { display: true, text: '%RH' },
          suggestedMin: 0,
          suggestedMax: 100,
          grid: { drawOnChartArea: false },
        },
      },
    },
  })
  return envChart
}

function updateChart(history) {
  const chart = ensureChart()
  if (!chart || !Array.isArray(history)) return

  const labels = history.map((p) => {
    const d = new Date(p.ts)
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  })
  chart.data.labels = labels
  chart.data.datasets[0].data = history.map((p) => p.tempC)
  chart.data.datasets[1].data = history.map((p) => p.humidityPct)
  chart.update('none')
}

function applyEnvPayload(payload) {
  if (!payload || !payload.ok) {
    if (envStatusEl) {
      envStatusEl.textContent = (payload && payload.error) || '온습도 데이터 없음'
      envStatusEl.className = 'env-panel__status env-panel__status--warn'
    }
    return
  }

  lastEnvPayload = payload
  if (!envVisible()) return

  const latest = payload.latest
  if (latest) {
    if (envTempValEl) envTempValEl.textContent = `${latest.tempC.toFixed(1)}℃`
    if (envHumValEl) envHumValEl.textContent = `${latest.humidityPct.toFixed(1)}%`
    const m = minutesSince(latest.ts)
    if (envUpdatedEl) {
      envUpdatedEl.textContent =
        m === null ? '—' : m === 0 ? '방금 갱신' : `${m}분 전 갱신`
    }
  }

  if (envStatusEl) {
    const stale = latest && minutesSince(latest.ts) != null && minutesSince(latest.ts) > 5
    envStatusEl.textContent = stale ? '센서 수신 지연' : '실시간'
    envStatusEl.className = stale
      ? 'env-panel__status env-panel__status--warn'
      : 'env-panel__status env-panel__status--ok'
  }

  updateChart(payload.history)
}

async function fetchEnvSnapshot() {
  try {
    const r = await fetch('/api/env/snapshot')
    const data = await r.json()
    applyEnvPayload(data)
  } catch (_) {
    applyEnvPayload({ ok: false, error: '온습도 API 연결 실패' })
  }
}

function connectEnvStream() {
  if (envEventSource) {
    envEventSource.close()
    envEventSource = null
  }
  if (typeof EventSource === 'undefined') {
    fetchEnvSnapshot()
    setInterval(fetchEnvSnapshot, 15000)
    return
  }
  const src = new EventSource('/api/env/stream')
  envEventSource = src
  src.onmessage = (ev) => {
    try {
      applyEnvPayload(JSON.parse(ev.data))
    } catch (_) {}
  }
  src.onerror = () => {
    if (envStatusEl) {
      envStatusEl.textContent = '재연결 중…'
      envStatusEl.className = 'env-panel__status env-panel__status--warn'
    }
  }
}

window.addEventListener('mes-phase-change', (e) => {
  setEnvPanelVisible(e.detail && e.detail.phase === 'smt')
})

document.body.dataset.phase = document.body.dataset.phase || 'smt'
setEnvPanelVisible(envVisible())
connectEnvStream()
