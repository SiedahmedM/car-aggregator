
import { spawn } from 'node:child_process';

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
  { name: 'Long Beach', lat: '33.7701', lng: '-118.1937' },
  { name: 'Anaheim', lat: '33.8366', lng: '-117.9143' },
  { name: 'Riverside', lat: '33.9806', lng: '-117.3755' },
  { name: 'San Diego', lat: '32.7157', lng: '-117.1611' },
];

// Broad searches (Makes only) to maximize hits
const MAKES = [
  'Honda',
  'Toyota',
  'Nissan',
  'Ford',
  'BMW',
  'Mercedes',
  'Chevrolet',
  'Jeep',
  'Dodge',
  'Lexus',
  'Audi',
  'Hyundai',
  'Kia',
  'Subaru',
  'Volkswagen'
];

async function runScraper(region: {name: string, lat: string, lng: string}, make: string): Promise<number> {
  return new Promise((resolve, reject) => {
    console.log(`\n>>> RUNNING: ${region.name} | ${make} (Broad Search) <<<`);
    
    const env = {
      ...process.env,
      OU_MULTI_REGION: '0',
      OU_LAT: region.lat,
      OU_LNG: region.lng,
      OU_RADIUS_MILES: '20', // Increased radius
      OU_FILTER_MAKES: make,
      OU_FILTER_MODELS: '', // No specific models, accept all
      OU_SEARCH_QUERY: make, // Force broad query
      OU_FILTER_POSTED_WITHIN_HOURS: '1',
      OU_DETAIL_CONCURRENCY: '2',
      OU_HEADLESS: 'true',
      OU_LOG_LEVEL: 'info',
    };

    const child = spawn('npx', ['tsx', './scripts/offerup.ts'], { 
      env, 
      stdio: ['ignore', 'pipe', 'inherit'],
      shell: true
    });

    let stdoutData = '';

    child.stdout?.on('data', (data) => {
      const chunk = data.toString();
      stdoutData += chunk;
      process.stdout.write(chunk);
    });

    child.on('close', (code) => {
      if (code !== 0) {
        console.error(`Script exited with code ${code}`);
        resolve(0); 
        return;
      }

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
  
  // Create tasks: Random region + Random make
  const tasks: {region: typeof REGIONS[0], make: string}[] = [];
  
  // Generate a large queue of random tasks
  for (let i = 0; i < 50; i++) {
    const region = REGIONS[Math.floor(Math.random() * REGIONS.length)];
    const make = MAKES[Math.floor(Math.random() * MAKES.length)];
    tasks.push({ region, make });
  }

  for (const task of tasks) {
    if (totalInserted >= TARGET_INSERTIONS) {
      console.log(`\n>>> TARGET REACHED: ${totalInserted} listings inserted. Stopping. <<<`);
      break;
    }

    if (consecutiveZeroRuns >= 3) {
      console.log(`\n>>> 3 CONSECUTIVE RUNS WITH 0 RESULTS. STOPPING TO TRY NEW APPROACH. <<<`);
      process.exit(1);
    }

    const inserted = await runScraper(task.region, task.make);
    totalInserted += inserted;

    if (inserted === 0) {
      consecutiveZeroRuns++;
    } else {
      consecutiveZeroRuns = 0;
    }

    console.log(`\n[PROGRESS] Total Inserted: ${totalInserted}/${TARGET_INSERTIONS} | Consecutive Zeros: ${consecutiveZeroRuns}`);
    
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
}

main().catch(console.error);
