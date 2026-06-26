/**
 * seed-demo-accounts.js  —  ONE-TIME demo account creator
 * ─────────────────────────────────────────────────────────────
 * Creates three SiteSawa accounts (one per plan) so the owner can
 * log in and demo each plan's dashboard. All three use the passkey
 * MARION01 and share one inbox via Gmail "+tags".
 *
 * HOW TO RUN (once, after the server is deployed):
 *   1. Make sure MONGODB_URI is set in your environment
 *      (same value Render uses).
 *   2. From the project root:  node seed-demo-accounts.js
 *
 * It is SAFE to run more than once — if an account already exists
 * it is updated (passkey reset to MARION01) rather than duplicated.
 *
 * LOGIN AFTER RUNNING:
 *   Personal    →  aliomarion001+personal@gmail.com    key: MARION01
 *   Business    →  aliomarion001+business@gmail.com    key: MARION01
 *   E-Commerce  →  aliomarion001+ecommerce@gmail.com   key: MARION01
 *
 * (All three emails deliver to aliomarion001@gmail.com)
 */

const mongoose = require('mongoose');
const bcrypt   = require('bcryptjs');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/sitesawa';
const PASSKEY     = 'MARION01';
const BASE_EMAIL  = 'aliomarion001';
const DEMO_PHONE  = '254717806917'; // any number — phone is no longer unique

// Minimal Customer model matching the live schema's required fields.
const Customer = mongoose.model('Customer', new mongoose.Schema({
    name: String,
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    phone: { type: String, required: true },
    secretKey: { type: String, required: true },
    template: { type: String, enum: ['PERSONAL', 'BUSINESS', 'ECOMMERCE'], default: 'PERSONAL' },
    subdomain: { type: String, unique: true, sparse: true, index: true },
    templateId: { type: String, default: '' },
    createdAt: { type: Date, default: Date.now },
    isAdmin: { type: Boolean, default: false },
    paymentStatus: { type: String, default: 'pending' },
}, { strict: false }));

const DEMOS = [
    { plan: 'PERSONAL',   tag: 'personal',   name: 'Demo Personal',   sub: 'demo-personal' },
    { plan: 'BUSINESS',   tag: 'business',   name: 'Demo Business',   sub: 'demo-business' },
    { plan: 'ECOMMERCE',  tag: 'ecommerce',  name: 'Demo Ecommerce',  sub: 'demo-ecommerce' },
];

(async () => {
    try {
        await mongoose.connect(MONGODB_URI);
        console.log('Connected to MongoDB\n');

        const hashedKey = await bcrypt.hash(PASSKEY, 10);

        for (const d of DEMOS) {
            const email = `${BASE_EMAIL}+${d.tag}@gmail.com`;
            const existing = await Customer.findOne({ email });

            if (existing) {
                existing.secretKey     = hashedKey;
                existing.template      = d.plan;
                existing.paymentStatus = 'paid';
                existing.name          = d.name;
                await existing.save();
                console.log(`Updated  ${d.plan.padEnd(10)} → ${email}  (key: ${PASSKEY})`);
            } else {
                await Customer.create({
                    name:          d.name,
                    email,
                    phone:         DEMO_PHONE,
                    secretKey:     hashedKey,
                    template:      d.plan,
                    subdomain:     d.sub,
                    paymentStatus: 'paid',     // mark paid so the dashboard treats it as active
                    isAdmin:       false,
                });
                console.log(`Created  ${d.plan.padEnd(10)} → ${email}  (key: ${PASSKEY})`);
            }
        }

        console.log('\n✅ Done. Log in at sitesawa.com/login.html with any email above + key MARION01');
        await mongoose.disconnect();
        process.exit(0);
    } catch (err) {
        console.error('\n❌ Seed failed:', err.message);
        process.exit(1);
    }
})();
