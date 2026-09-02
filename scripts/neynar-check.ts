/**
 * Verify the Neynar credentials and the mention feed before anything is sent.
 *
 * Read-only: it fetches, prints and exits. Worth running first because two of
 * the three failure modes here are silent — a signer that exists but is not
 * approved only fails at the moment of the first cast, and a mention feed with
 * an unexpected shape yields zero mentions rather than an error.
 *
 *   npm run neynar:check
 */
const key = process.env.NEYNAR_API_KEY?.trim();
const signer = process.env.NEYNAR_SIGNER_UUID?.trim();
const fid = process.env.NEYNAR_AGENT_FID?.trim();

const get = async (path: string): Promise<{ status: number; body: unknown }> => {
  const res = await fetch(`https://api.neynar.com${path}`, {
    headers: { 'x-api-key': key!, accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return { status: res.status, body: text.slice(0, 200) };
  }
};

console.log(`api key   : ${key ? `set (${key.slice(0, 4)}…)` : 'MISSING'}`);
console.log(`signer    : ${signer ? `set (${signer.slice(0, 8)}…)` : 'MISSING'}`);
console.log(`agent fid : ${fid ?? 'MISSING'}`);
if (!key) process.exit(1);

console.log('\n--- signer ---');
if (signer) {
  const r = await get(`/v2/farcaster/signer/?signer_uuid=${encodeURIComponent(signer)}`);
  const b = r.body as { status?: string; fid?: number; message?: string };
  if (r.status === 200) {
    console.log(`  status ${b.status ?? '?'} | fid ${b.fid ?? '?'}`);
    if (b.status !== 'approved') {
      console.log('  NOT APPROVED — casts will fail until this signer is approved.');
    }
    if (fid && b.fid !== undefined && String(b.fid) !== fid) {
      console.log(`  MISMATCH: signer belongs to fid ${b.fid}, NEYNAR_AGENT_FID is ${fid}.`);
      console.log('  Replies would come from a different account than the one being watched.');
    }
  } else {
    console.log(`  HTTP ${r.status}: ${b.message ?? JSON.stringify(r.body).slice(0, 160)}`);
  }
}

console.log('\n--- mentions feed ---');
if (fid) {
  const r = await get(`/v2/farcaster/notifications/?fid=${fid}&type=mentions&limit=5`);
  if (r.status !== 200) {
    const b = r.body as { message?: string };
    console.log(`  HTTP ${r.status}: ${b.message ?? JSON.stringify(r.body).slice(0, 200)}`);
    console.log('  The mention path is what this endpoint feeds; fix before enabling autonomy.');
  } else {
    const b = r.body as { notifications?: Array<Record<string, unknown>> };
    const list = b.notifications ?? [];
    console.log(`  ${list.length} notification(s)`);
    // Print the shape rather than assume it: this is the field mapping
    // mentions.ts depends on, and it is the one thing not verified against a
    // published spec.
    if (list.length > 0) {
      console.log(`  top-level keys: ${Object.keys(list[0]!).join(', ')}`);
      const cast = (list[0] as { cast?: Record<string, unknown> }).cast;
      console.log(
        cast
          ? `  cast keys     : ${Object.keys(cast).join(', ')}`
          : '  NO `cast` KEY — mentions.ts expects notifications[].cast and would find nothing.',
      );
    } else {
      console.log('  (none yet — tag the agent once, then re-run)');
    }
  }
}
