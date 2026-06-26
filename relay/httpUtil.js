'use strict'

const https = require('https')
const http = require('http')
const { URL } = require('url')

function request(method, urlStr, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr)
    const lib = u.protocol === 'https:' ? https : http
    const opts = {
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method,
      headers: headers || {},
    }
    const req = lib.request(opts, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        resolve({
          status: res.statusCode || 0,
          text: Buffer.concat(chunks).toString('utf8'),
        })
      })
    })
    req.on('error', reject)
    req.setTimeout(20000, () => {
      req.destroy(new Error('Request timeout'))
    })
    if (body) req.write(body)
    req.end()
  })
}

function getJson(url) {
  return request('GET', url).then((r) => {
    if (r.status < 200 || r.status >= 300) {
      throw new Error(`HTTP ${r.status}`)
    }
    return JSON.parse(r.text)
  })
}

function postJson(url, obj, extraHeaders) {
  const body = JSON.stringify(obj)
  const headers = Object.assign(
    {
      'Content-Type': 'application/json',
      'Content-Length': String(Buffer.byteLength(body)),
      Connection: 'close',
    },
    extraHeaders || {},
  )
  return request('POST', url, headers, body).then((r) => {
    if (r.status < 200 || r.status >= 300) {
      throw new Error(`HTTP ${r.status}: ${r.text.slice(0, 200)}`)
    }
    return r.text
  })
}

module.exports = { getJson, postJson }
