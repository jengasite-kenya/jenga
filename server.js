require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cloudinary = require('cloudinary').v2;
// CLOUDINARY_URL env var is read automatically by the SDK
// Format: cloudinary://<api_key>:<api_secret>@<cloud_name>
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const nodemailer = require('nodemailer');
const axios = require('axios');

// ============================================
// ENV VALIDATION - CRASH IF JWT_SECRET MISSING
// ============================================
if (!process.env.JWT_SECRET) {
    console.error('FATAL: JWT_SECRET is required');
    process.exit(1);
}

const app = express();


// ── REQUEST ID MIDDLEWARE ───────────────────────────────────────────────
// Attaches a unique ID to every request for log correlation.
// Returned in X-Request-ID header so clients can include it in bug reports.
app.use((req, res, next) => {
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    req.requestId = id;
    res.setHeader('X-Request-ID', id);
    next();
});

// ============================================
// SECURITY HEADERS (helmet)
// ============================================
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: [
                "'self'", "'unsafe-inline'",
                'https://www.googletagmanager.com',
                'https://www.googleadservices.com',
                'https://googleads.g.doubleclick.net',
                'https://analytics.tiktok.com',
                'https://analytics.us.tiktok.com',
                'https://fonts.googleapis.com',
                'https://cdn.jsdelivr.net',
                'https://unpkg.com',
                'https://cdnjs.cloudflare.com',
            ],
            styleSrc: ["'self'", "'unsafe-inline'",
                'https://fonts.googleapis.com',
                'https://cdnjs.cloudflare.com',
                'https://cdn.jsdelivr.net'],
            fontSrc: ["'self'",
                'https://fonts.gstatic.com',
                'https://cdnjs.cloudflare.com'],
            imgSrc: ["'self'", 'data:', 'https:', 'blob:'],
            connectSrc: ["'self'",
                'https://sandbox.safaricom.co.ke',
                'https://api.safaricom.co.ke',
                'https://api.indexnow.org',
                'https://images.unsplash.com',
                'https://res.cloudinary.com',
                'https://analytics.tiktok.com',
                'https://analytics.us.tiktok.com',
                'https://*.tiktok.com',
                'https://www.google-analytics.com',
                'https://region1.google-analytics.com',
                'https://www.googletagmanager.com',
                'https://googleads.g.doubleclick.net'],
        },
    },
    crossOriginEmbedderPolicy: false,
}));

app.use(cors({
    origin: function (origin, callback) {
        const allowed = [
            /^https?:\/\/(.*\.)?sitesawa\.com$/,
            /^http:\/\/localhost(:\d+)?$/
        ];
        if (!origin || allowed.some(r => r.test(origin))) return callback(null, true);
        callback(new Error('Not allowed by CORS'));
    },
    credentials: true
}));
app.use(express.json({ limit: '10mb' }));

// ============================================
// MONGODB CONNECTION
// ============================================
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/sitesawa')
    .then(async () => {
        console.log('MongoDB connected');

        // --- One-time migration: drop stale indexes that conflict with new specs ---
        // (1) Older versions made PHONE unique. Phones must now be reusable
        //     (people often pay with someone else's M-Pesa number).
        // (2) Older versions had an EMAIL index that was NOT unique. Email is now
        //     the login, so it must be unique. MongoDB will NOT change an existing
        //     index's spec in place, and throws IndexKeySpecsConflict if the name
        //     matches but the options differ — so we drop the stale ones first.
        //     Safe to run on every startup (idempotent).
        try {
            const idx = await Customer.collection.indexes();
            for (const ix of idx) {
                const keys = Object.keys(ix.key || {});
                if (keys.length === 1 && keys[0] === 'phone' && ix.unique) {
                    await Customer.collection.dropIndex(ix.name);
                    console.log('Dropped stale unique phone index:', ix.name);
                }
                // drop any existing single-field email index so we can recreate it as unique
                if (keys.length === 1 && keys[0] === 'email') {
                    await Customer.collection.dropIndex(ix.name);
                    console.log('Dropped stale email index (recreating as unique):', ix.name);
                }
            }
        } catch (e) {
            console.error('Index migration check failed (non-fatal):', e.message);
        }

        // Ensure indexes exist. Each wrapped so one conflict can't crash startup.
        const ensureIndex = async (coll, spec, opts, label) => {
            try { await coll.createIndex(spec, opts); }
            catch (e) { console.error('Index ensure failed (' + label + ', non-fatal):', e.message); }
        };
        await Promise.all([
            ensureIndex(Customer.collection, { phone: 1 }, { unique: false }, 'phone'),
            ensureIndex(Customer.collection, { subdomain: 1 }, { unique: true, sparse: true }, 'subdomain'),
            ensureIndex(Customer.collection, { customDomain: 1 }, { unique: true, sparse: true }, 'customDomain'),
            ensureIndex(Customer.collection, { email: 1 }, { unique: true, sparse: true }, 'email'),
            ensureIndex(Order.collection, { customerId: 1 }, {}, 'order.customerId'),
            ensureIndex(Order.collection, { checkoutId: 1 }, { sparse: true }, 'order.checkoutId'),
            ensureIndex(Order.collection, { createdAt: -1 }, {}, 'order.createdAt'),
            ensureIndex(SupportTicket.collection, { customerId: 1 }, {}, 'ticket.customerId'),
        ]);
        console.log('DB indexes verified');
    })
    .catch(err => {
        console.error('MongoDB connection failed:', err);
        process.exit(1);
    });

// ============================================
// SCHEMAS
// ============================================
const CustomerSchema = new mongoose.Schema({
    name: String,
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    phone: { type: String, required: true },  // phone NOT unique — people may pay with another person's phone
    secretKey: { type: String, required: true },
    template: { type: String, enum: ['PERSONAL', 'BUSINESS', 'ECOMMERCE'], default: 'PERSONAL' },
    pendingPlan: { type: String, enum: ['PERSONAL', 'BUSINESS', 'ECOMMERCE', null], default: null },  // plan being paid for during an upgrade/downgrade
    subdomain: { type: String, unique: true, sparse: true, index: true },
    templateId: { type: String, default: '' }, // e.g. 'biz-agency', 'me-developer'
    customDomain: { type: String, unique: true, sparse: true, index: true },
    data: { type: mongoose.Schema.Types.Mixed, default: {} },
    createdAt: { type: Date, default: Date.now },
    lastLogin: Date,
    isAdmin: { type: Boolean, default: false },
    // M-Pesa settings
    mpesaMode: { type: String, enum: ['simple', 'api'], default: 'simple' },
    mpesaConsumerKey: String,
    mpesaConsumerSecret: String,
    mpesaShortcode: String,
    mpesaPasskey: String,
    // SEO settings
    googleSearchConsole: String,
    indexNowKey: String,
    // Analytics
    googleAnalyticsId: String,
    tiktokPixelId: String,
    // Social
    social: {
        whatsapp: String,
        instagram: String,
        facebook: String,
        twitter: String,
        linkedin: String,
        tiktok: String
    },
    // Key recovery OTP (expires in 15 min)
    recoveryOTP: {
        code: String,
        expires: Date
    },
    paymentStatus: { type: String, default: 'pending' }, // pending | paid | failed | trial
    trialEndsAt: { type: Date, default: null }, // free 7-day trial expiry; site goes read-only/locked after this unless paid
    trialReminderSent: { type: Boolean, default: false }, // so the "trial ending soon" email is sent only once
    mpesaCheckoutId: String
});

const OrderSchema = new mongoose.Schema({
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true },
    customerPhone: String,
    customerName: String,
    items: [{ name: String, price: Number, quantity: Number, image: String }],
    total: Number,
    shipping: { type: String, enum: ['pickup', 'local', 'nationwide'], default: 'pickup' },
    shippingCost: { type: Number, default: 0 },
    status: { type: String, enum: ['pending', 'paid', 'processing', 'shipped', 'delivered', 'cancelled'], default: 'pending' },
    paymentMethod: { type: String, enum: ['mpesa_simple', 'mpesa_api', 'cash'], default: 'mpesa_simple' },
    mpesaCode: String,
    mpesaTransactionId: String,
    checkoutId: String,
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
});

const SupportTicketSchema = new mongoose.Schema({
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true },
    customerName: String,
    customerPhone: String,
    subject: String,
    message: String,
    status: { type: String, enum: ['open', 'in-progress', 'resolved'], default: 'open' },
    replies: [{ from: String, message: String, date: { type: Date, default: Date.now } }],
    createdAt: { type: Date, default: Date.now }
});

const Customer = mongoose.model('Customer', CustomerSchema);
const Order = mongoose.model('Order', OrderSchema);
const SupportTicket = mongoose.model('SupportTicket', SupportTicketSchema);

// ============================================
// GOOGLE WORKSPACE EMAIL TRANSPORTER
// ============================================
const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: {
        user: process.env.WORKSPACE_EMAIL,
        pass: process.env.WORKSPACE_APP_PASSWORD
    }
});

async function sendEmail(to, subject, html) {
    try {
        await transporter.sendMail({
            from: `"SiteSawa" <${process.env.WORKSPACE_EMAIL}>`,
            to,
            subject,
            html
        });
        console.log('Email sent to', to);
    } catch (err) {
        console.error('Email failed to', to, '— subject:', subject);
        console.error('Email error:', err.message);
        console.error('Check WORKSPACE_EMAIL and WORKSPACE_APP_PASSWORD env vars on Render');
    }
}

// ============================================
// AUTH MIDDLEWARE
// ============================================
function auth(req, res, next) {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'No token' });
    try {
        req.user = jwt.verify(token, process.env.JWT_SECRET);
        next();
    } catch {
        res.status(401).json({ error: 'Invalid token' });
    }
}

function adminAuth(req, res, next) {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'No token' });
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        if (!decoded.isAdmin) return res.status(403).json({ error: 'Admin only' });
        req.user = decoded;
        next();
    } catch {
        res.status(401).json({ error: 'Invalid token' });
    }
}

// ============================================
// RATE LIMITERS
// ============================================
const orderLimiter = rateLimit({
    handler: (req, res) => {
        res.status(429).json({ error: 'Too many requests. Please wait a moment.', retryAfter: 60 });
    },
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 10,
    message: { error: 'Too many orders. Try again later.' }
});

const authLimiter = rateLimit({
    handler: (req, res) => {
        const secs = Math.ceil(((req.rateLimit?.resetTime || Date.now()+900000) - Date.now()) / 1000);
        res.set('Retry-After', secs);
        res.status(429).json({ error: `Too many attempts. Try again in ${Math.ceil(secs/60)} min.`, retryAfter: secs });
    },
    windowMs: 15 * 60 * 1000,
    max: 20,
    message: { error: 'Too many attempts. Try again later.' }
});

// ============================================
// DARAJA M-PESA HELPERS
// ============================================
function getMpesaTimestamp() {
    const d = new Date();
    return d.getFullYear() +
        String(d.getMonth() + 1).padStart(2, '0') +
        String(d.getDate()).padStart(2, '0') +
        String(d.getHours()).padStart(2, '0') +
        String(d.getMinutes()).padStart(2, '0') +
        String(d.getSeconds()).padStart(2, '0');
}

function getMpesaPassword(shortcode, passkey, timestamp) {
    return Buffer.from(`${shortcode}${passkey}${timestamp}`).toString('base64');
}

async function getMpesaAccessToken(consumerKey, consumerSecret, isSandbox = true) {
    const baseUrl = isSandbox
        ? 'https://sandbox.safaricom.co.ke'
        : 'https://api.safaricom.co.ke';
    const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');
    const res = await axios.get(`${baseUrl}/oauth/v1/generate?grant_type=client_credentials`, {
        headers: { Authorization: `Basic ${auth}` }
    });
    return res.data.access_token;
}

async function initiateSTKPush(customer, phone, amount, orderId) {
    const isSandbox = process.env.MPESA_ENV !== 'production';
    const baseUrl = isSandbox
        ? 'https://sandbox.safaricom.co.ke'
        : 'https://api.safaricom.co.ke';

    const token = await getMpesaAccessToken(
        customer.mpesaConsumerKey,
        customer.mpesaConsumerSecret,
        isSandbox
    );

    const timestamp = getMpesaTimestamp();
    const password = getMpesaPassword(customer.mpesaShortcode, customer.mpesaPasskey, timestamp);

    // Format phone: 07... -> 2547..., +254... -> 254...
    let formattedPhone = phone;
    if (formattedPhone.startsWith('0')) {
        formattedPhone = '254' + formattedPhone.slice(1);
    } else if (formattedPhone.startsWith('+')) {
        formattedPhone = formattedPhone.slice(1);
    }

    const callbackUrl = `${process.env.BASE_URL || 'https://api.sitesawa.com'}/api/mpesa/callback/${customer._id}`;

    const payload = {
        BusinessShortCode: customer.mpesaShortcode,
        Password: password,
        Timestamp: timestamp,
        TransactionType: 'CustomerPayBillOnline',
        Amount: Math.round(amount),
        PartyA: formattedPhone,
        PartyB: customer.mpesaShortcode,
        PhoneNumber: formattedPhone,
        CallBackURL: callbackUrl,
        AccountReference: `SiteSawa-${orderId.toString().slice(-6)}`,
        TransactionDesc: 'SiteSawa Order Payment'
    };

    const res = await axios.post(
        `${baseUrl}/mpesa/stkpush/v1/processrequest`,
        payload,
        { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );

    return res.data;
}

// ============================================
// SEO HELPERS
// ============================================
async function pingIndexNow(url, key) {
    try {
        const res = await axios.get(
            `https://api.indexnow.org/indexnow?url=${encodeURIComponent(url)}&key=${key}`,
            { timeout: 10000 }
        );
        console.log('IndexNow ping:', res.status, url);
        return res.status === 200;
    } catch (err) {
        console.error('IndexNow failed:', err.message);
        return false;
    }
}

async function submitToGoogleSearchConsole(url, siteUrl) {
    // Note: Requires OAuth2 setup with Google Search Console API
    // This is a placeholder for the actual implementation
    console.log('Google Search Console submit (requires OAuth2 setup):', url);
    return true;
}

function generateSitemap(customer) {
    const domain = customer.customDomain || `${customer.subdomain}.sitesawa.com`;
    const baseUrl = `https://${domain}`;
    const urls = [baseUrl];

    // Add product pages for SHOP
    if (customer.template === 'ECOMMERCE' && customer.data?.products) {
        customer.data.products.forEach((p, i) => {
            if (p.name) urls.push(`${baseUrl}/#product-${i}`);
        });
    }

    // Add section anchors
    const sections = {
        PERSONAL:  ['#about', '#skills', '#portfolio', '#contact'],
        BUSINESS:  ['#about', '#services', '#team', '#contact'],
        ECOMMERCE: ['#products', '#about', '#contact'],
    };
    (sections[customer.template] || []).forEach(s => urls.push(`${baseUrl}/${s}`));

    let xml = `<?xml version="1.0" encoding="UTF-8"?>
`;
    xml += `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
`;
    urls.forEach(u => {
        xml += `  <url><loc>${u}</loc><lastmod>${new Date().toISOString().split('T')[0]}</lastmod><changefreq>weekly</changefreq><priority>0.8</priority></url>
`;
    });
    xml += `</urlset>`;
    return xml;
}



// ============================================
// HTML ESCAPE FOR LEGACY TEMPLATE RENDERING
// Prevents stored XSS in me-template / biz-template / shop-template
// ============================================
function escapeHtml(val) {
    if (val == null) return '';
    return String(val)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// ============================================
// INPUT SANITIZATION HELPERS
// ============================================
function stripHtml(str) {
    if (typeof str !== 'string') return str;
    // Strip dangerous patterns only — preserve safe text content
    return str
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
        .replace(/on\w+\s*=\s*"[^"]*"/gi, '')
        .replace(/on\w+\s*=\s*'[^']*'/gi, '')
        .replace(/on\w+\s*=\s*[^\s>]+/gi, '')
        .replace(/javascript\s*:/gi, '')
        .replace(/data\s*:\s*text\/html/gi, '')
        .replace(/<[^>]*>/g, '')   // strip remaining tags
        .trim();
}

function deepSanitize(obj) {
    if (typeof obj === 'string') return stripHtml(obj);
    if (Array.isArray(obj)) return obj.map(deepSanitize);
    if (obj && typeof obj === 'object') {
        const clean = {};
        for (const [k, v] of Object.entries(obj)) {
            clean[k] = deepSanitize(v);
        }
        return clean;
    }
    return obj;
}

// ============================================
// MUSTACHE BLOCK RENDERER
// Handles {{#key}}...{{/key}} loops,
// {{^key}}...{{/key}} inverted sections,
// and {{key}} variable replacement.
// Used to serve all spec templates.
// ============================================
function getNestedVal(obj, path) {
    if (!path || !obj) return undefined;
    return path.split('.').reduce((cur, k) => (cur != null ? cur[k] : undefined), obj);
}

function renderMustache(tmpl, view) {
    // {{#key}}...{{/key}} — loop over array or conditional
    tmpl = tmpl.replace(/\{\{#(\w[\w.]*?)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_, key, inner) => {
        const val = getNestedVal(view, key);
        if (!val) return '';
        if (Array.isArray(val)) return val.map(item => renderMustache(inner, { ...view, ...item })).join('');
        if (typeof val === 'object') return renderMustache(inner, { ...view, ...val });
        return renderMustache(inner, view);
    });
    // {{^key}}...{{/key}} — inverted section
    tmpl = tmpl.replace(/\{\{\^(\w[\w.]*?)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_, key, inner) => {
        const val = getNestedVal(view, key);
        return (!val || (Array.isArray(val) && val.length === 0)) ? inner : '';
    });
    // {{key}} — escaped variable
    tmpl = tmpl.replace(/\{\{(\w[\w.]*?)\}\}/g, (_, key) => {
        const val = getNestedVal(view, key);
        if (val == null) return '';
        return String(val)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    });
    return tmpl;
}


// CSS value sanitizer — prevents injection via gradient_start, accent_color, etc.
// Accepts: hex colors, rgb/rgba, hsl/hsla, basic named colors, linear-gradient
// Rejects everything else and falls back to a safe default
function sanitizeCssColor(val, fallback = '#1e5a3c') {
    if (!val || typeof val !== 'string') return fallback;
    const v = val.trim().slice(0, 60);
    if (/^#[0-9a-fA-F]{3,8}$/.test(v)) return v;
    if (/^rgba?\(\s*[\d.,\s%]+\)$/.test(v)) return v;
    if (/^hsla?\(\s*[\d.,\s%]+\)$/.test(v)) return v;
    if (/^[a-z]+$/.test(v) && v.length < 25) return v; // named colors
    if (/^linear-gradient\([^;{}()<>]+\)$/.test(v)) return v;
    console.warn(`[CSS] Rejected unsafe CSS value: ${v.slice(0,30)}`);
    return fallback;
}


// ============================================
// CLOUDINARY IMAGE UPLOAD
// Intercepts base64 data URIs before they hit
// MongoDB and swaps them for CDN URLs.
// Falls back to the original value on failure
// so no image is ever silently lost.
// ============================================
async function uploadImage(value, folder = 'sitesawa') {
    if (!value || typeof value !== 'string') return value;
    // Already an external URL — nothing to do
    if (value.startsWith('http') || value.startsWith('//')) return value;
    // Not a base64 image — return as-is
    if (!value.startsWith('data:image/')) return value;
    try {
        const result = await cloudinary.uploader.upload(value, {
            folder,
            transformation: [
                { width: 1200, crop: 'limit' },
                { quality: 'auto:good' },
                { fetch_format: 'auto' },
            ],
        });
        return result.secure_url;
    } catch (err) {
        console.error('[CLOUDINARY] Upload failed:', err.message);
        return value; // fall back: keep base64 rather than losing the image
    }
}

// Scan a customer data object and upload any base64 image fields to Cloudinary.
// Returns the updated data object with all base64 values replaced by CDN URLs.
async function uploadDataImages(data) {
    if (!data || typeof data !== 'object') return data;
    const d = { ...data };

    // Single image fields
    const imgFields = ['logo','heroImage','aboutImage','storyImage','agentImage',
                       'avatarImage','brandImage','coverImage'];
    for (const field of imgFields) {
        if (d[field]) d[field] = await uploadImage(d[field], 'sitesawa/content');
    }

    // Product images array
    if (Array.isArray(d.products)) {
        d.products = await Promise.all(d.products.map(async p => ({
            ...p,
            image: p.image ? await uploadImage(p.image, 'sitesawa/products') : p.image,
        })));
    }

    // Gallery images array
    if (Array.isArray(d.galleryImages)) {
        d.galleryImages = await Promise.all(
            d.galleryImages.map(url => uploadImage(url, 'sitesawa/gallery'))
        );
    }

    // Lookbook images
    if (Array.isArray(d.lookbookImages)) {
        d.lookbookImages = await Promise.all(
            d.lookbookImages.map(url => uploadImage(url, 'sitesawa/lookbook'))
        );
    }

    return d;
}

// Build a flat view object for spec templates from customer data
function buildTemplateView(customer) {
    const d = customer.data || {};
    const s = customer.social || {};
    const ph = customer.phone || '';
    const yr = new Date().getFullYear();
    const domain = customer.customDomain || (customer.subdomain + '.sitesawa.com');

    const socialLinks = Object.entries(s)
        .filter(([, v]) => v)
        .map(([platform, url]) => ({
            url,
            icon: ({ instagram: 'fa-instagram', facebook: 'fa-facebook', twitter: 'fa-twitter',
                     linkedin: 'fa-linkedin', tiktok: 'fa-music', whatsapp: 'fa-whatsapp' })[platform] || 'fa-globe'
        }));

    const nm = d.businessName || d.bizName || d.shopName || customer.name || '';

    return {
        // Identity (all name variants — templates use different ones)
        business_name: nm, company_name: nm, restaurant_name: nm,
        shop_name: nm, agency_name: nm, photographer_name: nm,
        name: d.name || customer.name || '', product_name: d.productName || nm,

        // Hero / Copy
        tagline:     d.tagline || '',
        headline:    d.headline || '',
        subtitle:    d.subtitle || '',
        description: d.description || d.heroText || '',
        hero_image:  d.heroImage || d.logo || '',
        hero_type:   d.heroType || 'image',

        // About
        about_title: d.aboutTitle || 'About Us',
        about_text:  d.aboutText || '',
        about_text_2: d.aboutText2 || '',
        about_image: d.aboutImage || d.logo || '',
        bio:         d.bio || d.aboutText || '',

        // Contact
        phone: ph, email: customer.email || d.email || '',
        address: d.address || d.location || '',
        whatsapp: ph.replace(/^0/, '254'),
        contact_text: d.contactText || 'Get in touch with us today.',

        // Social
        social_links: socialLinks,
        social_ig: s.instagram || '#', social_fb: s.facebook || '#',
        social_tw: s.twitter || '#', social_li: s.linkedin || '#',

        // Misc
        year: yr, domain: domain,
        accent_color: sanitizeCssColor(d.accentColor, '#1e3a2f'),

        // Services / Skills
        services: d.services || [],
        skills: d.skills || [],

        // Products
        products: d.products || [],
        featured_products: (d.products || []).slice(0, 4),
        all_products: d.products || [],
        product_cols: d.productColumns || 4,

        // Stats
        stats: d.stats || [],
        stats_count: (d.stats || []).length || 4,
        hero_stats: d.heroStats || [],

        // ME-2 Landing
        gradient_start: sanitizeCssColor(d.gradientStart, '#667eea'),
        gradient_end:   sanitizeCssColor(d.gradientEnd, '#764ba2'),
        pricing_count:  d.pricingCount  || 3,
        pricing_tiers:  d.pricingTiers  || [],
        features:       d.features || [],
        showcase_items: d.showcaseItems || [],
        testimonial_text:   d.testimonialText   || '',
        testimonial_author: d.testimonialAuthor || '',
        testimonial_role:   d.testimonialRole   || '',
        cta_button:   d.ctaButton  || 'Get Started',
        cta_button_2: d.ctaButton2 || 'Learn More',
        cta_subtext:  d.ctaSubtext || '',
        trust_count:  d.trustCount || '100',

        // ME-3 Photography
        gallery_images: d.galleryImages || d.gallery || [],
        gallery_cols:   d.galleryColumns || 3,

        // ME-4 Blogger
        avatar_image:  d.avatarImage || d.logo || '',
        featured_posts: d.posts || d.featuredPosts || [],
        categories:    d.categories || [],
        newsletter_text: d.newsletterText || 'Subscribe to stay updated.',
        post_cols:     d.postColumns || 3,

        // BIZ-1 Agency
        work_items: d.workItems || d.portfolio || [],
        work_cols:  d.workColumns || 3,
        team_members: d.team || d.teamMembers || [],
        team_count:   (d.team || d.teamMembers || []).length || 4,

        // BIZ-2 Restaurant
        hours:           d.hours || d.openingHours || '',
        menu_categories: d.menuCategories || d.menu || [],
        menu_cols:       d.menuColumns || 2,

        // BIZ-3 Finance
        case_studies: d.caseStudies || [],
        client_logos: d.clientLogos || [],

        // BIZ-4 Real Estate
        featured_listings: d.listings || d.featuredListings || [],
        listing_cols:      d.listingColumns || 3,
        agent_name:        d.agentName || customer.name || '',
        agent_image:       d.agentImage || d.logo || '',
        testimonials:      d.testimonials || [],

        // Portfolio
        portfolio_items: d.portfolioItems || d.portfolio || [],
        portfolio_cols:  d.portfolioColumns || 3,

        // SHOP story
        story_title:       d.storyTitle || 'Our Story',
        story_text:        d.storyText  || '',
        story_text_2:      d.storyText2 || '',
        story_image:       d.storyImage || d.logo || '',
        shop_description:  d.shopDescription || d.tagline || '',

        // SHOP-2 Fashion
        collections:    d.collections || [],
        lookbook_images: d.lookbookImages || [],
        brand_story:    d.brandStory || d.aboutText || '',

        // Legacy
        customer_id: customer._id ? customer._id.toString() : '',
    };
}

// Spec templates use Mustache blocks + flat namespace
// SPEC_TEMPLATES removed — all templates hydrated via sitesawa-connect.js
const SPEC_TEMPLATES = new Set([]);

// ============================================
// SECRET KEY GENERATOR
// ============================================
function generateSecretKey() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let key = '';
    for (let i = 0; i < 8; i++) {
        key += chars[crypto.randomInt(0, chars.length)];
    }
    return key;
}

// ============================================
// TEMPLATE SERVING
// ============================================
// Full template map — keyed by templateId (the specific design chosen by the customer)
// Falls back to legacy generic files if templateId is not set or unrecognised.
const TEMPLATE_FILES = {
    // Personal
    'me-portfolio':  'templates/me-portfolio.html',
    'me-developer':  'templates/me-developer.html',
    'me-writer':     'templates/me-writer.html',
    'me-music':      'templates/me-music.html',
    'me-resume':     'templates/me-resume.html',
    'me-wedding':    'templates/me-wedding.html',
    'me-artist':     'templates/me-artist.html',
    'me-doctor':     'templates/me-doctor.html',
    'me-linkbio':    'templates/me-linkbio.html',
    'me-coach':      'templates/me-coach.html',
    'me-speaker':    'templates/me-speaker.html',
    'me-travel':     'templates/me-travel.html',
    // Business
    'biz-restaurant':   'templates/biz-restaurant.html',
    'biz-agency':       'templates/biz-agency.html',
    'biz-spa':          'templates/biz-spa.html',
    'biz-law':          'templates/biz-law.html',
    'biz-realestate':   'templates/biz-realestate.html',
    'biz-gym':          'templates/biz-gym.html',
    'biz-coffee':       'templates/biz-coffee.html',
    'biz-construction': 'templates/biz-construction.html',
    'biz-startup':      'templates/biz-startup.html',
    'biz-auto':         'templates/biz-auto.html',
    'biz-safari':       'templates/biz-safari.html',
    'biz-bakery':       'templates/biz-bakery.html',
    'biz-politician':    'templates/biz-politician.html',
    'biz-logistics':     'templates/biz-logistics.html',
    'biz-salon':         'templates/biz-salon.html',
    'biz-phonerepair':   'templates/biz-phonerepair.html',
    'biz-printing':      'templates/biz-printing.html',
    'biz-chemist':       'templates/biz-chemist.html',
    'biz-forex':         'templates/biz-forex.html',
    'biz-college':       'templates/biz-college.html',
    // E-Commerce
    'shop-fashion':     'templates/shop-fashion.html',
    'shop-electronics': 'templates/shop-electronics.html',
    'shop-beauty':      'templates/shop-beauty.html',
    'shop-food':        'templates/shop-food.html',
    'shop-furniture':   'templates/shop-furniture.html',
    'shop-bookstore':   'templates/shop-bookstore.html',
    'shop-retail':      'templates/shop-retail.html',

    // ── Aliases from marketing site template IDs ──────────────────────
    // ME
    'me-01-freelancer':          'templates/me-artist.html',
    'me-02-resume':              'templates/me-resume.html',
    'me-03-grayscale':           'templates/me-portfolio.html',
    'me-04-creative':            'templates/me-artist.html',
    'me-05-stylish':             'templates/me-portfolio.html',
    'me-06-blog':                'templates/me-writer.html',
    'me-07-landing':             'templates/me-coach.html',
    'me-08-scrollnav':           'templates/me-developer.html',
    'me-tm-01-first-portfolio':  'templates/me-portfolio.html',
    'me-tm-02-space-dynamic':    'templates/me-music.html',
    // BIZ
    'biz-01-agency':             'templates/biz-agency.html',
    'biz-02-frontpage':          'templates/biz-startup.html',
    'biz-03-new-age':            'templates/biz-startup.html',
    'biz-04-small-biz':          'templates/biz-coffee.html',
    'biz-tm-01-onix-digital':    'templates/biz-agency.html',
    'biz-tm-02-digimedia':       'templates/biz-startup.html',
    'biz-tm-03-chain-app':       'templates/biz-startup.html',
    'biz-tm-04-softy-pinko':     'templates/biz-spa.html',
    'biz-tm-05-onix-biz':        'templates/biz-agency.html',
    'biz-tm-06-marketing':       'templates/biz-agency.html',
    // SHOP
    'shop-01-store':             'templates/shop-fashion.html',
    'shop-tm-01-zay-shop':       'templates/shop-electronics.html',
    'shop-tm-02-hexashop':       'templates/shop-furniture.html',
    'shop-tm-04-zay-green':      'templates/shop-food.html',
};

// Legacy fallback map (used when customer has no templateId)
const templateMap = {
    PERSONAL:  'templates/me-portfolio.html',
    BUSINESS:  'templates/biz-agency.html',
    ECOMMERCE: 'templates/shop-fashion.html',
};

function resolveTemplateFile(customer) {
    // 1. Use specific templateId if set and known
    if (customer.templateId && TEMPLATE_FILES[customer.templateId]) {
        return TEMPLATE_FILES[customer.templateId];
    }
    // 2. Check data.templateId (set by frontend checkout flow)
    const dataTemplateId = customer.data && customer.data.templateId;
    if (dataTemplateId && TEMPLATE_FILES[dataTemplateId]) {
        return TEMPLATE_FILES[dataTemplateId];
    }
    // 3. Fall back to plan-level default
    return templateMap[customer.template] || templateMap['PERSONAL'];
}

function replacePlaceholders(template, customer) {
    let html = template;
    const data = customer.data || {};

    // Basic fields
    const basic = {
        'customer.name': customer.name || '',
        'customer.phone': customer.phone || '',
        'customer.email': customer.email || '',
        'customer.template': customer.template || 'PERSONAL',
        'customer.subdomain': customer.subdomain || '',
        'customer.customDomain': customer.customDomain || ''
    };

    for (const [key, val] of Object.entries(basic)) {
        html = html.replace(new RegExp(`\\{\\{${key.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}\\}\\}`, 'g'), escapeHtml(val));
    }

    // Nested data fields
    const flatten = (obj, prefix = '') => {
        const result = {};
        for (const [k, v] of Object.entries(obj || {})) {
            const newKey = prefix ? `${prefix}.${k}` : k;
            if (v && typeof v === 'object' && !Array.isArray(v)) {
                Object.assign(result, flatten(v, newKey));
            } else {
                result[newKey] = v;
            }
        }
        return result;
    };

    const flatData = flatten(data, 'customer.data');
    for (const [key, val] of Object.entries(flatData)) {
        // Escape all string values to prevent stored XSS in legacy templates
        const strVal = Array.isArray(val) ? '' : escapeHtml(val);
        html = html.replace(new RegExp(`\\{\\{${key.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}\\}\\}`, 'g'), strVal);
    }

    // Social links
    const social = customer.social || {};
    for (const [platform, url] of Object.entries(social)) {
        html = html.replace(new RegExp(`{{customer.social.${platform}}}`, 'g'), url || '');
    }

    // Analytics injection
    if (customer.googleAnalyticsId && customer.googleAnalyticsId !== 'G-XXXXXXXXXX') {
        const gaScript = `<script async src="https://www.googletagmanager.com/gtag/js?id=${customer.googleAnalyticsId}"></script>
<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','${customer.googleAnalyticsId}');</script>`;
        html = html.replace('</head>', gaScript + '\n</head>');
    }

    if (customer.tiktokPixelId && customer.tiktokPixelId !== 'G-XXXXXXXXXX') {
        const ttScript = `<script>!function(w,d,t){w.TiktokAnalyticsObject=t;var ttq=w[t]=w[t]||[];ttq.methods=["page","track","identify","instances","debug","on","off","once","ready","alias","group","enableCookie","disableCookie"],ttq.setAndDefer=function(t,e){t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}};for(var i=0;i<ttq.methods.length;i++)ttq.setAndDefer(ttq,ttq.methods[i]);ttq.instance=function(t){for(var e=ttq._i[t]||[],n=0;n<ttq.methods.length;n++)ttq.setAndDefer(e,ttq.methods[n]);return e},ttq.load=function(e,n){var i="https://analytics.tiktok.com/i18n/pixel/events.js";ttq._i=ttq._i||{},ttq._i[e]=[],ttq._i[e]._u=i,ttq._t=ttq._t||{},ttq._t[e]=+new Date,ttq._o=ttq._o||{},ttq._o[e]=n||{};var o=document.createElement("script");o.type="text/javascript",o.async=!0,o.src=i+"?sdkid="+e+"&lib="+t;var a=document.getElementsByTagName("script")[0];a.parentNode.insertBefore(o,a)};ttq.load('${customer.tiktokPixelId}');ttq.page();}(window,document,'ttq');</script>`;
        html = html.replace('</head>', ttScript + '\n</head>');
    }

    // Final sweep — blank any remaining unreplaced {{...}} placeholders.
    // Prevents raw strings like "{{customer.googleAnalytics}}" passing length
    // checks and triggering broken analytics initialization.
    html = html.replace(/\{\{[^}]+\}\}/g, '');

    // Structured data injection (JSON-LD)
    const schemas = [];
    if (customer.template === 'BUSINESS') {
        schemas.push({
            '@context': 'https://schema.org',
            '@type': 'LocalBusiness',
            name: data.businessName || customer.name,
            description: data.tagline || '',
            url: `https://${customer.customDomain || customer.subdomain + '.sitesawa.com'}`,
            telephone: customer.phone,
            sameAs: Object.values(social).filter(Boolean),
            address: data.location ? {
                '@type': 'PostalAddress',
                addressLocality: data.location
            } : undefined
        });
    } else if (customer.template === 'ECOMMERCE') {
        schemas.push({
            '@context': 'https://schema.org',
            '@type': 'Store',
            name: data.shopName || customer.name,
            description: data.tagline || '',
            url: `https://${customer.customDomain || customer.subdomain + '.sitesawa.com'}`,
            telephone: customer.phone
        });
        if (data.products) {
            data.products.forEach(p => {
                schemas.push({
                    '@context': 'https://schema.org',
                    '@type': 'Product',
                    name: p.name,
                    description: p.description || '',
                    image: p.image || '',
                    offers: {
                        '@type': 'Offer',
                        price: p.price,
                        priceCurrency: 'KES',
                        availability: 'https://schema.org/InStock'
                    }
                });
            });
        }
    
        schemas.push({
            '@context': 'https://schema.org',
            '@type': 'Organization',
            name: data.businessName || customer.name,
            description: data.tagline || '',
            url: `https://${customer.customDomain || customer.subdomain + '.sitesawa.com'}`,
            telephone: customer.phone,
            sameAs: Object.values(social).filter(Boolean),
            address: data.location ? {
                '@type': 'PostalAddress',
                addressLocality: data.location
            } : undefined
        });
        schemas.push({
            '@context': 'https://schema.org',
            '@type': 'WebSite',
            name: data.businessName || customer.name,
            url: `https://${customer.customDomain || customer.subdomain + '.sitesawa.com'}`
        });
        if (data.products) {
            data.products.forEach(p => {
                schemas.push({
                    '@context': 'https://schema.org',
                    '@type': 'Product',
                    name: p.name,
                    description: p.description || '',
                    image: p.image || '',
                    offers: {
                        '@type': 'Offer',
                        price: p.price,
                        priceCurrency: 'KES',
                        availability: 'https://schema.org/InStock'
                    }
                });
            });
        }
    }

    if (schemas.length > 0) {
        const ldScript = `<script type="application/ld+json">${JSON.stringify(schemas.length === 1 ? schemas[0] : schemas)}</script>`;
        html = html.replace('</head>', ldScript + '\n</head>');
    }

    return html;
}

// ============================================
// ROUTES
// ============================================


// ============================================
// SITESAWA CONNECT — data injection
// Appends a JSON data block + sitesawa-connect.js
// to every template so the client script can
// hydrate the page with real customer data.
// ============================================
function injectSiteSawaData(html, customer) {
    // Build safe public customer object (no secrets)
    const pub = {
        _id:             customer._id,
        templateId:      customer.templateId || '',
        name:            customer.name,
        phone:           customer.phone,
        email:           customer.email,
        template:        customer.template,
        subdomain:       customer.subdomain,
        customDomain:    customer.customDomain,
        googleAnalyticsId: customer.googleAnalyticsId || '',
        tiktokPixelId:   customer.tiktokPixelId || '',
        social:          customer.social || {},
        data: (function() {
            const d = { ...(customer.data || {}) };
            // Strip base64 images from the JSON block (CDN URLs stay)
            Object.keys(d).forEach(k => {
                if (typeof d[k] === 'string' && d[k].startsWith('data:')) delete d[k];
            });
            if (Array.isArray(d.products)) {
                d.products = d.products.map(p => ({
                    id:          p.id,
                    name:        p.name,
                    price:       p.price,
                    description: p.description || '',
                    image:       (p.image && !p.image.startsWith('data:')) ? p.image : '',
                    stock:       p.stock ?? null,
                }));
            }
            return d;
        })(),
    };

    // Add template filename hint for connect.js smart detection
    pub._tpl = customer.templateId || '';
    const dataTag = `\n<script id="ss-data" type="application/json">${JSON.stringify(pub)}</script>`;
    const scriptTag = `\n<script src="/sitesawa-connect.js?v=4" defer></script>`;

    // Inject before </body>
    if (html.includes('</body>')) {
        html = html.replace('</body>', dataTag + scriptTag + '\n</body>');
    } else {
        html += dataTag + scriptTag;
    }
    return html;
}

// ============================================
// STATIC FILES & PAGE ROUTES
// ============================================

// Subdomain + custom domain routing middleware
app.use(async (req, res, next) => {
    if (req.path.startsWith('/api/') || req.path === '/health') return next();
    const host = String(req.headers.host || '').toLowerCase();
    const mainDomains = ['sitesawa.com', 'www.sitesawa.com', 'localhost', '127.0.0.1'];
    const isMain = mainDomains.some(d => host === d || host.startsWith(d + ':'));
    const isSubdomain = host.endsWith('.sitesawa.com') && !isMain;

    let customer = null;
    try {
        if (isSubdomain) {
            const subdomain = host.replace('.sitesawa.com', '').split(':')[0];
            customer = await Customer.findOne({ subdomain: { $eq: subdomain } });
        } else if (!isMain) {
            const cleanHost = host.split(':')[0].replace(/^www\./, '');
            customer = await Customer.findOne({ customDomain: { $eq: cleanHost } });
        }
    } catch (err) { console.error('[ROUTING]', err.message); }

    if (customer) {
        // Link-in-bio hub — yourname.sitesawa.com/links
        // One page with all the business's socials + contact, for pasting into bios.
        if (req.path === '/links' || req.path === '/links/') {
            try {
                const s = customer.social || {};
                const biz = (customer.name || 'My Business').replace(/[<>]/g, '');
                const wa = (s.whatsapp || '').replace(/[^0-9]/g, '');
                const links = [];
                if (wa) links.push({ label: 'WhatsApp — Message us', href: 'https://wa.me/' + wa, bg: '#25D366', fg: '#062b14' });
                if (s.instagram) links.push({ label: 'Instagram', href: s.instagram, bg: '#E1306C', fg: '#fff' });
                if (s.facebook)  links.push({ label: 'Facebook',  href: s.facebook,  bg: '#1877F2', fg: '#fff' });
                if (s.tiktok)    links.push({ label: 'TikTok',    href: s.tiktok,    bg: '#000000', fg: '#fff' });
                if (s.twitter)   links.push({ label: 'X (Twitter)', href: s.twitter, bg: '#0a0a0a', fg: '#fff' });
                if (s.linkedin)  links.push({ label: 'LinkedIn',  href: s.linkedin,  bg: '#0A66C2', fg: '#fff' });
                const siteUrl = 'https://' + (customer.customDomain || (customer.subdomain + '.sitesawa.com'));
                links.push({ label: 'Visit our website', href: siteUrl, bg: '#bef264', fg: '#1a1712' });
                if (wa) links.push({ label: 'Call us', href: 'tel:+' + wa, bg: '#1c1c1e', fg: '#fff' });

                const esc = (t) => String(t).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
                const buttons = links.map(l =>
                    `<a class="lk" href="${esc(l.href)}" target="_blank" rel="noopener" style="background:${l.bg};color:${l.fg}">${esc(l.label)}</a>`
                ).join('\n');

                const initial = esc(biz.charAt(0).toUpperCase());
                const hub = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(biz)} — All our links</title>
<meta name="description" content="${esc(biz)} — find us on WhatsApp, Instagram, Facebook, TikTok and more.">
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:system-ui,-apple-system,'Segoe UI',sans-serif;background:#13131a;color:#f5f5f0;min-height:100vh;padding:40px 20px;display:flex;flex-direction:column;align-items:center}
  .av{width:96px;height:96px;border-radius:50%;background:linear-gradient(135deg,#bef264,#8fce3c);display:grid;place-items:center;font-size:42px;font-weight:800;color:#1a1712;margin-bottom:16px;box-shadow:0 8px 30px rgba(190,242,100,.25)}
  h1{font-size:26px;font-weight:800;text-align:center;margin-bottom:6px}
  .tag{color:#9a9a9a;font-size:15px;text-align:center;margin-bottom:32px}
  .links{width:100%;max-width:520px;display:flex;flex-direction:column;gap:14px}
  .lk{display:block;text-align:center;padding:17px;border-radius:14px;font-weight:700;font-size:17px;text-decoration:none;transition:transform .12s,box-shadow .12s}
  .lk:hover{transform:translateY(-2px);box-shadow:0 8px 20px rgba(0,0,0,.3)}
  .lk:active{transform:translateY(0)}
  .ft{margin-top:36px;font-size:13px;color:#555;text-align:center}
  .ft a{color:#bef264;text-decoration:none}
</style></head><body>
  <div class="av">${initial}</div>
  <h1>${esc(biz)}</h1>
  <div class="tag">Find us everywhere 👇</div>
  <div class="links">
${buttons}
  </div>
  <div class="ft">Powered by <a href="https://www.sitesawa.com" target="_blank" rel="noopener">SiteSawa</a></div>
</body></html>`;
                return res.set('Content-Type', 'text/html').send(hub);
            } catch (err) { console.error('[LINKS HUB]', err.message); }
        }
        try {
            // Free-trial gate: if trial expired and not paid, show a reactivate page
            const isPaid = customer.paymentStatus === 'paid';
            const trialExpired = customer.trialEndsAt && new Date() > new Date(customer.trialEndsAt);
            if (!isPaid && trialExpired) {
                const bizName = customer.name || 'This website';
                const reactivateHtml = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${bizName} — Coming back soon</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:system-ui,-apple-system,sans-serif;background:#1c1c1e;color:#f5f5f0;min-height:100vh;display:grid;place-items:center;padding:24px;text-align:center}
  .wrap{max-width:480px}
  .tile{width:64px;height:64px;border-radius:16px;background:#bef264;display:grid;place-items:center;font-weight:800;font-size:34px;color:#1c1c1e;margin:0 auto 24px}
  h1{font-size:28px;font-weight:800;margin-bottom:12px}
  p{color:#aaa;line-height:1.6;margin-bottom:24px}
  .btn{display:inline-block;background:#bef264;color:#1c1c1e;font-weight:800;text-decoration:none;padding:15px 28px;border-radius:12px}
  .small{margin-top:20px;font-size:13px;color:#666}
</style></head><body><div class="wrap">
  <div class="tile">S</div>
  <h1>This website is paused</h1>
  <p>The free trial for <strong>${bizName}</strong> has ended. The owner can reactivate it anytime by choosing a plan — it only takes a minute.</p>
  <a class="btn" href="https://www.sitesawa.com/login.html">Reactivate this site →</a>
  <div class="small">Powered by SiteSawa · sitesawa.com</div>
</div></body></html>`;
                return res.set('Content-Type', 'text/html').send(reactivateHtml);
            }

            const templateFile = resolveTemplateFile(customer);
            const templatePath = path.join(__dirname, templateFile);
            if (fs.existsSync(templatePath)) {
                let tmpl = fs.readFileSync(templatePath, 'utf8');
                let html = replacePlaceholders(tmpl, customer);
                html = injectSiteSawaData(html, customer);
                return res.set('Content-Type', 'text/html').send(html);
            }
        } catch (err) { console.error('[TEMPLATE RENDER]', err.message); }
    }
    next();
});

// Static assets (CSS, JS, images)
// Template HTML files are intentionally excluded — they must go through
// the render middleware above so customer data is injected before serving.
const TEMPLATE_PATTERN = /^\/(me-|biz-|shop-).*\.html$/i;
const PAGE_FILES = new Set([
    'frontend/index.html','frontend/login.html','frontend/dashboard.html','frontend/admin-dashboard.html'
]);

// Serve template previews for the gallery (no customer data injected)
app.get(/^\/(me-|biz-|shop-).*\.html$/i, (req, res) => {
    // Serve from templates/ folder for gallery preview
    const fname = req.path.slice(1); // strip leading /
    const p = path.join(__dirname, 'templates', fname);
    if (fs.existsSync(p)) return res.sendFile(p);
    res.status(404).send('Template not found');
});

// Named page routes — defined BEFORE express.static so these always win
const page = (file) => (req, res) => {
    const p = path.join(__dirname, file);
    if (fs.existsSync(p)) return res.sendFile(p);
    res.status(404).send('Page not found');
};
app.get('/',                        page('frontend/index.html'));
app.get('/index.html',              page('frontend/index.html'));
app.get('/login',                   page('frontend/login.html'));
app.get('/login.html',              page('frontend/login.html'));
app.get('/dashboard',               page('frontend/dashboard.html'));
app.get('/dashboard.html',          page('frontend/dashboard.html'));
app.get('/dashboard-customer.html', page('frontend/dashboard.html'));
app.get('/admin',                   page('frontend/admin-dashboard.html'));
app.get('/admin.html',              page('frontend/admin-dashboard.html'));
app.get('/admin-dashboard.html',    page('frontend/admin-dashboard.html'));
app.get('/sitesawa-connect.js', (req, res) => {
    const p = path.join(__dirname, 'sitesawa-connect.js');
    if (fs.existsSync(p)) return res.sendFile(p);
    res.status(404).send('Not found');
});

// Static assets — serve from root, frontend/, and templates/
app.use(express.static(path.join(__dirname), { index: false }));
app.use('/frontend', express.static(path.join(__dirname, 'frontend'), { index: false }));

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

// --- AUTH ROUTES ---
app.post('/api/register', authLimiter, async (req, res) => {
    try {
        const { name, email, phone, template, subdomain, customDomain } = req.body;
        if (!phone) return res.status(400).json({ error: 'Phone required' });
        if (!email?.trim()) return res.status(400).json({ error: 'Email is required' });
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) return res.status(400).json({ error: 'Invalid email address' });

        if (!email) return res.status(400).json({ error: 'Email is required' });
        const existing = await Customer.findOne({ email: { $eq: email.toLowerCase().trim() } });
        if (existing) return res.status(400).json({ error: 'This email is already registered. Try logging in instead.' });

        const secretKey = generateSecretKey();
        const hashedKey = await bcrypt.hash(secretKey, 10);

        const regTemplateId = (req.body.templateId && TEMPLATE_FILES[req.body.templateId])
            ? req.body.templateId : '';

        // Build a unique subdomain (phones are reusable now, so don't rely on phone alone)
        let baseSub = (subdomain || (name || 'site')).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20) || 'site';
        let uniqueSub = baseSub;
        for (let i = 0; i < 20; i++) {
            const clash = await Customer.findOne({ subdomain: uniqueSub });
            if (!clash) break;
            uniqueSub = baseSub + Math.floor(1000 + Math.random() * 9000);
        }

        const customer = new Customer({
            name, email, phone,
            secretKey: hashedKey,
            template: template || 'PERSONAL',
            templateId: regTemplateId,
            subdomain: uniqueSub,
            customDomain,
            paymentStatus: 'trial',
            trialEndsAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // free for 7 days
            data: { name, email, phone }
        });
        await customer.save();

        // Send welcome email
        sendEmail(email || phone + '@sitesawa.com',
            'Welcome to SiteSawa — your site is live free for 7 days!',
            `<h2>Welcome ${name || 'there'}!</h2><p>Your SiteSawa website is live — free for 7 days.</p><p><strong>Sign in with your email:</strong> ${email}</p><p><strong>Secret Key:</strong> ${secretKey}</p><p>⚠️ Save this key — it is your password and cannot be recovered.</p><p>Your site address: ${uniqueSub}.sitesawa.com</p>`
        );

        res.json({ success: true, secretKey, subdomain: uniqueSub, message: 'Save this key - it cannot be recovered!' });
    } catch (err) {
        res.status(500).json({ error: 'Internal server error', requestId: req.requestId });
    }
});

app.post('/api/login', authLimiter, async (req, res) => {
    try {
        const { email, secretKey } = req.body;
        if (!email || !secretKey) return res.status(401).json({ error: 'Invalid credentials' });
        const customer = await Customer.findOne({ email: { $eq: email.toLowerCase().trim() } });
        if (!customer) return res.status(401).json({ error: 'Invalid credentials' });

        const valid = await bcrypt.compare(secretKey, customer.secretKey);
        if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

        customer.lastLogin = new Date();
        await customer.save();

        const token = jwt.sign(
            { id: customer._id, email: customer.email, isAdmin: customer.isAdmin },
            process.env.JWT_SECRET,
            { expiresIn: '7d' }
        );

        res.json({ token, customer: { id: customer._id, name: customer.name, email: customer.email, phone: customer.phone, template: customer.template, isAdmin: customer.isAdmin } });
    } catch (err) {
        res.status(500).json({ error: 'Internal server error', requestId: req.requestId });
    }
});

app.post('/api/admin/login', authLimiter, async (req, res) => {
    try {
        // Accept phone/secretKey (admin-dashboard.html) or email/password (legacy)
        const identifier = req.body.phone    || req.body.email    || '';
        const password   = req.body.secretKey || req.body.password || '';

        const adminEmail = process.env.ADMIN_EMAIL || 'admin@sitesawa.com';
        const adminPhone = process.env.ADMIN_PHONE || adminEmail;

        if (!process.env.ADMIN_PASSWORD) {
            console.error('WARNING: ADMIN_PASSWORD env var not set — admin login disabled');
            return res.status(503).json({ error: 'Admin not configured' });
        }
        const adminPass = process.env.ADMIN_PASSWORD;

        // Check identifier matches either email or phone env var
        const identifierValid = identifier === adminEmail || identifier === adminPhone;

        // Compare password using bcrypt if hash stored, otherwise timing-safe compare
        let valid = false;
        if (adminPass.startsWith('$2')) {
            valid = identifierValid && await bcrypt.compare(password, adminPass);
        } else {
            const a = Buffer.from(adminPass.padEnd(72));
            const b = Buffer.from(password.padEnd(72));
            valid = identifierValid && a.length === b.length && crypto.timingSafeEqual(a, b);
        }

        if (!valid) {
            return res.status(401).json({ error: 'Invalid admin credentials' });
        }

        const token = jwt.sign(
            { id: 'admin', identifier, isAdmin: true },
            process.env.JWT_SECRET,
            { expiresIn: '1d' }
        );
        res.json({ success: true, token, isAdmin: true });
    } catch (err) {
        res.status(500).json({ error: 'Internal server error', requestId: req.requestId });
    }
});

// --- CUSTOMER DATA ROUTES ---
app.get('/api/me', auth, async (req, res) => {
    try {
        const customer = await Customer.findById(req.user.id);
        if (!customer) return res.status(404).json({ error: 'Not found' });
        // Never expose hashed password/key or OTP fields
        const safe = customer.toObject();
        delete safe.secretKey;
        delete safe.recoveryOTP;
        delete safe.recoveryOTPExpiry;
        delete safe.mpesaConsumerKey;
        delete safe.mpesaConsumerSecret;
        delete safe.mpesaPasskey;
        // Trial countdown for the dashboard
        if (safe.paymentStatus !== 'paid' && safe.trialEndsAt) {
            const msLeft = new Date(safe.trialEndsAt).getTime() - Date.now();
            safe.trialDaysLeft = Math.max(0, Math.ceil(msLeft / (24 * 60 * 60 * 1000)));
            safe.trialExpired = msLeft <= 0;
        }
        res.json(safe);
    } catch (err) {
        res.status(500).json({ error: 'Internal server error', requestId: req.requestId });
    }
});

app.put('/api/me', auth, async (req, res) => {
    try {
        const rawUpdates = req.body;

        // Validate and sanitize inputs
        const allowedFields = ['name', 'email', 'template', 'templateId', 'subdomain', 'customDomain', 
            'data', 'social', 'mpesaMode', 'mpesaConsumerKey', 'mpesaConsumerSecret', 
            'mpesaShortcode', 'mpesaPasskey', 'googleSearchConsole', 'indexNowKey',
            'googleAnalyticsId', 'tiktokPixelId'];

        const sanitized = {};
        for (const key of allowedFields) {
            if (rawUpdates[key] !== undefined) {
                // Basic XSS prevention - strip script tags
                if (typeof rawUpdates[key] === 'string') {
                    // Strip ALL HTML tags — prevents stored XSS via <img onerror=...> etc.
                    sanitized[key] = rawUpdates[key]
                        .replace(/<[^>]*>/g, '')
                        .replace(/javascript:/gi, '')
                        .replace(/data:/gi, '')
                        .trim();
                } else if (key === 'data' && typeof rawUpdates[key] === 'object') {
                    // Deep-sanitize then upload any base64 images to Cloudinary
                    const sanitizedData = deepSanitize(rawUpdates[key]);
                    sanitized[key] = await uploadDataImages(sanitizedData);
                } else {
                    sanitized[key] = rawUpdates[key];
                }
            }
        }

        const updates = sanitized;
        // Normalize custom domain so it always matches the router (which sees a bare lowercase host).
        // Strip protocol, www., any path/slash, port, and whitespace; lowercase it.
        if (typeof updates.customDomain === 'string') {
            let cd = updates.customDomain.trim().toLowerCase()
                .replace(/^https?:\/\//, '')   // drop http:// or https://
                .replace(/^www\./, '')          // drop leading www.
                .replace(/[\/\\].*$/, '')       // drop anything from first slash onward
                .replace(/:.*$/, '')            // drop :port
                .trim();
            updates.customDomain = cd || null;  // empty string -> null so it clears cleanly
        }
        // Prevent changing critical fields
        delete updates._id;
        delete updates.isAdmin;
        delete updates.secretKey;
        delete updates.phone;

        const customer = await Customer.findByIdAndUpdate(
            req.user.id,
            { $set: updates, updatedAt: new Date() },
            { new: true }
        );

        // Auto-SEO: ping IndexNow if custom domain changed
        if (updates.customDomain && customer.indexNowKey) {
            pingIndexNow(`https://${updates.customDomain}`, customer.indexNowKey);
        }

        res.json(customer);
    } catch (err) {
        res.status(500).json({ error: 'Internal server error', requestId: req.requestId });
    }
});

// --- SITE SERVING ---
app.get('/api/site/:identifier', async (req, res) => {
    try {
        const { identifier } = req.params;
        const id = String(identifier || '').slice(0, 100);
        const customer = await Customer.findOne({
            $or: [{ subdomain: { $eq: id } }, { customDomain: { $eq: id } }]
        });

        if (!customer) {
            return res.status(404).send(`
                <!DOCTYPE html><html><head><title>Site Not Found</title><style>
                body{font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f5f5f5}
                .box{text-align:center;padding:40px;background:white;border-radius:16px;box-shadow:0 4px 20px rgba(0,0,0,0.1)}
                h1{color:#333;margin:0 0 10px}p{color:#666;margin:0}
                a{color:#4CAF50;text-decoration:none}
                </style></head><body>
                <div class="box"><h1>Site Not Found</h1><p>This SiteSawa site doesn't exist yet.</p><p><a href="https://sitesawa.com">Create yours at SiteSawa.com</a></p></div>
                </body></html>
            `);
        }

        const templateFile = resolveTemplateFile(customer);
        const templatePath = path.join(__dirname, templateFile);

        if (!fs.existsSync(templatePath)) {
            return res.status(500).json({ error: 'Template file not found' });
        }

        let template = fs.readFileSync(templatePath, 'utf8');
        // Use Mustache renderer for spec templates, legacy replacer for old ones
        let html = replacePlaceholders(template, customer);
        html = injectSiteSawaData(html, customer);

        // Serve sitemap if requested
        if (req.query.sitemap === '1') {
            res.set('Content-Type', 'application/xml');
            return res.send(generateSitemap(customer));
        }

        res.set('Content-Type', 'text/html');
        res.send(html);
    } catch (err) {
        res.status(500).json({ error: 'Internal server error', requestId: req.requestId });
    }
});

// Serve sitemap.xml for custom domains
app.get('/sitemap.xml', async (req, res) => {
    try {
        const host = String(req.headers.host || '').slice(0, 100);
        const customer = await Customer.findOne({
            $or: [{ customDomain: { $eq: host } }, { subdomain: { $eq: host.replace('.sitesawa.com', '') } }]
        });
        if (!customer) return res.status(404).send('Not found');
        res.set('Content-Type', 'application/xml');
        res.send(generateSitemap(customer));
    } catch (err) {
        res.status(500).send('Error');
    }
});

// --- SHOP SETTINGS ---
app.get('/api/shop-settings/:identifier', async (req, res) => {
    try {
        const sid = String(req.params.identifier || '').slice(0, 100);
        const customer = await Customer.findOne({
            $or: [{ subdomain: { $eq: sid } }, { customDomain: { $eq: sid } }]
        });
        if (!customer) return res.status(404).json({ error: 'Not found' });
        res.json({
            mpesaMode: customer.mpesaMode,
            paybillPhone: process.env.PAYBILL_PHONE || customer.phone,
            shippingEnabled: customer.data?.shippingEnabled !== false,
            shippingOptions: customer.data?.shippingOptions || { pickup: true, local: false, nationwide: false }
        });
    } catch (err) {
        res.status(500).json({ error: 'Internal server error', requestId: req.requestId });
    }
});

// --- ORDERS ---

// ============================================
// INVENTORY / STOCK HELPERS
// ============================================

// Atomically decrements stock for one product.
// Returns { ok: true } or { ok: false, reason: string }
// Products with stock == null or stock < 0 are treated as unlimited.
async function decrementStock(customerId, productId, quantity) {
    // Read current stock first (needed to detect unlimited vs depleted)
    const owner = await Customer.findById(customerId).select('data.products');
    const product = (owner?.data?.products || []).find(p => String(p.id) === String(productId));

    if (!product) return { ok: false, reason: `Product not found (id: ${productId})` };

    // Unlimited stock — no decrement needed
    if (product.stock == null || product.stock < 0) return { ok: true, unlimited: true };

    // Atomic conditional decrement: only modifies if stock >= quantity
    const result = await Customer.updateOne(
        {
            _id: customerId,
            'data.products': {
                $elemMatch: { id: String(productId), stock: { $gte: quantity } }
            }
        },
        { $inc: { 'data.products.$[elem].stock': -quantity } },
        { arrayFilters: [{ 'elem.id': String(productId), 'elem.stock': { $gte: quantity } }] }
    );

    if (result.modifiedCount === 0) {
        const remaining = product.stock;
        return {
            ok: false,
            reason: remaining === 0
                ? `"${product.name}" is out of stock`
                : `Only ${remaining} unit${remaining === 1 ? '' : 's'} of "${product.name}" available (requested ${quantity})`
        };
    }

    return { ok: true };
}

// Restores stock for a list of {productId, quantity} — used when an order is cancelled
// or when a later item in the same order fails and we need to roll back earlier decrements.
async function restoreStock(customerId, items) {
    for (const { productId, quantity } of items) {
        if (!productId) continue;
        await Customer.updateOne(
            { _id: customerId, 'data.products.id': String(productId) },
            { $inc: { 'data.products.$[elem].stock': quantity } },
            { arrayFilters: [{ 'elem.id': String(productId) }] }
        ).catch(err => console.error('[STOCK] Restore failed for', productId, err.message));
    }
}

app.post('/api/create-order', orderLimiter, async (req, res) => {
    try {
        const { customerId, items, shipping, shippingCost, paymentMethod, customerPhone, customerName } = req.body;

        const customer = await Customer.findById(customerId);
        if (!customer) return res.status(404).json({ error: 'Customer not found' });

        // SERVER-SIDE PRICE RECALCULATION — never trust client prices
        const storedProducts = customer.data?.products || [];
        let recalculatedTotal = 0;
        const validatedItems = [];
        for (const item of (items || [])) {
            const product = storedProducts.find(p => String(p.id) === String(item.id || item.name));
            if (!product && storedProducts.length > 0) continue; // skip unknown products if catalog exists
            const price = product ? parseFloat(String(product.price).replace(/[^0-9.]/g, '')) || 0
                                  : parseFloat(String(item.price || 0).replace(/[^0-9.]/g, '')) || 0;
            const qty = Math.max(1, Math.min(1000, parseInt(item.quantity) || 1));
            recalculatedTotal += price * qty;
            validatedItems.push({ id: product?.id || item.id || '', name: product?.name || item.name, price, quantity: qty, image: product?.image || item.image || '' });
        }
        const resolvedShippingCost = parseFloat(shippingCost) || 0;
        const total = recalculatedTotal + resolvedShippingCost;

        // STOCK VALIDATION — atomic decrements; roll back on first failure
        const decremented = [];
        for (const item of validatedItems) {
            if (!item.id) continue; // skip items with no product ID (service orders, etc.)
            const stockResult = await decrementStock(customerId, item.id, item.quantity);
            if (!stockResult.ok) {
                // Roll back any successful decrements from earlier items in this order
                await restoreStock(customerId, decremented);
                return res.status(409).json({ error: stockResult.reason });
            }
            if (!stockResult.unlimited) {
                decremented.push({ productId: item.id, quantity: item.quantity });
            }
        }

        const order = new Order({
            customerId,
            customerPhone: customerPhone || customer.phone,
            customerName: customerName || customer.name,
            items: validatedItems,
            total,
            shipping: shipping || 'pickup',
            shippingCost: shippingCost || 0,
            paymentMethod: paymentMethod || 'mpesa_simple',
            status: 'pending'
        });
        await order.save();

        // If API mode, initiate STK Push
        if (paymentMethod === 'mpesa_api' && customer.mpesaMode === 'api') {
            try {
                const stkRes = await initiateSTKPush(
                    customer,
                    customerPhone || customer.phone,
                    total,  // total already includes shippingCost
                    order._id
                );
                order.checkoutId = stkRes.CheckoutRequestID;
                await order.save();
                res.json({ success: true, orderId: order._id, checkoutId: stkRes.CheckoutRequestID, message: 'STK Push sent to phone' });
            } catch (stkErr) {
                console.error('STK Push failed:', stkErr.message);
                // Fall back to simple mode — stock stays decremented (order is still valid)
                order.paymentMethod = 'mpesa_simple';
                await order.save();
                res.json({ success: true, orderId: order._id, message: 'Order created. Pay via M-Pesa and confirm code.', fallback: true });
            }
        } else {
            res.json({ success: true, orderId: order._id, message: 'Order created. Pay via M-Pesa and confirm code.' });
        }
    } catch (err) {
        res.status(500).json({ error: 'Internal server error', requestId: req.requestId });
    }
});

// Confirm M-Pesa payment (simple mode)
app.post('/api/confirm-payment', auth, async (req, res) => {
    try {
        const { orderId, mpesaCode } = req.body;
        const order = await Order.findById(orderId);
        if (!order) return res.status(404).json({ error: 'Order not found' });
        // Only the shop owner (customer) can confirm their own orders
        if (String(order.customerId) !== String(req.user.id)) {
            return res.status(403).json({ error: 'Forbidden' });
        }

        order.status = 'paid';
        order.mpesaCode = mpesaCode;
        order.updatedAt = new Date();
        await order.save();

        // Send confirmation email
        const customer = await Customer.findById(order.customerId);
        if (customer && customer.email) {
            sendEmail(customer.email,
                'Payment Confirmed - SiteSawa Order',
                `<h2>Payment Received!</h2><p>Order #${order._id.toString().slice(-6)}</p><p>Amount: KES ${order.total}</p><p>M-Pesa Code: ${mpesaCode}</p><p>Status: Paid</p>`
            );
        }

        res.json({ success: true, status: 'paid' });
    } catch (err) {
        res.status(500).json({ error: 'Internal server error', requestId: req.requestId });
    }
});

// --- M-PESA CALLBACK (API MODE) ---
app.post('/api/mpesa/callback/:customerId', async (req, res) => {
    // Optional HMAC verification (when MPESA_WEBHOOK_SECRET is set)
    if (process.env.MPESA_WEBHOOK_SECRET) {
        const signature = req.headers['x-safaricom-signature'] || '';
        const payload = JSON.stringify(req.body);
        const expected = crypto
            .createHmac('sha256', process.env.MPESA_WEBHOOK_SECRET)
            .update(payload)
            .digest('hex');
        if (signature !== expected) {
            console.warn('[MPESA] Signature mismatch — rejecting callback');
            return res.status(400).json({ ResultCode: 1, ResultDesc: 'Invalid signature' });
        }
    }
    // NOTE: Respond AFTER processing so Safaricom receives an accurate result code.
    // Safaricom allows up to 30s before retrying — DB writes are well within that window.

    try {
        const { customerId } = req.params;
        const callbackData = req.body?.Body?.stkCallback;

        if (!callbackData) {
            console.log('Invalid callback structure');
            return;
        }

        const checkoutId = callbackData.CheckoutRequestID;
        const resultCode = callbackData.ResultCode;

        // Find order by checkoutId
        const order = await Order.findOne({ checkoutId });
        if (!order) {
            console.log('Order not found for checkout:', checkoutId);
            return;
        }

        if (String(resultCode) === '0') {
            const metadata = callbackData.CallbackMetadata?.Item || [];
            const mpesaCode = metadata.find(i => i.Name === 'MpesaReceiptNumber')?.Value;
            const amount = metadata.find(i => i.Name === 'Amount')?.Value;

            order.status = 'paid';
            order.mpesaCode = mpesaCode;
            order.mpesaTransactionId = mpesaCode;
            order.updatedAt = new Date();
            await order.save(); // DB write BEFORE we respond

            const customer = await Customer.findById(order.customerId);
            if (customer?.email) {
                sendEmail(customer.email,
                    'Payment Confirmed - SiteSawa Order',
                    `<h2>Payment Received!</h2><p>Order #${order._id.toString().slice(-6)}</p><p>Amount: KES ${amount || order.total}</p><p>M-Pesa Code: ${mpesaCode}</p><p>Status: Paid</p>`
                );
            }
            console.log('[MPESA] Payment confirmed — order:', order._id, 'code:', mpesaCode);
        } else {
            order.status = 'cancelled';
            order.updatedAt = new Date();
            await order.save();
            console.log('[MPESA] Payment failed — order:', order._id, 'reason:', callbackData.ResultDesc);
        }

        // Respond AFTER successful DB commit
        return res.json({ ResultCode: 0, ResultDesc: 'Accepted' });

    } catch (err) {
        console.error('[MPESA] Callback processing error:', err.message);
        // Respond with non-zero so Safaricom knows to retry
        if (!res.headersSent) res.json({ ResultCode: 1, ResultDesc: 'Processing error' });
    }
});

// --- PRODUCTS ---
app.post('/api/products', auth, async (req, res) => {
    try {
        const customer = await Customer.findById(req.user.id);
        if (!customer.data) customer.data = {};
        if (!customer.data.products) customer.data.products = [];

        const product = req.body;
        product.id = crypto.randomUUID();
        // Upload product image to Cloudinary if it's base64
        if (product.image) {
            product.image = await uploadImage(product.image, 'sitesawa/products');
        }
        customer.data.products.push(product);
        await customer.save();

        // Auto-SEO: ping IndexNow for new product
        if (customer.indexNowKey && customer.customDomain) {
            pingIndexNow(`https://${customer.customDomain}/#product-${customer.data.products.length - 1}`, customer.indexNowKey);
        }

        res.json({ success: true, product });
    } catch (err) {
        res.status(500).json({ error: 'Internal server error', requestId: req.requestId });
    }
});

app.delete('/api/products/:id', auth, async (req, res) => {
    try {
        const customer = await Customer.findById(req.user.id);
        if (customer.data?.products) {
            customer.data.products = customer.data.products.filter(p => p.id !== req.params.id);
            await customer.save();
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Internal server error', requestId: req.requestId });
    }
});

// --- SUPPORT TICKETS ---
app.post('/api/support', auth, async (req, res) => {
    try {
        const { subject, message } = req.body;
        const customer = await Customer.findById(req.user.id);
        const ticket = new SupportTicket({
            customerId: req.user.id,
            customerName: customer.name,
            customerPhone: customer.phone,
            subject, message
        });
        await ticket.save();
        res.json({ success: true, ticketId: ticket._id });
    } catch (err) {
        res.status(500).json({ error: 'Internal server error', requestId: req.requestId });
    }
});

app.get('/api/support', auth, async (req, res) => {
    try {
        const tickets = await SupportTicket.find({ customerId: req.user.id }).sort({ createdAt: -1 });
        res.json({ tickets, total: tickets.length });
    } catch (err) {
        res.status(500).json({ error: 'Internal server error', requestId: req.requestId });
    }
});

app.post('/api/support/send', auth, async (req, res) => {
    try {
        const { ticketId, message } = req.body;
        const ticket = await SupportTicket.findOne({ _id: ticketId, customerId: req.user.id });
        if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
        ticket.replies.push({ from: 'customer', message });
        await ticket.save();
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Internal server error', requestId: req.requestId });
    }
});

app.get('/api/support/messages', auth, async (req, res) => {
    try {
        const ticket = await SupportTicket.findOne({ customerId: req.user.id }).sort({ createdAt: -1 });
        res.json(ticket?.replies || []);
    } catch (err) {
        res.status(500).json({ error: 'Internal server error', requestId: req.requestId });
    }
});

// --- ADMIN ROUTES ---
app.get('/api/admin/customers', adminAuth, async (req, res) => {
    try {
        const customers = await Customer.find().sort({ createdAt: -1 });
        res.json({ customers, total: customers.length });
    } catch (err) {
        res.status(500).json({ error: 'Internal server error', requestId: req.requestId });
    }
});

app.delete('/api/admin/customers/:id', adminAuth, async (req, res) => {
    try {
        await Customer.findByIdAndDelete(req.params.id);
        await Order.deleteMany({ customerId: req.params.id });
        await SupportTicket.deleteMany({ customerId: req.params.id });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Internal server error', requestId: req.requestId });
    }
});

// ADMIN: full details for ONE customer (for the support panel)
app.get('/api/admin/customers/:id', adminAuth, async (req, res) => {
    try {
        const customer = await Customer.findById(req.params.id).lean();
        if (!customer) return res.status(404).json({ error: 'Customer not found' });
        delete customer.secretKey;
        delete customer.recoveryOTP;
        delete customer.recoveryOTPExpiry;
        delete customer.mpesaConsumerKey;
        delete customer.mpesaConsumerSecret;
        delete customer.mpesaPasskey;
        const orders = await Order.find({ customerId: req.params.id }).sort({ createdAt: -1 }).limit(20).lean();
        // trial countdown
        if (customer.paymentStatus !== 'paid' && customer.trialEndsAt) {
            const msLeft = new Date(customer.trialEndsAt).getTime() - Date.now();
            customer.trialDaysLeft = Math.max(0, Math.ceil(msLeft / (24*60*60*1000)));
            customer.trialExpired = msLeft <= 0;
        }
        res.json({ customer, orders });
    } catch (err) {
        res.status(500).json({ error: 'Internal server error', requestId: req.requestId });
    }
});

// ADMIN: update ANY customer field — full control for phone support
app.put('/api/admin/customers/:id', adminAuth, async (req, res) => {
    try {
        const customer = await Customer.findById(req.params.id);
        if (!customer) return res.status(404).json({ error: 'Customer not found' });

        const b = req.body || {};
        const allowed = ['name', 'email', 'phone', 'template', 'subdomain', 'customDomain', 'paymentStatus'];
        const changes = [];

        for (const field of allowed) {
            if (b[field] === undefined) continue;
            let val = b[field];
            if (field === 'email') val = String(val).toLowerCase().trim();
            if (field === 'template') val = String(val).toUpperCase();
            if (field === 'subdomain') val = String(val).toLowerCase().replace(/[^a-z0-9]/g, '');
            if (field === 'customDomain') {
                val = String(val).trim().toLowerCase()
                    .replace(/^https?:\/\//, '').replace(/^www\./, '')
                    .replace(/[\/\\].*$/, '').replace(/:.*$/, '').trim() || null;
            }
            // uniqueness guards
            if (field === 'email' && val) {
                const clash = await Customer.findOne({ email: val, _id: { $ne: customer._id } });
                if (clash) return res.status(409).json({ error: 'Another account already uses that email' });
            }
            if (field === 'subdomain' && val) {
                const clash = await Customer.findOne({ subdomain: val, _id: { $ne: customer._id } });
                if (clash) return res.status(409).json({ error: 'Another account already uses that subdomain' });
            }
            if (String(customer[field]) !== String(val)) changes.push(field);
            customer[field] = val;
        }

        // Trial controls
        if (b.extendTrialDays !== undefined) {
            const days = parseInt(b.extendTrialDays, 10) || 0;
            const base = (customer.trialEndsAt && new Date(customer.trialEndsAt) > new Date())
                ? new Date(customer.trialEndsAt) : new Date();
            customer.trialEndsAt = new Date(base.getTime() + days * 24*60*60*1000);
            changes.push('trialEndsAt');
        }
        if (b.endTrialNow === true) {
            customer.trialEndsAt = new Date(Date.now() - 1000);
            changes.push('trialEndsAt(ended)');
        }
        // Mark paid / unpaid shortcuts
        if (b.markPaid === true) { customer.paymentStatus = 'paid'; changes.push('paymentStatus(paid)'); }
        if (b.markTrial === true) {
            customer.paymentStatus = 'trial';
            customer.trialEndsAt = new Date(Date.now() + 7*24*60*60*1000);
            changes.push('paymentStatus(trial)');
        }

        await customer.save();
        console.log(`[ADMIN] ${req.params.id} updated:`, changes.join(', '));
        res.json({ success: true, changed: changes });
    } catch (err) {
        console.error('[ADMIN UPDATE]', err.message);
        res.status(500).json({ error: err.message || 'Update failed', requestId: req.requestId });
    }
});

// ADMIN: reset a customer's secret key (generate a new one, return it once)
app.post('/api/admin/customers/:id/reset-key', adminAuth, async (req, res) => {
    try {
        const customer = await Customer.findById(req.params.id);
        if (!customer) return res.status(404).json({ error: 'Customer not found' });
        const newKey = generateSecretKey();
        customer.secretKey = await bcrypt.hash(newKey, 10);
        await customer.save();
        // email it to them too, if they have an email
        if (customer.email) {
            sendEmail(customer.email, 'Your SiteSawa secret key was reset',
                `<h2>New secret key</h2><p>Hi ${customer.name || 'there'}, your SiteSawa secret key has been reset.</p>
                 <p><strong>New key:</strong> ${newKey}</p>
                 <p>Sign in at <a href="https://www.sitesawa.com/login.html">sitesawa.com/login.html</a> with your email and this key.</p>`
            ).catch(()=>{});
        }
        console.log(`[ADMIN] reset key for ${req.params.id}`);
        res.json({ success: true, secretKey: newKey });
    } catch (err) {
        res.status(500).json({ error: 'Internal server error', requestId: req.requestId });
    }
});

app.get('/api/admin/support', adminAuth, async (req, res) => {
    try {
        const tickets = await SupportTicket.find().sort({ createdAt: -1 });
        res.json({ tickets, total: tickets.length });
    } catch (err) {
        res.status(500).json({ error: 'Internal server error', requestId: req.requestId });
    }
});

app.put('/api/admin/support/:ticketId', adminAuth, async (req, res) => {
    try {
        const ticket = await SupportTicket.findByIdAndUpdate(
            req.params.ticketId,
            { status: req.body.status },
            { new: true }
        );
        res.json(ticket);
    } catch (err) {
        res.status(500).json({ error: 'Internal server error', requestId: req.requestId });
    }
});

app.post('/api/admin/support/:customerId/reply', adminAuth, async (req, res) => {
    try {
        const { message } = req.body;
        const ticket = await SupportTicket.findOne({ customerId: req.params.customerId }).sort({ createdAt: -1 });
        if (!ticket) return res.status(404).json({ error: 'No ticket found' });
        ticket.replies.push({ from: 'admin', message });
        await ticket.save();
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Internal server error', requestId: req.requestId });
    }
});

app.post('/api/admin/support/:customerId/resolve', adminAuth, async (req, res) => {
    try {
        await SupportTicket.updateMany(
            { customerId: req.params.customerId },
            { status: 'resolved' }
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Internal server error', requestId: req.requestId });
    }
});

// --- SEO SETUP ---
app.post('/api/seo/setup', auth, async (req, res) => {
    try {
        const { googleSearchConsole, indexNowKey } = req.body;
        const customer = await Customer.findByIdAndUpdate(
            req.user.id,
            { googleSearchConsole, indexNowKey },
            { new: true }
        );

        // If IndexNow key provided, create verification file
        if (indexNowKey && customer.customDomain) {
            // Note: In production, you'd write this to your web server root
            console.log(`IndexNow key: ${indexNowKey} for ${customer.customDomain}`);
        }

        // Submit to Google Search Console if configured
        if (googleSearchConsole && customer.customDomain) {
            submitToGoogleSearchConsole(`https://${customer.customDomain}`, customer.customDomain);
        }

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Internal server error', requestId: req.requestId });
    }
});


// ============================================
// KEY RECOVERY
// ============================================
app.post('/api/recover-key', authLimiter, async (req, res) => {
    try {
        // Accept email (preferred, matches login) or phone (legacy fallback)
        const email = (req.body.email || '').toLowerCase().trim();
        const phone = req.body.phone ? String(req.body.phone).slice(0, 20) : '';
        if (!email && !phone) return res.status(400).json({ error: 'Email required' });

        const query = email ? { email: { $eq: email } } : { phone: { $eq: phone } };
        const customer = await Customer.findOne(query);
        // Always return success (don't reveal whether an account exists)
        if (!customer || !customer.email) return res.json({ success: true, message: 'If that email is registered, a code has been sent.' });

        const otp = String(crypto.randomInt(100000, 999999));
        customer.recoveryOTP = {
            code: await bcrypt.hash(otp, 12),
            expires: new Date(Date.now() + 15 * 60 * 1000)
        };
        await customer.save();

        await sendEmail(customer.email, 'SiteSawa — Key Recovery Code',
            `<h2>Key Recovery</h2><p>Your 6-digit code:</p>
             <h1 style="letter-spacing:8px;font-size:36px;color:#111">${otp}</h1>
             <p>Expires in <strong>15 minutes</strong>. If you didn't request this, ignore this email.</p>`
        );
        console.log(`[RECOVERY] OTP for ${customer.email}: ${otp}`);
        res.json({ success: true, message: 'If that email is registered, a code has been sent.' });
    } catch (err) { res.status(500).json({ error: 'Internal server error', requestId: req.requestId }); }
});

app.post('/api/reset-key', authLimiter, async (req, res) => {
    try {
        const { code, newKey } = req.body;
        const email = (req.body.email || '').toLowerCase().trim();
        const phone = req.body.phone ? String(req.body.phone).slice(0, 20) : '';
        if ((!email && !phone) || !code || !newKey) return res.status(400).json({ error: 'email, code and newKey required' });
        if (newKey.length < 6) return res.status(400).json({ error: 'New key must be at least 6 characters' });

        const query = email ? { email: { $eq: email } } : { phone: { $eq: phone } };
        const customer = await Customer.findOne(query);
        if (!customer?.recoveryOTP?.code) return res.status(400).json({ error: 'Invalid or expired code' });

        if (new Date() > customer.recoveryOTP.expires) {
            customer.recoveryOTP = undefined;
            await customer.save();
            return res.status(400).json({ error: 'Code has expired. Request a new one.' });
        }
        if (!await bcrypt.compare(String(code), customer.recoveryOTP.code)) {
            return res.status(400).json({ error: 'Invalid code' });
        }
        customer.secretKey = await bcrypt.hash(newKey, 10);
        customer.recoveryOTP = undefined;
        await customer.save();
        res.json({ success: true, message: 'Key updated. You can now sign in.' });
    } catch (err) { res.status(500).json({ error: 'Internal server error', requestId: req.requestId }); }
});

// Public JSON endpoint for spec template client-side hydration
app.get('/api/customer/:identifier', async (req, res) => {
    try {
        const id = String(req.params.identifier || '').slice(0, 100);
        const customer = await Customer.findOne({
            $or: [{ subdomain: { $eq: id } }, { customDomain: { $eq: id } }]
        });
        if (!customer) return res.status(404).json({ error: 'Not found' });
        // Strip sensitive fields; expose stock levels so templates can show "Out of Stock"
        const safeData = { ...(customer.data || {}) };
        if (safeData.products) {
            safeData.products = safeData.products.map(p => ({
                id: p.id, name: p.name, price: p.price,
                description: p.description, image: p.image,
                stock: p.stock ?? null // null = unlimited
            }));
        }
        res.json({
            name: customer.name, phone: customer.phone, email: customer.email,
            template: customer.template, subdomain: customer.subdomain,
            customDomain: customer.customDomain, data: safeData,
            social: customer.social || {},
            googleAnalyticsId: customer.googleAnalyticsId,
            tiktokPixelId: customer.tiktokPixelId
        });
    } catch (err) { res.status(500).json({ error: 'Internal server error', requestId: req.requestId }); }
});

// DELETE /api/me — Kenya Data Protection Act 2019 + GDPR right to erasure
app.delete('/api/me', auth, async (req, res) => {
    try {
        const { confirm } = req.body;
        if (confirm !== 'DELETE_MY_ACCOUNT') {
            return res.status(400).json({ error: 'Send { confirm: "DELETE_MY_ACCOUNT" } to confirm deletion' });
        }
        await Order.deleteMany({ customerId: req.user.id });
        await SupportTicket.deleteMany({ customerId: req.user.id });
        await Customer.findByIdAndDelete(req.user.id);
        res.json({ success: true, message: 'Account and all associated data deleted.' });
    } catch (err) { res.status(500).json({ error: 'Internal server error', requestId: req.requestId }); }
});



// ============================================
// MARKETING CHECKOUT — /api/checkout
// Called by the React marketing site.
// Validates input, creates customer record,
// initiates M-Pesa STK push, returns checkoutId.
// ============================================
app.post('/api/checkout', async (req, res) => {
    try {
        const { name, email, phone, plan, templateId: reqTemplateId } = req.body;

        // Validate required fields
        if (!name?.trim())  return res.status(400).json({ error: 'Name is required' });
        if (!email?.trim()) return res.status(400).json({ error: 'Email is required' });
        if (!phone)         return res.status(400).json({ error: 'Phone number is required' });
        if (!plan)          return res.status(400).json({ error: 'Plan is required' });

        // Validate phone format (E.164 or 07XX/01XX)
        const cleanPhone = String(phone).replace(/\s/g, '');
        if (!/^(254[0-9]{9}|0[17][0-9]{8})$/.test(cleanPhone)) {
            return res.status(400).json({ error: 'Enter a valid Safaricom number' });
        }
        const normPhone = cleanPhone.startsWith('0') ? '254' + cleanPhone.slice(1) : cleanPhone;

        // Check if EMAIL already registered (email is the login — phone can be reused,
        // since people often pay with someone else's M-Pesa number)
        const existing = await Customer.findOne({ email: { $eq: email.trim().toLowerCase() } });
        if (existing) {
            return res.status(409).json({ error: 'This email already has a SiteSawa account. Sign in instead.' });
        }

        // Valid plans
        const planPrices = { PERSONAL: 7000, BUSINESS: 8000, ECOMMERCE: 9000 };
        const planPrice = planPrices[plan.toUpperCase()];
        const amount = planPrice; // Always use server-side price, never trust client
        if (!planPrice) return res.status(400).json({ error: 'Invalid plan' });

        // Generate secret key for the customer
        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        const rawKey = Array.from({ length: 8 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
        const hashedKey = await bcrypt.hash(rawKey, 10);

        // Generate a unique subdomain from name
        const subdomain = name.trim().toLowerCase()
            .replace(/[^a-z0-9]/g, '-')
            .replace(/-+/g, '-')
            .replace(/^-|-$/g, '')
            .slice(0, 30) + '-' + Math.random().toString(36).slice(2, 6);

        // Create pending customer record
        // Derive templateId from plan if not provided (frontend can pass e.g. 'biz-agency')
        const resolvedTemplateId = (reqTemplateId && TEMPLATE_FILES[reqTemplateId])
            ? reqTemplateId
            : '';

        const customer = new Customer({
            name:       name.trim(),
            email:      email.trim().toLowerCase(),
            phone:      normPhone,
            template:   plan.toUpperCase(),
            templateId: resolvedTemplateId,
            subdomain,
            secretKey:  hashedKey,
            paymentStatus: 'trial',
            trialEndsAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // free for 7 days
        });
        await customer.save();

        const checkoutId = customer._id.toString();

        // Initiate M-Pesa STK push if configured
        if (process.env.MPESA_CONSUMER_KEY && process.env.MPESA_CONSUMER_SECRET) {
            try {
                const mpesaBase = process.env.MPESA_ENV === 'production'
                    ? 'https://api.safaricom.co.ke'
                    : 'https://sandbox.safaricom.co.ke';
                const authRes = await axios.get(`${mpesaBase}/oauth/v1/generate?grant_type=client_credentials`, {
                    auth: { username: process.env.MPESA_CONSUMER_KEY, password: process.env.MPESA_CONSUMER_SECRET },
                });
                const token = authRes.data.access_token;
                const shortcode = process.env.MPESA_SHORTCODE;
                const passkey   = process.env.MPESA_PASSKEY;
                const timestamp = new Date().toISOString().replace(/[-:T.Z]/g,'').slice(0,14);
                const password  = Buffer.from(shortcode + passkey + timestamp).toString('base64');
                const callbackURL = `${process.env.BASE_URL || 'https://sitesawa.com'}/api/mpesa/checkout-callback/${checkoutId}`;

                await axios.post(`${mpesaBase}/mpesa/stkpush/v1/processrequest`, {
                    BusinessShortCode: shortcode,
                    Password:          password,
                    Timestamp:         timestamp,
                    TransactionType:   'CustomerPayBillOnline',
                    Amount:            planPrice,
                    PartyA:            normPhone,
                    PartyB:            shortcode,
                    PhoneNumber:       normPhone,
                    CallBackURL:       callbackURL,
                    AccountReference:  'SiteSawa',
                    TransactionDesc:   `${plan.toUpperCase()} Plan`,
                }, { headers: { Authorization: `Bearer ${token}` } });

                await Customer.updateOne({ _id: customer._id }, { $set: { mpesaCheckoutId: checkoutId } });
            } catch (mpesaErr) {
                console.error('[CHECKOUT] M-Pesa STK error:', mpesaErr.message);
                // Continue — customer record created, admin can confirm manually
            }
        } else {
            // Dev mode: auto-confirm after 5 seconds
            setTimeout(async () => {
                await Customer.updateOne(
                    { _id: customer._id },
                    { $set: { paymentStatus: 'paid' } }
                );
            }, 5000);
        }

        // Send key to email
        sendEmail(email.trim(), 'Welcome to SiteSawa — Your Secret Key',
            `<h2>Welcome to SiteSawa, ${name}! 🇰🇪</h2>
             <p>Your website is being activated. Here is your secret key to access your dashboard:</p>
             <div style="background:#111;border:1px solid #333;border-radius:10px;padding:16px;text-align:center;margin:20px 0">
               <code style="font-size:28px;letter-spacing:8px;color:#bef264;font-family:monospace">${rawKey}</code>
             </div>
             <p>⚠️ <strong>Save this key</strong> — it is your password. We cannot recover it if lost.</p>
             <p>Once payment is confirmed, visit <a href="https://sitesawa.com/login.html">sitesawa.com/login.html</a> to sign in.</p>`
        ).catch(err => console.error('[CHECKOUT] Email failed:', err.message));

        res.json({ checkoutId, secretKey: rawKey, subdomain });

    } catch (err) {
        console.error('[CHECKOUT]', err.message);
        res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
});

// Poll endpoint — frontend checks payment status
app.get('/api/checkout/status/:checkoutId', orderLimiter, async (req, res) => {
    try {
        const id = String(req.params.checkoutId).slice(0, 50);
        const customer = await Customer.findById(id).select('paymentStatus secretKey phone');
        if (!customer) return res.status(404).json({ error: 'Not found' });

        res.json({
            status:     customer.paymentStatus || 'pending',
            customerId: id,
            // Only expose key if paid
            secretKey:  customer.paymentStatus === 'paid' ? undefined : undefined,
        });
    } catch (err) {
        res.status(500).json({ error: 'Status check failed' });
    }
});

// M-Pesa callback for checkout (different from order callback)
app.post('/api/mpesa/checkout-callback/:checkoutId', async (req, res) => {
    // Validate request comes from Safaricom IP range or shared secret
    const sharedSecret = process.env.MPESA_CALLBACK_SECRET || '';
    if (sharedSecret) {
        const incoming = req.headers['x-callback-secret'] || '';
        if (incoming !== sharedSecret) {
            console.warn('[CHECKOUT CALLBACK] Rejected — invalid secret');
            return res.status(400).json({ ResultCode: 1, ResultDesc: 'Rejected' });
        }
    }
    // Acknowledge immediately — Safaricom retries if we don't respond fast
    res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
    try {
        const resultCode = req.body?.Body?.stkCallback?.ResultCode;
        const id = String(req.params.checkoutId).slice(0, 50);
        if (String(resultCode) === '0') {
            await Customer.updateOne({ _id: id }, { $set: { paymentStatus: 'paid' } });
            console.log('[CHECKOUT] Payment confirmed for', id);
            // Send secret key email now that payment is confirmed
            try {
                const customer = await Customer.findById(id).select('email name phone secretKey template');
                if (customer && customer.email) {
                    // The secretKey stored is hashed — we cannot recover the raw key.
                    // The raw key was already returned in the API response at checkout time.
                    // Send a confirmation email with login instructions.
                    sendEmail(customer.email,
                        'Payment confirmed — Your SiteSawa website is live! 🎉',
                        `<div style="font-family:sans-serif;max-width:520px;margin:0 auto">
                        <h2 style="color:#bef264;background:#1a1712;padding:20px;border-radius:8px">🎉 Your website is live!</h2>
                        <p>Hi ${customer.name || 'there'},</p>
                        <p>Your payment has been confirmed and your SiteSawa website is now active.</p>
                        <p><strong>To log in to your dashboard:</strong></p>
                        <ul>
                          <li>Go to <a href="https://www.sitesawa.com/login.html">sitesawa.com/login.html</a></li>
                          <li>Enter your phone number: <strong>${customer.phone}</strong></li>
                          <li>Enter the secret key that was shown on screen when you signed up</li>
                        </ul>
                        <p style="background:#fff3cd;padding:12px;border-radius:6px;color:#856404">
                          ⚠️ <strong>Can't find your key?</strong> Use the "Forgot key?" link on the login page to request a new one sent to this email address.
                        </p>
                        <p>Plan: <strong>${customer.template}</strong></p>
                        <p>Welcome to SiteSawa! 🇰🇪</p>
                        </div>`
                    );
                }
            } catch (emailErr) {
                console.error('[CHECKOUT] Post-payment email failed:', emailErr.message);
            }
        } else {
            await Customer.updateOne({ _id: id }, { $set: { paymentStatus: 'failed' } });
            console.log('[CHECKOUT] Payment failed/cancelled for', id);
        }
    } catch (err) {
        console.error('[CHECKOUT CALLBACK]', err.message);
    }
});

// ============================================
// PLAN CHANGE (upgrade / downgrade) — logged-in customer pays full new price
// ============================================
app.post('/api/change-plan', auth, async (req, res) => {
    try {
        const { plan } = req.body;
        const newPlan = String(plan || '').toUpperCase();

        const planPrices = { PERSONAL: 7000, BUSINESS: 8000, ECOMMERCE: 9000 };
        if (!planPrices[newPlan]) return res.status(400).json({ error: 'Invalid plan' });

        const customer = await Customer.findById(req.user.id);
        if (!customer) return res.status(404).json({ error: 'Account not found' });

        if (customer.template === newPlan) {
            return res.status(400).json({ error: `You are already on the ${newPlan} plan` });
        }

        const planPrice = planPrices[newPlan];
        const normPhone = customer.phone;
        // Track the requested plan change until payment confirms
        await Customer.updateOne({ _id: customer._id }, { $set: { pendingPlan: newPlan } });

        // Fire STK push for the full new-plan price
        if (process.env.MPESA_CONSUMER_KEY && process.env.MPESA_CONSUMER_SECRET) {
            try {
                const mpesaBase = process.env.MPESA_ENV === 'production'
                    ? 'https://api.safaricom.co.ke'
                    : 'https://sandbox.safaricom.co.ke';
                const authRes = await axios.get(`${mpesaBase}/oauth/v1/generate?grant_type=client_credentials`, {
                    auth: { username: process.env.MPESA_CONSUMER_KEY, password: process.env.MPESA_CONSUMER_SECRET },
                });
                const token = authRes.data.access_token;
                const shortcode = process.env.MPESA_SHORTCODE;
                const passkey   = process.env.MPESA_PASSKEY;
                const timestamp = new Date().toISOString().replace(/[-:T.Z]/g,'').slice(0,14);
                const password  = Buffer.from(shortcode + passkey + timestamp).toString('base64');
                const callbackURL = `${process.env.BASE_URL || 'https://sitesawa.com'}/api/mpesa/plan-callback/${customer._id}`;

                await axios.post(`${mpesaBase}/mpesa/stkpush/v1/processrequest`, {
                    BusinessShortCode: shortcode,
                    Password:          password,
                    Timestamp:         timestamp,
                    TransactionType:   'CustomerPayBillOnline',
                    Amount:            planPrice,
                    PartyA:            normPhone,
                    PartyB:            shortcode,
                    PhoneNumber:       normPhone,
                    CallBackURL:       callbackURL,
                    AccountReference:  'SiteSawa',
                    TransactionDesc:   `${newPlan} Plan`,
                }, { headers: { Authorization: `Bearer ${token}` } });
            } catch (mpesaErr) {
                console.error('[PLAN CHANGE] M-Pesa STK error:', mpesaErr.message);
                return res.status(502).json({ error: 'Could not start M-Pesa payment. Try again.' });
            }
        } else {
            // Dev mode: auto-apply after 5s
            setTimeout(async () => {
                await Customer.updateOne({ _id: customer._id }, { $set: { template: newPlan }, $unset: { pendingPlan: '' } });
            }, 5000);
        }

        res.json({ ok: true, plan: newPlan, amount: planPrice, phone: normPhone });
    } catch (err) {
        console.error('[PLAN CHANGE]', err.message);
        res.status(500).json({ error: 'Plan change failed' });
    }
});

// M-Pesa callback for a plan change — switch the plan once paid
app.post('/api/mpesa/plan-callback/:customerId', async (req, res) => {
    const sharedSecret = process.env.MPESA_CALLBACK_SECRET || '';
    if (sharedSecret) {
        const incoming = req.headers['x-callback-secret'] || '';
        if (incoming !== sharedSecret) {
            console.warn('[PLAN CALLBACK] Rejected — invalid secret');
            return res.status(400).json({ ResultCode: 1, ResultDesc: 'Rejected' });
        }
    }
    res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
    try {
        const resultCode = req.body?.Body?.stkCallback?.ResultCode;
        const id = String(req.params.customerId).slice(0, 50);
        const customer = await Customer.findById(id).select('email name template pendingPlan');
        if (!customer) return;

        if (String(resultCode) === '0' && customer.pendingPlan) {
            const oldPlan = customer.template;
            const newPlan = customer.pendingPlan;
            // Paying for a plan also lifts any free-trial gate
            await Customer.updateOne({ _id: id }, { $set: { template: newPlan, paymentStatus: 'paid' }, $unset: { pendingPlan: '' } });
            console.log(`[PLAN CHANGE] ${id}: ${oldPlan} → ${newPlan} (paid)`);

            // Confirmation email
            if (customer.email) {
                const direction = ({ PERSONAL: 1, BUSINESS: 2, ECOMMERCE: 3 }[newPlan]
                                 > { PERSONAL: 1, BUSINESS: 2, ECOMMERCE: 3 }[oldPlan]) ? 'upgraded' : 'changed';
                const planLabel = { PERSONAL: 'Personal', BUSINESS: 'Business', ECOMMERCE: 'E-Commerce' }[newPlan];
                sendEmail(customer.email,
                    `Your SiteSawa plan is now ${planLabel}`,
                    `<div style="font-family:sans-serif;max-width:520px;margin:0 auto">
                     <h2 style="color:#bef264;background:#1a1712;padding:20px;border-radius:8px">Plan ${direction} ✓</h2>
                     <p>Hi ${customer.name || 'there'},</p>
                     <p>Your SiteSawa plan has been ${direction} to <strong>${planLabel}</strong>. The new features are active on your dashboard right away.</p>
                     <p><a href="https://www.sitesawa.com/login.html">Log in to your dashboard →</a></p>
                     <p>Thank you for growing with SiteSawa! 🇰🇪</p>
                     </div>`
                ).catch(e => console.error('[PLAN CHANGE] email failed:', e.message));
            }
        } else {
            // payment failed/cancelled — clear the pending plan, keep current plan
            await Customer.updateOne({ _id: id }, { $unset: { pendingPlan: '' } });
            console.log(`[PLAN CHANGE] payment failed for ${id} — plan unchanged`);
        }
    } catch (err) {
        console.error('[PLAN CALLBACK]', err.message);
    }
});

// --- STATS FOR ADMIN DASHBOARD ---
app.get('/api/admin/stats', adminAuth, async (req, res) => {
    try {
        const totalCustomers = await Customer.countDocuments();
        const totalOrders = await Order.countDocuments();
        const paidOrders = await Order.countDocuments({ status: 'paid' });
        const totalRevenue = await Order.aggregate([
            { $match: { status: 'paid' } },
            { $group: { _id: null, total: { $sum: '$total' } } }
        ]);
        const revenueByTemplate = await Order.aggregate([
            { $match: { status: 'paid' } },
            {
                $lookup: {
                    from: 'customers',
                    localField: 'customerId',
                    foreignField: '_id',
                    as: 'customer'
                }
            },
            { $unwind: '$customer' },
            { $group: { _id: '$customer.template', revenue: { $sum: '$total' }, count: { $sum: 1 } } }
        ]);
        const monthlyRevenue = await Order.aggregate([
            { $match: { status: 'paid' } },
            {
                $group: {
                    _id: { year: { $year: '$createdAt' }, month: { $month: '$createdAt' } },
                    revenue: { $sum: '$total' },
                    count: { $sum: 1 }
                }
            },
            { $sort: { '_id.year': -1, '_id.month': -1 } },
            { $limit: 12 }
        ]);

        res.json({
            totalCustomers,
            totalOrders,
            paidOrders,
            totalRevenue: totalRevenue[0]?.total || 0,
            revenueByTemplate,
            monthlyRevenue,
            avgOrderValue: paidOrders > 0 ? (totalRevenue[0]?.total || 0) / paidOrders : 0,
            conversionRate: totalOrders > 0 ? (paidOrders / totalOrders * 100).toFixed(1) : 0
        });
    } catch (err) {
        res.status(500).json({ error: 'Internal server error', requestId: req.requestId });
    }
});


// --- CUSTOMER ORDERS ---
// Admin orders endpoint
app.get('/api/admin/orders', adminAuth, async (req, res) => {
    try {
        const page  = parseInt(req.query.page) || 1;
        const limit = 50;
        const orders = await Order.find({})
            .sort({ createdAt: -1 })
            .skip((page - 1) * limit)
            .limit(limit)
            .lean();
        const total = await Order.countDocuments();
        res.json({ orders, total, page });
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/api/orders', auth, async (req, res) => {
    try {
        const orders = await Order.find({ customerId: req.user.id }).sort({ createdAt: -1 }).limit(100);
        res.json(orders);
    } catch (err) {
        res.status(500).json({ error: 'Internal server error', requestId: req.requestId });
    }
});

app.put('/api/orders/:id/status', auth, async (req, res) => {
    try {
        const { status } = req.body;
        const allowed = ['processing', 'shipped', 'delivered', 'cancelled'];
        if (!allowed.includes(status)) return res.status(400).json({ error: 'Invalid status' });
        const order = await Order.findOneAndUpdate(
            { _id: req.params.id, customerId: req.user.id },
            { status, updatedAt: new Date() },
            { new: true }
        );
        if (!order) return res.status(404).json({ error: 'Order not found' });

        // Restore stock when an order is cancelled
        if (status === 'cancelled' && order.items?.length) {
            const itemsToRestore = order.items
                .filter(i => i.id)
                .map(i => ({ productId: i.id, quantity: i.quantity }));
            if (itemsToRestore.length) await restoreStock(order.customerId, itemsToRestore);
        }

        res.json(order);
    } catch (err) {
        res.status(500).json({ error: 'Internal server error', requestId: req.requestId });
    }
});

// --- START SERVER ---
const PORT = process.env.PORT || 3000;


// ── 404 CATCH-ALL ─────────────────────────────────────────────────────
// Any unmatched route returns a branded HTML page instead of a platform error.
app.use((req, res) => {
    // API routes return JSON 404
    if (req.path.startsWith('/api/')) {
        return res.status(404).json({ error: 'Not found' });
    }
    // Everything else returns a branded HTML page
    res.status(404).send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Page Not Found — SiteSawa</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:'Inter',sans-serif;background:#0a0a0a;color:#eeeef5;min-height:100vh;display:flex;align-items:center;justify-content:center;text-align:center;padding:20px}
    .wrap{max-width:400px}
    .logo{font-size:22px;font-weight:900;letter-spacing:-.5px;color:#bef264;margin-bottom:40px}
    h1{font-size:72px;font-weight:900;color:#1a1a1a;line-height:1;margin-bottom:8px}
    p{color:#666;font-size:16px;margin-bottom:32px}
    a{display:inline-block;padding:12px 28px;background:#bef264;color:#0a0a0a;border-radius:8px;font-weight:700;text-decoration:none;font-size:14px}
    a:hover{background:#d4f57a}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="logo">SiteSawa 🇰🇪</div>
    <h1>404</h1>
    <p>This page doesn't exist.</p>
    <a href="/">Go home →</a>
  </div>
</body>
</html>`);
});


// ── GLOBAL ERROR HANDLER ──────────────────────────────────────────────
// Strips stack traces and internal details before sending to client.
// Logs full error server-side with request ID for debugging.
app.use((err, req, res, next) => {
    const id = req.requestId || '?';
    console.error(`[ERROR] reqId=${id} path=${req.path}`, err);
    const status = err.status || err.statusCode || 500;
    // Never expose stack traces or mongoose internals to client
    const safeMsg = status < 500
        ? (err.message || 'Bad request')
        : 'Something went wrong. Please try again.';
    res.status(status).json({ error: safeMsg, requestId: id });
});

// ============================================
// DAILY TRIAL-ENDING REMINDER
// Checks once a day for trials expiring within ~2 days and emails them once.
// Lightweight in-process scheduler — no external cron needed.
// ============================================
async function sendTrialReminders() {
    try {
        const now = Date.now();
        const twoDays = now + 2 * 24 * 60 * 60 * 1000;
        const soon = await Customer.find({
            paymentStatus: { $ne: 'paid' },
            trialReminderSent: { $ne: true },
            trialEndsAt: { $gte: new Date(now), $lte: new Date(twoDays) },
        }).select('email name trialEndsAt template');

        for (const c of soon) {
            if (!c.email) continue;
            const daysLeft = Math.max(1, Math.ceil((new Date(c.trialEndsAt).getTime() - now) / (24*60*60*1000)));
            const planLabel = { PERSONAL: 'Personal', BUSINESS: 'Business', ECOMMERCE: 'E-Commerce' }[c.template] || 'your';
            const planPrice = { PERSONAL: '7,000', BUSINESS: '8,000', ECOMMERCE: '9,000' }[c.template] || '';
            sendEmail(c.email,
                `Your SiteSawa free trial ends in ${daysLeft} day${daysLeft>1?'s':''}`,
                `<div style="font-family:sans-serif;max-width:520px;margin:0 auto">
                 <h2 style="color:#1a1712;background:#bef264;padding:20px;border-radius:8px">⏳ ${daysLeft} day${daysLeft>1?'s':''} left in your free trial</h2>
                 <p>Hi ${c.name || 'there'},</p>
                 <p>Your SiteSawa website is live and working — but your free trial ends soon. To keep your site online, choose your ${planLabel} plan (KES ${planPrice}, one payment, no monthly fees).</p>
                 <p style="text-align:center;margin:24px 0">
                   <a href="https://www.sitesawa.com/login.html" style="background:#1a1712;color:#bef264;text-decoration:none;font-weight:800;padding:14px 28px;border-radius:10px;display:inline-block">Keep my site live →</a>
                 </p>
                 <p style="color:#888;font-size:13px">If you do nothing, your site will pause when the trial ends — but you can reactivate anytime by paying.</p>
                 <p>SiteSawa 🇰🇪</p>
                 </div>`
            ).catch(e => console.error('[TRIAL REMINDER] email failed:', e.message));

            await Customer.updateOne({ _id: c._id }, { $set: { trialReminderSent: true } });
        }
        if (soon.length) console.log(`[TRIAL REMINDER] sent ${soon.length} reminder(s)`);
    } catch (err) {
        console.error('[TRIAL REMINDER] job failed:', err.message);
    }
}
// Run shortly after startup, then once every 24h
setTimeout(sendTrialReminders, 60 * 1000);
setInterval(sendTrialReminders, 24 * 60 * 60 * 1000);

app.listen(PORT, () => {
    console.log(`SiteSawa server running on port ${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});
