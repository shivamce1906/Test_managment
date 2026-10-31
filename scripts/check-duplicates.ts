/**
 * Read-only check before building indexes on a real database (report #3).
 *
 * For every unique index declared on the models it reports whether the index already exists and
 * which duplicate values (if any) would make building it fail. Nothing is written.
 *
 *   npx tsx scripts/check-duplicates.ts
 *
 * When it reports no duplicates, build the indexes with:  npx tsx scripts/build-indexes.ts
 */
import '../src/config/env';
import mongoose from 'mongoose';
import { env } from '../src/config';
import '../src/models';

async function main() {
  // Connect directly (not via connectDb) so DB_AUTO_INDEX can never build anything here
  await mongoose.connect(env.MONGODB_URI, { autoIndex: false, serverSelectionTimeoutMS: 30000 });
  console.log(`Connected to ${mongoose.connection.host}/${mongoose.connection.name} (read-only check)\n`);

  let blocking = 0;
  let missing = 0;

  for (const name of mongoose.modelNames().sort()) {
    const model = mongoose.model(name);
    const unique = model.schema.indexes().filter(([, opts]) => opts?.unique);
    if (unique.length === 0) continue;

    const existing = await model.collection.indexes().catch(() => [] as any[]);

    for (const [keys, opts] of unique) {
      const label = `${model.collection.name} ${JSON.stringify(keys)}${opts.partialFilterExpression ? ' (partial)' : ''}${opts.sparse ? ' (sparse)' : ''}`;
      const exists = existing.some((i: any) => i.unique && JSON.stringify(i.key) === JSON.stringify(keys));

      const match: Record<string, unknown> = { ...(opts.partialFilterExpression || {}) };
      if (opts.sparse) for (const k of Object.keys(keys)) match[k] = { $exists: true };
      const group: Record<string, string> = {};
      for (const k of Object.keys(keys)) group[k.replace(/\./g, '_')] = `$${k}`;

      const dups = await model.collection
        .aggregate([
          { $match: match },
          { $group: { _id: group, count: { $sum: 1 }, ids: { $push: '$_id' } } },
          { $match: { count: { $gt: 1 } } },
          { $limit: 20 },
        ])
        .toArray();

      if (!exists) missing++;
      if (dups.length > 0) blocking++;
      const state = exists ? 'exists ' : 'MISSING';
      console.log(`${state}  ${label}${dups.length ? `  → ${dups.length} duplicate group(s) BLOCK the build` : ''}`);
      for (const d of dups) {
        console.log(`           ${JSON.stringify(d._id)} ×${d.count}  ids: ${d.ids.slice(0, 5).join(', ')}`);
      }
    }
  }

  console.log(`\nMissing unique indexes: ${missing}. Indexes blocked by duplicates: ${blocking}.`);
  console.log(blocking === 0 ? 'Safe to build: npx tsx scripts/build-indexes.ts' : 'Resolve the duplicates above before building.');
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
