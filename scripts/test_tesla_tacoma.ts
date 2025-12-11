import { spawn } from 'node:child_process';
import path from 'node:path';

const JOBS = [
  { 
    name: "Tesla (Any Model)",
    query: "tesla", 
    make: "tesla", 
    model: "", // Any model
    hours: 2 
  },
  { 
    name: "Toyota Tacoma",
    query: "toyota tacoma", 
    make: "toyota", 
    model: "tacoma",
    hours: 2 
  }
];

const SCRIPT_PATH = path.join(process.cwd(), 'scripts', 'offerup.ts');
const TSX_PATH = path.join(process.cwd(), 'node_modules', '.bin', 'tsx');

async function runJob(job: any) {
  console.log(`\n>>> STARTING SEARCH FOR: "${job.name}" (Query: ${job.query}, Make: ${job.make}, Model: ${job.model || 'Any'}, Recency: ${job.hours}h) <<<\n`);
  
  return new Promise<void>((resolve, reject) => {
    const env = {
      ...process.env,
      OU_MULTI_REGION: '1',
      OU_REGION_COUNT: '7', // 7 regions within 500mi of LA
      OU_SEARCH_QUERY: job.query,
      OU_FILTER_MAKES: job.make,
      OU_FILTER_MODELS: job.model,
      OU_FILTER_POSTED_WITHIN_HOURS: String(job.hours),
      OU_FILTER_DEALERS: 'true', // Filter OUT dealers
      OU_FILTER_MIN_PRICE: '2000', // Basic floor to avoid parts
      OU_LOG_LEVEL: 'info',
      OU_MAX_ITEMS: '100' // Cap per region per job
    };

    const child = spawn(TSX_PATH, [SCRIPT_PATH], { 
      env, 
      stdio: 'inherit' 
    });

    child.on('close', (code) => {
      if (code === 0) {
        console.log(`\n>>> FINISHED SEARCH FOR: "${job.name}" <<<\n`);
        resolve();
      } else {
        console.error(`\n>>> FAILED SEARCH FOR: "${job.name}" (exit code ${code}) <<<\n`);
        reject(new Error(`Exit code ${code}`));
      }
    });
  });
}

async function main() {
  console.log('Starting Tesla & Tacoma (Private, 2h) run...');
  
  for (const job of JOBS) {
    try {
      await runJob(job);
      // specific delay between queries to be nice
      await new Promise(r => setTimeout(r, 5000));
    } catch (e) {
      console.error(e);
    }
  }
  
  console.log('All queries completed.');
}

main();
