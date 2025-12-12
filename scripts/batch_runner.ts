
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

const TARGET_INSERTIONS = 30;
const LOCATION = {
  OU_LAT: '33.6846',
  OU_LNG: '-117.8265', // Irvine/South OC
  OU_RADIUS_MILES: '60'
};

const BATCHES = [
  { make: 'toyota', models: 'camry,corolla,prius,rav4,highlander' },
  { make: 'ford', models: 'f150,mustang,explorer,focus,fusion' },
  { make: 'chevrolet', models: 'silverado,camaro,malibu,tahoe,impala' },
  { make: 'nissan', models: 'altima,sentra,rogue,maxima' },
  { make: 'honda', models: 'civic,accord,cr-v,pilot,odyssey' },
  { make: 'jeep', models: 'wrangler,grand cherokee,cherokee' },
  { make: 'dodge', models: 'charger,challenger,ram,durango' },
  { make: 'mercedes', models: 'c300,e350,glc300,s550' },
  { make: 'lexus', models: 'is250,is350,es350,rx350' },
  { make: 'audi', models: 'a3,a4,a6,q5' },
  { make: 'hyundai', models: 'elantra,sonata,tucson' },
  { make: 'kia', models: 'optima,soul,sorento' },
  { make: 'subaru', models: 'wrx,forester,outback,impreza' },
  { make: 'volkswagen', models: 'jetta,golf,passat' },
  { make: 'tesla', models: 'model 3,model y,model s' }
];

async function runBatch() {
  let totalInserted = 0;
  
  console.log(`Starting batch run. Target: ${TARGET_INSERTIONS} listings.`);

  for (const batch of BATCHES) {
    if (totalInserted >= TARGET_INSERTIONS) {
      console.log(`\nTarget reached! Total inserted: ${totalInserted}`);
      break;
    }

    console.log(`\nRunning for ${batch.make} [${batch.models}]...`);
    
    const env = {
      ...process.env,
      ...LOCATION,
      OU_FILTER_MAKES: batch.make,
      OU_FILTER_MODELS: batch.models,
      OU_FILTER_POSTED_WITHIN_HOURS: '1',
      OU_DETAIL_CONCURRENCY: '1',
      OU_HEADLESS: 'true'
    };

    const cmd = `OU_FILTER_MAKES=${batch.make} OU_FILTER_MODELS=${batch.models} npm run offerup`;
    
    try {
      const { stdout, stderr } = await execAsync(cmd, { env, maxBuffer: 1024 * 1024 * 10 });
      
      const lines = stdout.split('\n');
      let insertedInRun = 0;
      let summaryLog = null;
      let finalJson = null;

      for (const line of lines) {
        if (line.includes('[RUN-SUMMARY]')) {
             try {
                 const part = line.split('[RUN-SUMMARY]')[1].trim();
                 summaryLog = JSON.parse(part);
             } catch {}
        }
        if (line.trim().startsWith('{') && line.includes('"inserted"')) {
          try {
             finalJson = JSON.parse(line);
             if (typeof finalJson.inserted === 'number') insertedInRun = finalJson.inserted;
          } catch {}
        }
      }

      console.log(`Run complete. Inserted: ${insertedInRun}`);
      if (summaryLog) {
          console.log(`Stats: Feed=${summaryLog.feedCount}, Detail=${summaryLog.detailEnrichedCount}, Kept=${summaryLog.postedKept}, Rejected=${summaryLog.postedRejected}, MissingTS=${summaryLog.missingTimestamp}`);
      }
      
      totalInserted += insertedInRun;
      console.log(`Total progress: ${totalInserted}/${TARGET_INSERTIONS}`);

    } catch (error) {
      console.error(`Error running batch for ${batch.make}:`, error.message);
    }
    
    await new Promise(r => setTimeout(r, 2000));
  }

  if (totalInserted < TARGET_INSERTIONS) {
    console.log(`\nFinished all batches but only reached ${totalInserted}/${TARGET_INSERTIONS} listings.`);
  }
}

runBatch();
