
import { spawn } from 'node:child_process';
import path from 'node:path';

// Target: 30 total listings inserted
const TARGET_INSERTIONS = 30;

// Configurations
const REGIONS = [
  { name: 'Irvine', lat: '33.6846', lng: '-117.8265' },
  { name: 'Torrance', lat: '33.8358', lng: '-118.3406' },
  { name: 'Fullerton', lat: '33.8704', lng: '-117.9242' },
  { name: 'Huntington Beach', lat: '33.6595', lng: '-117.9988' },
  { name: 'Mission Viejo', lat: '33.6000', lng: '-117.6719' },
  { name: 'Santa Ana', lat: '33.7455', lng: '-117.8677' },
];

const MAKE_MODELS = [
  { make: 'honda', models: 'civic,accord' },
  { make: 'toyota', models: 'camry,corolla,tacoma' },
  { make: 'nissan', models: 'altima,sentra' },
  { make: 'ford', models: 'f150,mustang' },
  { make: 'bmw', models: '328,335,m3' },
  { make: 'mercedes', models: 'c300,e350' },
  { make: 'chevrolet', models: 'silverado,camaro' },
  { make: 'jeep', models: 'wrangler,grand cherokee' },
  { make: 'dodge', models: 'charger,challenger' },
];

async function runScraper(region: {name: string, lat: string, lng: string}, car: {make: string, models: string}): Promise<number> {
  return new Promise((resolve, reject) => {
    console.log(`\n>>> RUNNING: ${region.name} | ${car.make} (${car.models}) <<<`);
    
    const env = {
      ...process.env,
      OU_MULTI_REGION: '0',
      OU_LAT: region.lat,
      OU_LNG: region.lng,
      OU_RADIUS_MILES: '10', // Tight radius for fresh feeds
      OU_FILTER_MAKES: car.make,
      OU_FILTER_MODELS: car.models,
      OU_FILTER_POSTED_WITHIN_HOURS: '1',
      OU_DETAIL_CONCURRENCY: '1',
      OU_HEADLESS: 'true',
      OU_LOG_LEVEL: 'info',
    };

    // Use tsx to run the typescript file directly
    const child = spawn('npx', ['tsx', './scripts/offerup.ts'], { 
      env, 
      stdio: ['ignore', 'pipe', 'inherit'], // Capture stdout to parse results
      shell: true
    });

    let stdoutData = '';

    child.stdout?.on('data', (data) => {
      const chunk = data.toString();
      stdoutData += chunk;
      process.stdout.write(chunk); // Passthrough to console
    });

    child.on('close', (code) => {
      if (code !== 0) {
        console.error(`Script exited with code ${code}`);
        resolve(0); // Treat error as 0 inserted to keep loop going or handle as failure
        return;
      }

      // Parse output for inserted count
      // Look for JSON: {"ok":true,"inserted":0,"skipped":23,"errors":0}
      const lines = stdoutData.split('\n');
      let inserted = 0;
      for (const line of lines) {
        try {
          if (line.trim().startsWith('{') && line.includes('"inserted"')) {
            const json = JSON.parse(line.trim());
            if (typeof json.inserted === 'number') {
              inserted = json.inserted;
            }
          }
        } catch (e) {
          // ignore
        }
      }
      resolve(inserted);
    });
  });
}

async function main() {
  let totalInserted = 0;
  let consecutiveZeroRuns = 0;
  
  // Create a randomized queue of tasks (region x car combinations)
  const tasks: {region: typeof REGIONS[0], car: typeof MAKE_MODELS[0]}[] = [];
  for (const region of REGIONS) {
    for (const car of MAKE_MODELS) {
      tasks.push({ region, car });
    }
  }
  
  // Shuffle tasks
  tasks.sort(() => Math.random() - 0.5);

  for (const task of tasks) {
    if (totalInserted >= TARGET_INSERTIONS) {
      console.log(`\n>>> TARGET REACHED: ${totalInserted} listings inserted. Stopping. <<<`);
      break;
    }

    if (consecutiveZeroRuns >= 3) {
      console.log(`\n>>> 3 CONSECUTIVE RUNS WITH 0 RESULTS. STOPPING TO TRY NEW APPROACH. <<<`);
      process.exit(1); // Exit with error code to signal caller
    }

    const inserted = await runScraper(task.region, task.car);
    totalInserted += inserted;

    if (inserted === 0) {
      consecutiveZeroRuns++;
    } else {
      consecutiveZeroRuns = 0; // Reset counter on success
    }

    console.log(`\n[PROGRESS] Total Inserted: ${totalInserted}/${TARGET_INSERTIONS} | Consecutive Zeros: ${consecutiveZeroRuns}`);
    
    // Cool down
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
}

main().catch(console.error);
