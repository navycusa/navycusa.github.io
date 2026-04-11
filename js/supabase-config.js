// ============================================================
// US NAVY CUSA PORTAL — Supabase Configuration
// Used for: proof image uploads on activity logs
// ============================================================
// Setup:
//   1. Go to supabase.com → New project
//   2. Go to Storage → New bucket → name it "proof-images"
//      Set bucket to PUBLIC (so images can be viewed without auth)
//   3. Go to Project Settings → API
//      Copy "Project URL" and "anon public" key below
// ============================================================

const SUPABASE_URL     = 'YOUR_SUPABASE_PROJECT_URL';
const SUPABASE_ANON_KEY = 'YOUR_SUPABASE_ANON_KEY';

const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ── Upload a proof image and return its public URL ───────────
async function uploadProofImage(file, uid) {
  const maxMB = 5;
  if (file.size > maxMB * 1024 * 1024) {
    throw new Error(`Image must be under ${maxMB} MB.`);
  }

  const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  if (!allowed.includes(file.type)) {
    throw new Error('Only JPEG, PNG, GIF, and WebP images are allowed.');
  }

  const ext  = file.name.split('.').pop().toLowerCase();
  const path = `proofs/${uid}/${Date.now()}.${ext}`;

  const { error } = await supabaseClient.storage
    .from('proof-images')
    .upload(path, file, { cacheControl: '3600', upsert: false });

  if (error) throw new Error('Image upload failed: ' + error.message);

  const { data } = supabaseClient.storage
    .from('proof-images')
    .getPublicUrl(path);

  return data.publicUrl;
}
