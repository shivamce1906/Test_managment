/**
 * Builds every index declared on the models that is missing (report #3). It drops only the
 * indexes listed in OBSOLETE (replaced by a corrected definition), never any other index.
 * Run scripts/check-duplicates.ts first: a unique index cannot be built over duplicate values.
 *
 *   npx tsx scripts/build-indexes.ts
 *
 * Afterwards set DB_AUTO_INDEX=true so new deployments create indexes on startup.
 */
import '../src/config/env';
import mongoose from 'mongoose';
import { env, ensureIndexes } from '../src/config';
import '../src/models';

/** Indexes whose definition was wrong and has been replaced in the schema. */
const OBSOLETE = [
  // Compound + sparse still indexed every plan with voucherCode null: one non-voucher plan per business.
  // Replaced by businessId_1_voucherCode_1_partial (unique where voucherCode is a string).
  { collection: 'customerPlans', name: 'businessId_1_voucherCode_1' },
];

async function main() {
  await mongoose.connect(env.MONGODB_URI, { autoIndex: false, serverSelectionTimeoutMS: 30000 });
  console.log(`Connected to ${mongoose.connection.host}/${mongoose.connection.name}\n`);

  for (const { collection, name } of OBSOLETE) {
    const existing = await mongoose.connection.db!.collection(collection).indexes().catch(() => [] as any[]);
    if (existing.some((i: any) => i.name === name)) {
      await mongoose.connection.db!.collection(collection).dropIndex(name);
      console.log(`dropped ${collection}.${name} (obsolete)`);
    }
  }

  const results = await ensureIndexes();
  for (const r of results) console.log(`${r.error ? 'FAILED ' : 'ok     '} ${r.model}${r.error ? `  ${r.error}` : ''}`);
  const failed = results.filter((r) => r.error).length;
  console.log(`\n${results.length - failed}/${results.length} collections indexed.`);
  if (failed) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
    process.exit();
  });
