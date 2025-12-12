import { spawn } from 'node:child_process';
import path from 'node:path';

// Goal: 35 cars, $12k+, non-dealer, posted in last 1 hour.
// Region: San Diego (200mi radius)
// Constraint: 15 min timeout.

const SCRIPT_PATH = path.join(process.cwd(), 'scripts', 'offerup.ts');
const TSX_PATH = path.join(process.cwd(), 'node_modules', '.bin', 'tsx');

async function runSDHourlyTest() {
  console.log(`\n>>> STARTING SD HOURLY TEST (Target: 35 items) <<<\n`);
  console.log(`Criteria: >$12k, <1h old, Private Seller, San Diego (200mi)\n`);
  
  return new Promise<void>((resolve, reject) => {
    const env = {
      ...process.env,
      OU_MULTI_REGION: '0', // Single region for this test
      OU_LAT: '32.7157',
      OU_LNG: '-117.1611',
      OU_RADIUS_MILES: '200',
      
      OU_SEARCH_QUERY: 'car truck suv', // Broad query
      OU_FILTER_MIN_PRICE: '12000',
      OU_FILTER_POSTED_WITHIN_HOURS: '1',
      OU_FILTER_DEALERS: 'true',
      OU_TARGET_INSERT_COUNT: '35',
      OU_LOG_LEVEL: 'info',
      // Deep mining settings
      OU_MAX_ITEMS: '800',
      OU_PAGINATE_PAGES: '20',
    };

    const child = spawn(TSX_PATH, [SCRIPT_PATH], { 
      env, 
      stdio: 'inherit' 
    });

    // 15 Minute Timeout
    const timeout = setTimeout(() => {
      console.log('\n[TEST-WRAPPER] 15 minute timeout reached. Killing script...');
      child.kill('SIGTERM');
      reject(new Error('Timeout reached'));
    }, 15 * 60 * 1000);

    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        console.log(`\n>>> FINISHED SD HOURLY TEST <<<\n`);
        resolve();
      } else {
        console.error(`\n>>> FAILED SD HOURLY TEST (exit code ${code}) <<<\n`);
        reject(new Error(`Exit code ${code}`));
      }
    });
  });
}

runSDHourlyTest().catch(console.error);

