import { chromium, LaunchOptions, BrowserContext } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'

async function main() {
  const proxyServer = process.env.FB_PROXY_SERVER || ''
  const proxyUser = process.env.FB_PROXY_USERNAME || ''
  const proxyPass = process.env.FB_PROXY_PASSWORD || ''
  const proxySession = process.env.FB_PROXY_SESSION_ID

  const launchOpts: LaunchOptions = { headless: false }
  if (proxyServer && proxyUser && proxyPass) {
    const username = proxySession ? `${proxyUser}-session-${proxySession}` : proxyUser
    launchOpts.proxy = { server: proxyServer, username, password: proxyPass }
  }

  const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

  const browser = await chromium.launch(launchOpts)
  const context: BrowserContext = await browser.newContext({
    userAgent: ua,
    viewport: { width: 1366, height: 900 },
  })
  const page = await context.newPage()

  console.log('[FB] Opening Facebook home. Log in manually, then visit Marketplace > Vehicles...')
  await page.goto('https://www.facebook.com/', { waitUntil: 'load', timeout: 60_000 })

  // Give you time to complete manual auth + navigation
  const waitMs = Math.max(10_000, parseInt(process.env.FB_WAIT_MS || '150000', 10) || 105_000)
  console.log(`[FB] Waiting ${waitMs}ms for manual login/navigation...`)
  await page.waitForTimeout(waitMs)

  const outPath = path.join('secrets', 'fb_state.json')
  try { await fs.mkdir(path.dirname(outPath), { recursive: true }) } catch {}
  await context.storageState({ path: outPath })
  console.log('[FB] Saved storageState to', outPath)

  await browser.close()
}

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
if (typeof require !== 'undefined' && require.main === module) {
  main().catch((e) => { console.error('[FB] Failed to capture state:', e); process.exit(1) })
}
