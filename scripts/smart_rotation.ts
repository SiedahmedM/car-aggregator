
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

async function runScraper(region: {name: string, lat: string, lng: string}, make: string): Promise<number> {
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
      OU_DETAIL_CONCURRENCY: '1', // Concurrency 1 for stability
      OU_HEADLESS: 'true',
      OU_LOG_LEVEL: 'info',
    };

    const child = spawn('npx', ['tsx', './scripts/offerup.ts'], { 
      env, 
      stdio: ['ignore', 'pipe', 'inherit'], // Capture stdout to parse
      shell: true
    });

    let stdoutData = '';

    child.stdout?.on('data', (data) => {
      const chunk = data.toString();
      stdoutData += chunk;
      // Avoid direct pipe to process.stdout to prevent EPIPE
      // process.stdout.write(chunk); 
      // Instead, just log key info if needed or rely on final summary
      if (chunk.includes('[INFO]') || chunk.includes('[WARN]') || chunk.includes('[ERROR]')) {
          console.log(chunk.trim());
      }
    });

    child.on('close', (code) => {
      if (code !== 0) {
        console.error(`Script exited with code ${code}`);
        resolve(0);
        return;
      }

      // Parse inserted count
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
    
    child.on('error', (err) => {
        console.error("Spawn error:", err);
        resolve(0);
    });
  });
}

// Helper to get random regions excluding the current one
function getOtherRegions(currentRegionName: string, count: number): typeof REGIONS {
  const others = REGIONS.filter(r => r.name !== currentRegionName);
  const shuffled = others.sort(() => 0.5 - Math.random());
  return shuffled.slice(0, count);
}

async function main() {
  let totalInserted = 0;
  
  // Start with Jeep since it was successful
  // Then shuffle the rest
  const initialMake = 'Jeep';
  const remainingMakes = MAKES.filter(m => m !== initialMake).sort(() => 0.5 - Math.random());
  const makeQueue = [initialMake, ...remainingMakes];

  for (const make of makeQueue) {
    if (totalInserted >= TARGET_INSERTIONS) {
      console.log(`\n>>> TARGET REACHED: ${totalInserted} listings inserted. Stopping. <<<`);
      break;
    }

    // Pick a random region to start for this make
    const startRegion = REGIONS[Math.floor(Math.random() * REGIONS.length)];
    
    const inserted = await runScraper(startRegion, make);
    totalInserted += inserted;
    
    console.log(`\n[RESULT] ${make} in ${startRegion.name}: ${inserted} inserted.`);

    if (inserted > 0) {
        console.log(`\n>>> SUCCESS! Retrying ${make} in 2 other regions... <<<`);
        const retryRegions = getOtherRegions(startRegion.name, 2);
        
        for (const rr of retryRegions) {
            if (totalInserted >= TARGET_INSERTIONS) break;
            
            // Wait briefly
            await new Promise(r => setTimeout(r, 3000));
            
            const retryInserted = await runScraper(rr, make);
            totalInserted += retryInserted;
            console.log(`\n[RETRY RESULT] ${make} in ${rr.name}: ${retryInserted} inserted.`);
        }
    } else {
        console.log(`\n[SKIP] No results for ${make} in ${startRegion.name}. Switching makes.`);
    }

    // Cool down between makes
    await new Promise(r => setTimeout(r, 2000));
  }
}

main().catch(console.error);
