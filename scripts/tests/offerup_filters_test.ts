// scripts/tests/offerup_filters_test.ts
// Runs the OfferUp script with different filter configurations and toggles FEED_ONLY.
// Keeps tests fast by using FEED_ONLY and small caps; writes logs and JSON summaries per scenario.

import { mkdir, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { join } from 'node:path'

type Scenario = {
  name: string
  env: Record<string, string | number | boolean>
}

function runOfferupOnce(extraEnv: Record<string, string>, timeoutMs = 180_000): Promise<{ code: number | null; output: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const repoRoot = join(__dirname, '..', '..')
    const tsxPath = join(repoRoot, 'node_modules', '.bin', 'tsx')
    const child = spawn(tsxPath, ['scripts/offerup.ts'], {
      cwd: repoRoot,
      env: { ...process.env, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let finished = false
    let timedOut = false
    const onData = (d: any) => { out += String(d) }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    const killTimer = setTimeout(() => {
      if (finished) return
      timedOut = true
      try { child.kill('SIGKILL') } catch {}
    }, timeoutMs)
    child.on('close', (code) => {
      clearTimeout(killTimer)
      finished = true
      resolve({ code, output: out, timedOut })
    })
  })
}

async function main() {
  const outDir = join(__dirname, 'output')
  await mkdir(outDir, { recursive: true })

  // Base env shared by all runs (safe and minimal)
  const baseEnv: Record<string, string> = {
    NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SERVICE_ROLE: 'test_service_role_key',
    OU_FAST_MODE: 'true',
    OU_HEADLESS: 'true',
    OU_MAX_ITEMS: '10',
    OU_SCROLL_PASSES: '1',
    OU_INJECT_SERVER_FILTERS: 'true',
    OU_STRICT_MODEL: 'false',
    OU_FEED_ONLY: 'true',
    OU_RADIUS_MILES: '35',
    OU_LAT: '33.8166',
    OU_LNG: '-118.0373',
    // Try direct feed when available to avoid heavy browsing
    OU_DIRECT_FEED: 'true',
  }

  const scenarios: Scenario[] = [
    { name: 'price_only', env: { OU_FILTER_MIN_PRICE: 5000, OU_FILTER_MAX_PRICE: 15000 } },
    { name: 'year_only', env: { OU_FILTER_MIN_YEAR: 2015, OU_FILTER_MAX_YEAR: 2021 } },
    { name: 'mileage_only', env: { OU_FILTER_MAX_MILEAGE: 120000 } },
    { name: 'make_only', env: { OU_FILTER_MAKES: 'toyota' } },
    { name: 'model_only', env: { OU_FILTER_MODELS: 'camry' } },
    { name: 'make_model', env: { OU_FILTER_MAKES: 'toyota', OU_FILTER_MODELS: 'tacoma' } },
    {
      name: 'combined',
      env: {
        OU_FILTER_MIN_PRICE: 4000,
        OU_FILTER_MAX_PRICE: 25000,
        OU_FILTER_MIN_YEAR: 2012,
        OU_FILTER_MAX_YEAR: 2022,
        OU_FILTER_MAX_MILEAGE: 150000,
        OU_FILTER_MAKES: 'honda',
        OU_FILTER_MODELS: 'civic',
      },
    },
  ]

  const feedOnlyVariants: Array<{ label: string; value: 'true' | 'false' }> = [
    { label: 'feedOnly_true', value: 'true' },
    { label: 'feedOnly_false', value: 'false' },
  ]

  const results: Array<{ scenario: string; variant: string; code: number | null; timedOut: boolean }> = []

  for (const sc of scenarios) {
    for (const variant of feedOnlyVariants) {
      const mergedEnv: Record<string, string> = {
        ...baseEnv,
        ...Object.fromEntries(Object.entries(sc.env).map(([k, v]) => [k, String(v)])),
        OU_FEED_ONLY: variant.value,
      }
      const label = `${sc.name}__${variant.label}`
      console.log(`\n=== Running OfferUp with scenario=${sc.name} FEED_ONLY=${variant.value} ===`)
      const { code, output, timedOut } = await runOfferupOnce(mergedEnv)
      results.push({ scenario: sc.name, variant: variant.label, code, timedOut })

      // Write full log
      const outfile = join(outDir, `offerup_${label}.log`)
      await writeFile(outfile, output, 'utf8')
      console.log(`→ Wrote log: ${outfile}`)

      // Extract summary JSON if present
      const m = output.match(/\{\s*"ok"\s*:\s*true[\s\S]*?\}\s*$/m)
      if (m) {
        try {
          const parsed = JSON.parse(m[0])
          const jsonOut = join(outDir, `offerup_${label}.json`)
          await writeFile(jsonOut, JSON.stringify(parsed, null, 2), 'utf8')
          console.log(`→ Wrote summary: ${jsonOut}`)
        } catch {}
      }

      if (timedOut) {
        console.warn(`Scenario ${label} timed out.`)
      }
    }
  }

  // Simple summary to stdout
  const lines: string[] = []
  lines.push('OfferUp filter test summary:')
  for (const r of results) {
    lines.push(`${r.scenario} | ${r.variant} | exit=${r.code ?? 'null'} | timedOut=${r.timedOut}`)
  }
  const summaryPath = join(outDir, 'summary.txt')
  await writeFile(summaryPath, lines.join('\n') + '\n', 'utf8')
  console.log(`\nSummary written to: ${summaryPath}`)
}

main().catch((err) => {
  console.error('offerup_filters_test failed:', err)
  process.exit(1)
})
