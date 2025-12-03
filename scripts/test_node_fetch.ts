// Test Node.js built-in fetch
console.log('Testing Node.js fetch...');
console.log('Fetch available:', typeof fetch);

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE;

if (!url || !key) {
  console.error('Missing env');
  process.exit(1);
}

const testUrl = `${url}/rest/v1/offerup_jobs?select=*&status=eq.pending&limit=1`;

(async () => {
  try {
    console.log('Fetching:', testUrl);
    const res = await fetch(testUrl, {
      headers: {
        'apikey': key,
        'Authorization': `Bearer ${key}`
      }
    });
    console.log('Success! Status:', res.status);
    const data = await res.json();
    console.log('Data:', data);
  } catch (e: any) {
    console.error('Fetch failed:', e.message);
    console.error('Error code:', e.code);
    console.error('Error cause:', e.cause);
    console.error('Full error:', e);
  }
})();
