
import { spawn } from 'node:child_process';

const TARGET_INSERTIONS = 30;

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

const MAKES = [
  'Honda', 'Toyota', 'Nissan', 'Ford', 'BMW', 
  'Mercedes', 'Chevrolet', 'Jeep', 'Dodge', 'Lexus', 
  'Audi', 'Hyundai', 'Kia', 'Subaru', 'Volkswagen'
];

async function runScraper(region: {name: string, lat: string, lng: string}, make: string): Promise<void> {
  return new Promise((resolve) => {
    console.log(`\n>>> RUNNING: ${region.name} | ${make} (Broad Search) <<<`);
    
    const env = {
      ...process.env,
      OU_MULTI_REGION: '0',
      OU_LAT: region.lat,
      OU_LNG: region.lng,
      OU_RADIUS_MILES: '20',
      OU_FILTER_MAKES: make,
      OU_FILTER_MODELS: '',
      OU_SEARCH_QUERY: make,
      OU_FILTER_POSTED_WITHIN_HOURS: '1',
      OU_DETAIL_CONCURRENCY: '1',
      OU_HEADLESS: 'true',
      OU_LOG_LEVEL: 'info',
    };

    // Use inherit to see output, but catch errors to prevent crash
    const child = spawn('npx', ['tsx', './scripts/offerup.ts'], { 
      env, 
      stdio: 'inherit',
      shell: true
    });

    child.on('close', () => {
      resolve();
    });
    
    child.on('error', () => {
        resolve();
    })
  });
}

async function main() {
  const tasks: {region: typeof REGIONS[0], make: string}[] = [];
  for (let i = 0; i < 50; i++) {
    const region = REGIONS[Math.floor(Math.random() * REGIONS.length)];
    const make = MAKES[Math.floor(Math.random() * MAKES.length)];
    tasks.push({ region, make });
  }

  for (const task of tasks) {
    try {
        await runScraper(task.region, task.make);
    } catch (e) {
        console.log("Error in run:", e);
    }
    // Wait 2s
    await new Promise(r => setTimeout(r, 2000));
  }
}

main().catch(console.error);
