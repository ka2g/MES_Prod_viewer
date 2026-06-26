'use strict'

let config = {
  webhookUrl: '',
  telegramToken: '',
  telegramChatId: '',
}

function configure(partial) {
  config = { ...config, ...partial }
}

function isEnabled() {
  return Boolean(config.webhookUrl || (config.telegramToken && config.telegramChatId))
}

const METRIC_LABEL = { temp: '온도', hum: '습도', sensor: '센서' }
const KIND_LABEL = { high: '상한 초과', low: '하한 미만', offline: '수신 단절' }

function formatMessage(event) {
  const metric = METRIC_LABEL[event.metric] || event.metric
  const unit = event.metric === 'temp' ? '℃' : event.metric === 'hum' ? '%RH' : ''
  if (event.metric === 'sensor') {
    return event.state === 'raised'
      ? `[경보] SMT 현장 센서 수신 단절 (${event.deviceId})`
      : `[복구] SMT 현장 센서 수신 재개 (${event.deviceId})`
  }
  const kind = KIND_LABEL[event.kind] || event.kind
  if (event.state === 'raised') {
    return `[경보] SMT 현장 ${metric} ${kind} — 현재 ${event.value}${unit} (한계 ${event.limit}${unit})`
  }
  return `[복구] SMT 현장 ${metric} 정상 범위 복귀 — 현재 ${event.value}${unit}`
}

async function postJson(url, body) {
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch (e) {
    console.warn('[notifier] webhook failed:', e.message)
  }
}

async function postTelegram(text) {
  const url = `https://api.telegram.org/bot${config.telegramToken}/sendMessage`
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: config.telegramChatId, text }),
    })
  } catch (e) {
    console.warn('[notifier] telegram failed:', e.message)
  }
}

/** fire-and-forget. 설정 없으면 아무것도 안 함 */
function notify(event) {
  if (!isEnabled()) return
  if (typeof fetch !== 'function') {
    console.warn('[notifier] global fetch unavailable (Node 18+ required)')
    return
  }
  const text = formatMessage(event)
  if (config.webhookUrl) void postJson(config.webhookUrl, { text, event })
  if (config.telegramToken && config.telegramChatId) void postTelegram(text)
}

module.exports = { configure, isEnabled, notify, formatMessage }
