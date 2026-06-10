/**
 * SiteSawa — one-time migration: base64 images → Cloudinary
 * Run ONCE after deploying the Cloudinary changes:
 *   node migrate-images.js
 *
 * Safe to re-run: skips any field that's already a URL.
 * Logs every customer it touches.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const cloudinary = require('cloudinary').v2;
// CLOUDINARY_URL is read automatically from process.env

async function up(value, folder) {
    if (!value || !value.startsWith('data:image/')) return value;
    const r = await cloudinary.uploader.upload(value, {
        folder,
        transformation: [
            { width: 1200, crop: 'limit' },
            { quality: 'auto:good' },
            { fetch_format: 'auto' },
        ],
    });
    return r.secure_url;
}

async function main() {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/sitesawa');
    const Customer = mongoose.connection.collection('customers');
    const all = await Customer.find({}).toArray();
    console.log(`Found ${all.length} customers\n`);

    let migrated = 0;
    for (const c of all) {
        const d = c.data || {};
        let changed = false;

        // Single image fields
        for (const f of ['logo','heroImage','aboutImage','storyImage','agentImage','avatarImage']) {
            if (d[f]?.startsWith('data:')) {
                try {
                    d[f] = await up(d[f], 'sitesawa/content');
                    changed = true;
                } catch (e) { console.error(`  ⚠ ${f} failed:`, e.message); }
            }
        }

        // Product images
        if (Array.isArray(d.products)) {
            for (const p of d.products) {
                if (p.image?.startsWith('data:')) {
                    try {
                        p.image = await up(p.image, 'sitesawa/products');
                        changed = true;
                    } catch (e) { console.error(`  ⚠ product image failed:`, e.message); }
                }
            }
        }

        // Gallery
        if (Array.isArray(d.galleryImages)) {
            for (let i = 0; i < d.galleryImages.length; i++) {
                if (d.galleryImages[i]?.startsWith('data:')) {
                    try {
                        d.galleryImages[i] = await up(d.galleryImages[i], 'sitesawa/gallery');
                        changed = true;
                    } catch (e) { console.error(`  ⚠ gallery[${i}] failed:`, e.message); }
                }
            }
        }

        if (changed) {
            await Customer.updateOne({ _id: c._id }, { $set: { data: d } });
            console.log(`✅ ${c.phone || c._id}`);
            migrated++;
        }
    }

    console.log(`\nDone — migrated ${migrated}/${all.length} customers`);
    process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
