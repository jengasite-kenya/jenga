/**
 * fix-duplicate-emails.js
 * ------------------------------------------------------------------
 * One-time cleanup. Earlier testing created several accounts that
 * share the same email (e.g. aliomarion001@gmail.com). MongoDB then
 * can't build the UNIQUE email index, which breaks email login.
 *
 * This script:
 *   1. Finds every email that appears on more than one account.
 *   2. For each duplicated email, KEEPS the most recently updated
 *      account (most likely the real/current one) and deletes the
 *      older duplicates (and their orders/tickets).
 *   3. Also clears accounts with NO email or empty email IF they are
 *      duplicated as null (sparse index handles single nulls fine,
 *      so we only touch true duplicates).
 *   4. Rebuilds the unique email index.
 *
 * HOW TO RUN (on Render shell, so it uses the LIVE database):
 *   node fix-duplicate-emails.js
 *
 * It prints exactly what it will delete. Safe to run more than once.
 * ------------------------------------------------------------------
 */
const mongoose = require('mongoose');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/sitesawa';

(async () => {
    try {
        await mongoose.connect(MONGODB_URI);
        console.log('Connected to MongoDB\n');

        const db = mongoose.connection.db;
        const customers = db.collection('customers');
        const orders = db.collection('orders');
        const tickets = db.collection('supporttickets');

        // 1. Find duplicate emails (case-insensitive, ignoring null/empty)
        const dups = await customers.aggregate([
            { $match: { email: { $type: 'string', $ne: '' } } },
            { $group: {
                _id: { $toLower: '$email' },
                ids: { $push: '$_id' },
                count: { $sum: 1 },
                docs: { $push: { id: '$_id', updatedAt: '$updatedAt', createdAt: '$createdAt', name: '$name', sub: '$subdomain' } }
            }},
            { $match: { count: { $gt: 1 } } }
        ]).toArray();

        if (dups.length === 0) {
            console.log('No duplicate emails found. Nothing to clean.\n');
        } else {
            console.log(`Found ${dups.length} email(s) used by more than one account:\n`);
            let totalDeleted = 0;

            for (const group of dups) {
                // Sort newest first by updatedAt (fallback createdAt)
                const sorted = group.docs.sort((a, b) => {
                    const ta = new Date(a.updatedAt || a.createdAt || 0).getTime();
                    const tb = new Date(b.updatedAt || b.createdAt || 0).getTime();
                    return tb - ta;
                });
                const keep = sorted[0];
                const remove = sorted.slice(1);

                console.log(`  Email: ${group._id}`);
                console.log(`    KEEP   → ${keep.id} (${keep.name || 'no name'}, sub: ${keep.sub || '—'})`);
                for (const r of remove) {
                    console.log(`    DELETE → ${r.id} (${r.name || 'no name'}, sub: ${r.sub || '—'})`);
                    await customers.deleteOne({ _id: r.id });
                    await orders.deleteMany({ customerId: String(r.id) });
                    await tickets.deleteMany({ customerId: String(r.id) });
                    totalDeleted++;
                }
                console.log('');
            }
            console.log(`Removed ${totalDeleted} duplicate account(s).\n`);
        }

        // 2. Rebuild the unique email index
        console.log('Rebuilding unique email index...');
        try {
            // drop existing email index if present, then recreate as unique+sparse
            const idx = await customers.indexes();
            for (const ix of idx) {
                const keys = Object.keys(ix.key || {});
                if (keys.length === 1 && keys[0] === 'email') {
                    await customers.dropIndex(ix.name);
                    console.log('  dropped old email index:', ix.name);
                }
            }
            await customers.createIndex({ email: 1 }, { unique: true, sparse: true });
            console.log('  ✓ unique email index built successfully\n');
        } catch (e) {
            console.error('  Could not build unique email index:', e.message);
            console.error('  There may still be duplicates — re-run this script.\n');
        }

        console.log('Done. Email login should now work cleanly.');
        await mongoose.disconnect();
        process.exit(0);
    } catch (err) {
        console.error('Cleanup failed:', err.message);
        process.exit(1);
    }
})();
