const express = require('express');
const rateLimit = require('express-rate-limit');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const app = express();

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Too many requests, please try again later.' }
});
app.use('/api/', limiter);

// ── SECURITY: Crash if JWT_SECRET is missing ──
if (!process.env.JWT_SECRET) {
  console.error('FATAL: JWT_SECRET is required. Set it in your .env file.');
  process.exit(1);
}

// ── GOOGLE ADS CONFIG ──
const GOOGLE_ADS_ID = process.env.GOOGLE_ADS_ID || 'AW-18173399672';
const GOOGLE_ADS_CONVERSION_LABEL = process.env.GOOGLE_ADS_CONVERSION_LABEL || '';
const GOOGLE_ADS_SEND_TO = GOOGLE_ADS_CONVERSION_LABEL 
  ? `${GOOGLE_ADS_ID}/${GOOGLE_ADS_CONVERSION_LABEL}` 
  : null;
const GOOGLE_ADS_CURRENCY = process.env.GOOGLE_ADS_CURRENCY || 'KES';

// ── MIDDLEWARE ──
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'frontend')));
app.use('/templates', express.static(path.join(__dirname, 'templates')));

// ── MONGOOSE SCHEMAS ──
const UserSchema = new mongoose.Schema({
  phone: { type: String, required: true, unique: true, index: true },
  email: { type: String, unique: true, sparse: true },
  secretKey: { type: String, required: true },
  template: { type: String, enum: ['me', 'biz', 'shop'], default: 'me' },
  subdomain: { type: String, unique: true, sparse: true },
  customDomain: { type: String, unique: true, sparse: true },
  data: { type: Object, default: {} },
  products: { type: Array, default: [] },
  orders: { type: Array, default: [] },
  mpesaConfig: {
    mode: { type: String, enum: ['simple', 'api'], default: 'simple' },
    paybillPhone: String,
    consumerKey: String,
    consumerSecret: String,
    passkey: String,
    shortcode: String,
    environment: { type: String, enum: ['sandbox', 'live'], default: 'sandbox' }
  },
  // SEO tracking
  seo: {
    googleVerified: { type: Boolean, default: false },
    googleSiteUrl: String,
    lastSitemapGenerated: Date,
    lastIndexNowPing: Date,
    indexedPages: { type: Number, default: 0 }
  },
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', UserSchema);

// ── CONNECT TO MONGO ──
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/sitesawa')
  .then(() => console.log('MongoDB connected'))
  .catch(err => { console.error('MongoDB error:', err); process.exit(1); });

// ── UTILS ──
function generateSecretKey() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let key = '';
  for (let i = 0; i < 8; i++) {
    key += chars[crypto.randomInt(chars.length)];
  }
  return key;
}

function generateToken(userId) {
  return jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: '7d' });
}

function verifyToken(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }
  try {
    const decoded = jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET);
    req.userId = decoded.userId;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

function verifyAdmin(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Admin auth required' });
  }
  try {
    const decoded = jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET);
    if (!decoded.isAdmin) {
      return res.status(403).json({ error: 'Admin access only' });
    }
    req.adminId = decoded.userId;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid admin token' });
  }
}

function normalizePhone(phone) {
  if (!phone) return '';
  phone = phone.replace(/[\s\-]/g, '').trim();
  if (phone.match(/^0[71]/)) return '+254' + phone.substring(1);
  if (phone.match(/^[71]\d{8}$/)) return '+254' + phone;
  if (phone.match(/^254/)) return '+' + phone;
  if (phone.startsWith('+')) return phone;
  return '+254' + phone.replace(/\D/g, '');
}

// ── SEO UTILITIES ──

// Generate sitemap XML for a user
function generateSitemapXML(user) {
  const domain = user.customDomain || `${user.subdomain}.sitesawa.com`;
  const protocol = 'https';
  const lastmod = new Date().toISOString().split('T')[0];

  let urls = [
    { loc: `${protocol}://${domain}/`, priority: '1.0', changefreq: 'weekly' }
  ];

  // Add product pages for shop template
  if (user.template === 'shop' && user.products && user.products.length > 0) {
    user.products.forEach(product => {
      urls.push({
        loc: `${protocol}://${domain}/#product-${product.id}`,
        priority: '0.8',
        changefreq: 'weekly'
      });
    });
  }

  // Add section anchors
  const sections = user.template === 'me' 
    ? ['about', 'services', 'portfolio', 'contact']
    : user.template === 'biz'
    ? ['about', 'services', 'team', 'contact']
    : ['products', 'about', 'contact'];

  sections.forEach(section => {
    urls.push({
      loc: `${protocol}://${domain}/#${section}`,
      priority: '0.6',
      changefreq: 'monthly'
    });
  });

  const urlEntries = urls.map(u => `
    <url>
      <loc>${u.loc}</loc>
      <lastmod>${lastmod}</lastmod>
      <changefreq>${u.changefreq}</changefreq>
      <priority>${u.priority}</priority>
    </url>
  `).join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urlEntries}
</urlset>`;
}

// Generate robots.txt
function generateRobotsTxt(domain) {
  return `User-agent: *
Allow: /
Sitemap: https://${domain}/sitemap.xml

# SiteSawa Auto-Generated Robots.txt`;
}

// Submit to Google Search Console via Indexing API
async function submitToGoogle(url) {
  try {
    // Using Google's Indexing API (requires service account)
    if (!process.env.GOOGLE_SERVICE_ACCOUNT_KEY) {
      console.log('Google Service Account not configured, skipping Google submission');
      return { success: false, reason: 'no_service_account' };
    }

    const { google } = require('googleapis');
    const auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY),
      scopes: ['https://www.googleapis.com/auth/indexing']
    });

    const indexing = google.indexing({ version: 'v3', auth });
    await indexing.urlNotifications.publish({
      requestBody: {
        url: url,
        type: 'URL_UPDATED'
      }
    });

    return { success: true };
  } catch (err) {
    console.error('Google submission error:', err.message);
    return { success: false, error: err.message };
  }
}

// Ping IndexNow for Bing/Yandex
async function pingIndexNow(url, domain) {
  try {
    const key = process.env.INDEXNOW_KEY || crypto.randomBytes(16).toString('hex');
    const host = domain;

    const payload = {
      host: host,
      key: key,
      keyLocation: `https://${host}/${key}.txt`,
      urlList: [url]
    };

    // Ping Bing
    const bingRes = await fetch('https://www.bing.com/indexnow', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    // Ping Yandex
    const yandexRes = await fetch('https://yandex.com/indexnow', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    return { 
      success: bingRes.ok || yandexRes.ok,
      bing: bingRes.status,
      yandex: yandexRes.status
    };
  } catch (err) {
    console.error('IndexNow ping error:', err.message);
    return { success: false, error: err.message };
  }
}

// Generate structured data (JSON-LD)
function generateStructuredData(user) {
  const domain = user.customDomain || `${user.subdomain}.sitesawa.com`;

  const baseSchema = {
    "@context": "https://schema.org",
    "@type": user.template === 'shop' ? "Store" : user.template === 'biz' ? "LocalBusiness" : "Person",
    "name": user.data?.bizName || user.phone,
    "url": `https://${domain}/`,
    "telephone": user.phone,
    "address": {
      "@type": "PostalAddress",
      "addressCountry": "KE"
    }
  };

  if (user.template === 'shop' && user.products && user.products.length > 0) {
    baseSchema.hasOfferCatalog = {
      "@type": "OfferCatalog",
      "name": "Products",
      "itemListElement": user.products.slice(0, 10).map(p => ({
        "@type": "Offer",
        "itemOffered": {
          "@type": "Product",
          "name": p.name,
          "price": p.price?.toString(),
          "priceCurrency": "KES"
        }
      }))
    };
  }

  return JSON.stringify(baseSchema, null, 2);
}

// ── ROUTES ──

// Register
app.post('/api/register', async (req, res) => {
  try {
    const { phone, email, template } = req.body;
    if (!phone || !/^\+?[0-9]{10,15}$/.test(phone)) {
      return res.status(400).json({ error: 'Valid phone number required' });
    }
    const existing = await User.findOne({ phone });
    if (existing) return res.status(409).json({ error: 'Phone already registered' });

    const secretKey = generateSecretKey();
    const hashedKey = await bcrypt.hash(secretKey, 12);
    const user = new User({ phone, secretKey: hashedKey, template: template || 'me' });

    // Save email if provided
    if (email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      const existingEmail = await User.findOne({ email });
      if (!existingEmail) {
        user.email = email;
      }
    }

    await user.save();

    // Send secret key via Google Workspace email (if email provided)
    if (email && process.env.WORKSPACE_EMAIL && process.env.WORKSPACE_APP_PASSWORD) {
      try {
        const nodemailer = require('nodemailer');
        const transporter = nodemailer.createTransport({
          host: 'smtp.gmail.com',
          port: 587,
          secure: false,
          auth: {
            user: process.env.WORKSPACE_EMAIL,
            pass: process.env.WORKSPACE_APP_PASSWORD
          }
        });

        await transporter.sendMail({
          from: `"SiteSawa" <${process.env.WORKSPACE_EMAIL}>`,
          to: email,
          subject: 'Your SiteSawa Secret Key',
          text: `Welcome to SiteSawa!

Your secret key is: ${secretKey}

Use this key with your phone number to log in to your dashboard.

Keep it safe — do not share it with anyone.

- SiteSawa Team`,
          html: `
            <div style="font-family:Inter,sans-serif;max-width:420px;margin:0 auto;padding:32px;background:#fafafa;border-radius:16px;">
              <h2 style="color:#a3e635;font-size:28px;margin-bottom:20px;font-weight:800;">Welcome to SiteSawa</h2>
              <p style="color:#333;font-size:15px;line-height:1.6;margin-bottom:20px;">Your website is almost ready. Here is your secret key:</p>
              <div style="background:#0a0a0f;color:#fff;padding:24px;border-radius:12px;text-align:center;margin:20px 0;">
                <p style="font-size:11px;color:#9ca3af;margin-bottom:12px;text-transform:uppercase;letter-spacing:2px;font-weight:600;">Secret Key</p>
                <p style="font-size:36px;font-weight:800;color:#a3e635;letter-spacing:6px;margin:0;font-family:monospace;">${secretKey}</p>
              </div>
              <p style="color:#6b7280;font-size:13px;line-height:1.6;margin-bottom:8px;">Use this key with your phone number to log in.</p>
              <p style="color:#ef4444;font-size:12px;font-weight:600;">Do not share this key with anyone.</p>
              <div style="border-top:1px solid #e5e7eb;margin-top:24px;padding-top:16px;">
                <p style="color:#9ca3af;font-size:12px;">Need help? Reply to this email or WhatsApp us.</p>
              </div>
              <p style="color:#9ca3af;font-size:11px;margin-top:16px;">- SiteSawa Team</p>
            </div>
          `
        });
        console.log('Secret key email sent to', email);
      } catch (emailErr) {
        console.log('Email failed (non-critical):', emailErr.message);
      }
    }

    res.json({ success: true, message: email ? 'Registered! Check your email for your secret key.' : 'Registered! Your secret key will be sent to your phone.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// Login
app.post('/api/login', async (req, res) => {
  try {
    const { phone, secretKey } = req.body;
    const user = await User.findOne({ phone });
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const valid = await bcrypt.compare(secretKey, user.secretKey);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    const token = generateToken(user._id);
    res.json({ success: true, token, template: user.template });
  } catch (err) {
    res.status(500).json({ error: 'Login failed' });
  }
});


// ── FORGOT / RESET SECRET KEY ──

app.post('/api/forgot-key', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'Phone number required' });

    const normalizedPhone = normalizePhone(phone);
    const user = await User.findOne({ phone: normalizedPhone });
    if (!user) return res.status(404).json({ error: 'Phone number not found' });
    if (!user.email) return res.status(400).json({ error: 'No email on file. Contact support.' });

    const resetCode = crypto.randomInt(100000, 999999).toString();
    const hashedCode = await bcrypt.hash(resetCode, 10);

    await User.findByIdAndUpdate(user._id, {
      $set: {
        resetCode: hashedCode,
        resetCodeExpiry: new Date(Date.now() + 15 * 60 * 1000)
      }
    });

    if (process.env.WORKSPACE_EMAIL && process.env.WORKSPACE_APP_PASSWORD) {
      try {
        const nodemailer = require('nodemailer');
        const transporter = nodemailer.createTransport({
          host: 'smtp.gmail.com',
          port: 587,
          secure: false,
          auth: {
            user: process.env.WORKSPACE_EMAIL,
            pass: process.env.WORKSPACE_APP_PASSWORD
          }
        });

        await transporter.sendMail({
          from: `"SiteSawa" <${process.env.WORKSPACE_EMAIL}>`,
          to: user.email,
          subject: 'Reset Your SiteSawa Secret Key',
          text: `Your reset code is: ${resetCode}

This code expires in 15 minutes.

If you didn't request this, ignore this email.`,
          html: `
            <div style="font-family:Inter,sans-serif;max-width:420px;margin:0 auto;padding:32px;background:#fafafa;border-radius:16px;">
              <h2 style="color:#a3e635;font-size:28px;margin-bottom:20px;font-weight:800;">Reset Your Key</h2>
              <p style="color:#333;font-size:15px;line-height:1.6;margin-bottom:20px;">Use this code to reset your secret key:</p>
              <div style="background:#0a0a0f;color:#fff;padding:24px;border-radius:12px;text-align:center;margin:20px 0;">
                <p style="font-size:11px;color:#9ca3af;margin-bottom:12px;text-transform:uppercase;letter-spacing:2px;font-weight:600;">Reset Code</p>
                <p style="font-size:36px;font-weight:800;color:#a3e635;letter-spacing:6px;margin:0;font-family:monospace;">${resetCode}</p>
              </div>
              <p style="color:#6b7280;font-size:13px;line-height:1.6;margin-bottom:8px;">This code expires in <b>15 minutes</b>.</p>
              <p style="color:#ef4444;font-size:12px;font-weight:600;">If you didn't request this, ignore this email.</p>
            </div>
          `
        });

        return res.json({ success: true, message: 'Reset code sent to your email' });
      } catch (emailErr) {
        console.error('Reset email failed:', emailErr.message);
        return res.status(500).json({ error: 'Failed to send reset email' });
      }
    }

    res.status(500).json({ error: 'Email service not configured' });
  } catch (err) {
    console.error('Forgot key error:', err);
    res.status(500).json({ error: 'Reset failed' });
  }
});

app.post('/api/reset-key', async (req, res) => {
  try {
    const { phone, code, newKey } = req.body;
    if (!phone || !code || !newKey) {
      return res.status(400).json({ error: 'Phone, code, and new key required' });
    }
    if (newKey.length < 6) {
      return res.status(400).json({ error: 'New key must be at least 6 characters' });
    }

    const normalizedPhone = normalizePhone(phone);
    const user = await User.findOne({ phone: normalizedPhone });
    if (!user || !user.resetCode || !user.resetCodeExpiry) {
      return res.status(400).json({ error: 'Invalid or expired reset code' });
    }

    if (new Date() > user.resetCodeExpiry) {
      return res.status(400).json({ error: 'Reset code expired. Request a new one.' });
    }

    const valid = await bcrypt.compare(code, user.resetCode);
    if (!valid) return res.status(400).json({ error: 'Invalid reset code' });

    const hashedKey = await bcrypt.hash(newKey, 12);
    await User.findByIdAndUpdate(user._id, {
      $set: { secretKey: hashedKey },
      $unset: { resetCode: '', resetCodeExpiry: '' }
    });

    res.json({ success: true, message: 'Secret key updated successfully' });
  } catch (err) {
    console.error('Reset key error:', err);
    res.status(500).json({ error: 'Reset failed' });
  }
});

// Get user data
app.get('/api/me', verifyToken, async (req, res) => {
  try {
    const user = await User.findById(req.userId).select('-secretKey');
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

// Update user data
app.put('/api/me', verifyToken, async (req, res) => {
  try {
    const updates = req.body;
    delete updates.secretKey;
    delete updates.phone;

    const user = await User.findByIdAndUpdate(req.userId, { $set: updates }, { new: true }).select('-secretKey');
    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ error: 'Update failed' });
  }
});

// Save M-Pesa config
app.put('/api/mpesa-config', verifyToken, async (req, res) => {
  try {
    const { mode, paybillPhone, consumerKey, consumerSecret, passkey, shortcode, environment } = req.body;

    if (!mode || !['simple', 'api'].includes(mode)) {
      return res.status(400).json({ error: 'Mode must be "simple" or "api"' });
    }

    let mpesaConfig = { mode };

    if (mode === 'simple') {
      if (!paybillPhone) {
        return res.status(400).json({ error: 'Paybill phone number is required for simple mode' });
      }
      mpesaConfig.paybillPhone = normalizePhone(paybillPhone);
    } else {
      if (!consumerKey || !consumerSecret || !passkey || !shortcode) {
        return res.status(400).json({ error: 'All API fields are required for API mode' });
      }
      mpesaConfig = { mode, consumerKey, consumerSecret, passkey, shortcode, environment: environment || 'sandbox' };
    }

    const user = await User.findByIdAndUpdate(
      req.userId,
      { $set: { mpesaConfig } },
      { new: true }
    ).select('-secretKey');

    res.json({ success: true, message: `M-Pesa config saved (${mode} mode)`, user });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save config' });
  }
});

// Add product
app.post('/api/products', verifyToken, async (req, res) => {
  try {
    const product = { ...req.body, id: crypto.randomUUID(), createdAt: new Date() };
    const user = await User.findByIdAndUpdate(
      req.userId,
      { $push: { products: product } },
      { new: true }
    ).select('products');
    res.json({ success: true, product });
  } catch (err) {
    res.status(500).json({ error: 'Failed to add product' });
  }
});

// Update product
app.put('/api/products/:id', verifyToken, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    const idx = user.products.findIndex(p => p.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Product not found' });
    user.products[idx] = { ...user.products[idx], ...req.body };
    await user.save();
    res.json({ success: true, product: user.products[idx] });
  } catch (err) {
    res.status(500).json({ error: 'Update failed' });
  }
});

// Delete product
app.delete('/api/products/:id', verifyToken, async (req, res) => {
  try {
    await User.findByIdAndUpdate(req.userId, { $pull: { products: { id: req.params.id } } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Delete failed' });
  }
});

// Get shop settings (public)
app.get('/api/shop-settings/:identifier', async (req, res) => {
  try {
    const { identifier } = req.params;
    const user = await User.findOne({
      $or: [{ subdomain: identifier }, { customDomain: identifier }]
    }).select('mpesaConfig template products data');

    if (!user || user.template !== 'shop') {
      return res.status(404).json({ error: 'Shop not found' });
    }

    const config = user.mpesaConfig || {};
    const hasPaymentSetup = config.mode === 'simple' 
      ? !!config.paybillPhone 
      : !!(config.consumerKey && config.shortcode);

    res.json({
      success: true,
      paymentMode: config.mode || null,
      hasPaymentSetup,
      paybillPhone: config.mode === 'simple' ? config.paybillPhone : null,
      shippingEnabled: user.data?.shippingEnabled || false,
      shippingOptions: {
        local: user.data?.localDeliveryFee || 200,
        nationwide: user.data?.nationwideFee || 500
      },
      products: user.products || []
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

// Create order

// Landing page checkout: process M-Pesa payment FIRST, then create account
app.post('/api/create-account-order', async (req, res) => {
  try {
    const { businessName, phone, email, item } = req.body;

    if (!phone || !/^\+?[0-9]{10,15}$/.test(phone)) {
      return res.status(400).json({ error: 'Valid phone number required' });
    }
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Valid email required' });
    }
    if (!businessName) {
      return res.status(400).json({ error: 'Business name required' });
    }

    const normalizedPhone = normalizePhone(phone);
    const template = item?.toLowerCase() || 'me';
    const amount = template === 'me' ? 7000 : template === 'biz' ? 8000 : 9000;

    // Check if phone already registered
    const existing = await User.findOne({ phone: normalizedPhone });
    if (existing) {
      return res.status(409).json({ error: 'Phone number already registered. Please login instead.' });
    }

    // === PROCESS M-PESA PAYMENT FIRST ===
    // Use SiteSawa's own M-Pesa credentials to collect payment
    const mpesaConfig = {
      mode: process.env.MPESA_MODE || 'api',
      consumerKey: process.env.MPESA_CONSUMER_KEY,
      consumerSecret: process.env.MPESA_CONSUMER_SECRET,
      passkey: process.env.MPESA_PASSKEY,
      shortcode: process.env.MPESA_SHORTCODE,
      environment: process.env.MPESA_ENVIRONMENT || 'sandbox'
    };

    let paymentResult = { success: false };

    if (mpesaConfig.mode === 'api' && mpesaConfig.consumerKey && mpesaConfig.passkey) {
      // API Mode - send STK push
      const baseUrl = mpesaConfig.environment === 'live' 
        ? 'https://api.safaricom.co.ke' 
        : 'https://sandbox.safaricom.co.ke';

      const auth = Buffer.from(`${mpesaConfig.consumerKey}:${mpesaConfig.consumerSecret}`).toString('base64');
      const tokenRes = await fetch(`${baseUrl}/oauth/v1/generate?grant_type=client_credentials`, {
        headers: { Authorization: `Basic ${auth}` }
      });
      const tokenData = await tokenRes.json();

      if (tokenData.access_token) {
        const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
        const password = Buffer.from(`${mpesaConfig.shortcode}${mpesaConfig.passkey}${timestamp}`).toString('base64');

        const stkRes = await fetch(`${baseUrl}/mpesa/stkpush/v1/processrequest`, {
          method: 'POST',
          headers: { 
            Authorization: `Bearer ${tokenData.access_token}`, 
            'Content-Type': 'application/json' 
          },
          body: JSON.stringify({
            BusinessShortCode: mpesaConfig.shortcode,
            Password: password,
            Timestamp: timestamp,
            TransactionType: 'CustomerPayBillOnline',
            Amount: amount,
            PartyA: normalizedPhone,
            PartyB: mpesaConfig.shortcode,
            PhoneNumber: normalizedPhone,
            CallBackURL: `${process.env.BASE_URL || 'https://sitesawa.com'}/api/mpesa-callback`,
            AccountReference: `SiteSawa-${template.toUpperCase()}`,
            TransactionDesc: `SiteSawa ${template.toUpperCase()} Website`
          })
        });

        const stkData = await stkRes.json();
        if (!stkData.errorCode) {
          paymentResult = { success: true, checkoutRequestId: stkData.CheckoutRequestID, method: 'stk-push' };
        }
      }
    }

    // If API payment failed or not configured, fall back to manual paybill
    if (!paymentResult.success) {
      paymentResult = {
        success: true,
        method: 'manual',
        message: `Please send KES ${amount.toLocaleString()} to SiteSawa via M-Pesa`,
        paybillPhone: process.env.SITESAWA_PAYBILL_PHONE || '+2547XXXXXXXX'
      };
    }

    // === CREATE ACCOUNT ONLY IF PAYMENT INITIATED ===
    const secretKey = generateSecretKey();
    const hashedKey = await bcrypt.hash(secretKey, 12);

    const user = new User({
      phone: normalizedPhone,
      email: email,
      secretKey: hashedKey,
      template: template,
      data: { bizName: businessName },
      orders: [{
        id: crypto.randomUUID(),
        amount: amount,
        status: paymentResult.method === 'stk-push' ? 'pending' : 'pending-manual',
        paymentMethod: paymentResult.method,
        mpesaRef: paymentResult.checkoutRequestId || null,
        item: template.toUpperCase(),
        createdAt: new Date()
      }]
    });
    await user.save();

    // Send secret key via Google Workspace email
    if (process.env.WORKSPACE_EMAIL && process.env.WORKSPACE_APP_PASSWORD) {
      try {
        const nodemailer = require('nodemailer');
        const transporter = nodemailer.createTransport({
          host: 'smtp.gmail.com',
          port: 587,
          secure: false,
          auth: {
            user: process.env.WORKSPACE_EMAIL,
            pass: process.env.WORKSPACE_APP_PASSWORD
          }
        });

        await transporter.sendMail({
          from: `"SiteSawa" <${process.env.WORKSPACE_EMAIL}>`,
          to: email,
          subject: 'Your SiteSawa Secret Key',
          text: `Welcome to SiteSawa!\n\nYour secret key is: ${secretKey}\n\nYour website: ${businessName}\nTemplate: ${template.toUpperCase()}\nAmount paid: KES ${amount.toLocaleString()}\n\nUse this key with your phone number to log in to your dashboard and customize your site.\n\nKeep it safe — do not share it with anyone.\n\n- SiteSawa Team`,
          html: `
            <div style="font-family:Inter,sans-serif;max-width:420px;margin:0 auto;padding:32px;background:#fafafa;border-radius:16px;">
              <h2 style="color:#a3e635;font-size:28px;margin-bottom:20px;font-weight:800;">Welcome to SiteSawa</h2>
              <p style="color:#333;font-size:15px;line-height:1.6;margin-bottom:20px;">Your website <strong>${businessName}</strong> is ready.</p>
              <div style="background:#0a0a0f;color:#fff;padding:24px;border-radius:12px;text-align:center;margin:20px 0;">
                <p style="font-size:11px;color:#9ca3af;margin-bottom:12px;text-transform:uppercase;letter-spacing:2px;font-weight:600;">Secret Key</p>
                <p style="font-size:36px;font-weight:800;color:#a3e635;letter-spacing:6px;margin:0;font-family:monospace;">${secretKey}</p>
              </div>
              <p style="color:#6b7280;font-size:13px;line-height:1.6;margin-bottom:8px;">Template: <strong>${template.toUpperCase()}</strong></p>
              <p style="color:#6b7280;font-size:13px;line-height:1.6;margin-bottom:8px;">Amount: <strong>KES ${amount.toLocaleString()}</strong></p>
              <p style="color:#6b7280;font-size:13px;line-height:1.6;margin-bottom:8px;">Use this key with your phone number to log in.</p>
              <p style="color:#ef4444;font-size:12px;font-weight:600;">Do not share this key with anyone.</p>
              <div style="border-top:1px solid #e5e7eb;margin-top:24px;padding-top:16px;">
                <p style="color:#9ca3af;font-size:12px;">Need help? Reply to this email or WhatsApp us.</p>
              </div>
              <p style="color:#9ca3af;font-size:11px;margin-top:16px;">- SiteSawa Team</p>
            </div>
          `
        });
        console.log('Secret key email sent to', email);
      } catch (emailErr) {
        console.log('Email failed (non-critical):', emailErr.message);
      }
    }

    res.json({ 
      success: true, 
      message: paymentResult.method === 'stk-push' 
        ? 'Account created! Check your phone for M-Pesa prompt. Check email for secret key.'
        : `Account created! Send KES ${amount.toLocaleString()} to ${paymentResult.paybillPhone}. Check email for secret key.`,
      phone: normalizedPhone,
      secretKey: secretKey,
      amount: amount,
      payment: paymentResult,
      googleAds: GOOGLE_ADS_SEND_TO ? {
        id: GOOGLE_ADS_ID,
        sendTo: GOOGLE_ADS_SEND_TO,
        value: amount,
        currency: GOOGLE_ADS_CURRENCY
      } : null
    });
  } catch (err) {
    console.error('Create account order error:', err);
    res.status(500).json({ error: 'Failed to create account' });
  }
});

app.post('/api/create-order', async (req, res) => {
  try {
    const { phone, amount, items, shopIdentifier, customerPhone, customerName, confirmationCode } = req.body;

    const shopOwner = await User.findOne({
      $or: [{ subdomain: shopIdentifier }, { customDomain: shopIdentifier }]
    });

    if (!shopOwner) {
      return res.status(404).json({ error: 'Shop not found' });
    }

    const config = shopOwner.mpesaConfig || {};

    if (!config.mode) {
      return res.status(400).json({ 
        error: 'This shop has not set up payments yet. Please contact the shop owner.' 
      });
    }

    // SIMPLE MODE
    if (config.mode === 'simple') {
      if (!config.paybillPhone) {
        return res.status(400).json({ error: 'Shop paybill number not configured' });
      }

      const orderId = crypto.randomUUID();

      await User.findByIdAndUpdate(shopOwner._id, {
        $push: {
          orders: {
            id: orderId,
            items, 
            amount, 
            phone,
            customerPhone: customerPhone || phone,
            customerName: customerName || '',
            paybillPhone: config.paybillPhone,
            confirmationCode: confirmationCode || '',
            status: 'pending',
            paymentMethod: 'manual-mpesa',
            createdAt: new Date()
          }
        }
      });

      return res.json({ 
        success: true, 
        orderId,
        paymentMode: 'simple',
        paybillPhone: config.paybillPhone,
        message: `Please send KES ${amount} to ${config.paybillPhone} via M-Pesa. Include order ID: ${orderId.slice(0, 8)}`
      });
    }

    // API MODE
    if (config.mode === 'api') {
      if (!config.consumerKey || !config.consumerSecret || !config.passkey || !config.shortcode) {
        return res.status(400).json({ 
          error: 'M-Pesa API credentials incomplete. Please contact the shop owner.' 
        });
      }

      const baseUrl = config.environment === 'live' 
        ? 'https://api.safaricom.co.ke' 
        : 'https://sandbox.safaricom.co.ke';

      const auth = Buffer.from(`${config.consumerKey}:${config.consumerSecret}`).toString('base64');
      const tokenRes = await fetch(`${baseUrl}/oauth/v1/generate?grant_type=client_credentials`, {
        headers: { Authorization: `Basic ${auth}` }
      });
      const tokenData = await tokenRes.json();

      if (!tokenData.access_token) {
        return res.status(500).json({ error: 'Failed to authenticate with M-Pesa' });
      }

      const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
      const password = Buffer.from(`${config.shortcode}${config.passkey}${timestamp}`).toString('base64');

      const stkRes = await fetch(`${baseUrl}/mpesa/stkpush/v1/processrequest`, {
        method: 'POST',
        headers: { 
          Authorization: `Bearer ${tokenData.access_token}`, 
          'Content-Type': 'application/json' 
        },
        body: JSON.stringify({
          BusinessShortCode: config.shortcode,
          Password: password,
          Timestamp: timestamp,
          TransactionType: 'CustomerPayBillOnline',
          Amount: amount,
          PartyA: phone,
          PartyB: config.shortcode,
          PhoneNumber: phone,
          CallBackURL: `${process.env.BASE_URL}/api/mpesa-callback`,
          AccountReference: shopOwner.subdomain || 'SiteSawa',
          TransactionDesc: 'Purchase'
        })
      });

      const stkData = await stkRes.json();

      if (stkData.errorCode) {
        return res.status(400).json({ 
          error: stkData.errorMessage || 'M-Pesa request failed' 
        });
      }

      await User.findByIdAndUpdate(shopOwner._id, {
        $push: {
          orders: {
            id: crypto.randomUUID(),
            items, 
            amount, 
            phone,
            customerPhone: customerPhone || phone,
            customerName: customerName || '',
            mpesaRef: stkData.CheckoutRequestID,
            status: 'pending',
            paymentMethod: 'stk-push',
            createdAt: new Date()
          }
        }
      });

      return res.json({ 
        success: true, 
        checkoutRequestId: stkData.CheckoutRequestID,
        paymentMode: 'api',
        message: 'M-Pesa STK push sent! Check your phone to complete payment.'
      });
    }

    res.status(400).json({ error: 'Invalid payment mode' });
  } catch (err) {
    console.error('Create order error:', err);
    res.status(500).json({ error: 'Payment initiation failed' });
  }
});

// M-Pesa callback
app.post('/api/mpesa-callback', async (req, res) => {
  try {
    const { Body } = req.body;
    if (Body.stkCallback.ResultCode === 0) {
      const checkoutId = Body.stkCallback.CheckoutRequestID;
      const receipt = Body.stkCallback.CallbackMetadata.Item.find(i => i.Name === 'MpesaReceiptNumber')?.Value;

      await User.updateMany(
        { 'orders.mpesaRef': checkoutId },
        { $set: { 'orders.$.status': 'paid', 'orders.$.mpesaCode': receipt } }
      );
    }
    res.json({ ResultCode: 0, ResultDesc: 'OK' });
  } catch (err) {
    res.json({ ResultCode: 0, ResultDesc: 'OK' });
  }
});

// ── SEO ROUTES ──

// Serve sitemap.xml for any domain
app.get('/sitemap.xml', async (req, res) => {
  try {
    const host = req.headers.host;
    const identifier = host.replace('.sitesawa.com', '').replace('.onrender.com', '');

    const user = await User.findOne({
      $or: [{ subdomain: identifier }, { customDomain: host }]
    });

    if (!user) return res.status(404).send('Not found');

    const sitemap = generateSitemapXML(user);
    res.set('Content-Type', 'application/xml');
    res.send(sitemap);
  } catch (err) {
    res.status(500).send('Error generating sitemap');
  }
});

// Serve robots.txt for any domain
app.get('/robots.txt', async (req, res) => {
  try {
    const host = req.headers.host;
    const robots = generateRobotsTxt(host);
    res.set('Content-Type', 'text/plain');
    res.send(robots);
  } catch (err) {
    res.status(500).send('Error generating robots.txt');
  }
});

// Trigger SEO setup for a user
app.post('/api/seo/setup', verifyToken, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const domain = user.customDomain || `${user.subdomain}.sitesawa.com`;
    const baseUrl = `https://${domain}`;

    const results = {
      sitemap: false,
      google: false,
      indexNow: false,
      structuredData: false
    };

    // 1. Generate and save sitemap
    try {
      const sitemap = generateSitemapXML(user);
      // Sitemap is served dynamically via /sitemap.xml
      results.sitemap = true;

      await User.findByIdAndUpdate(req.userId, {
        $set: { 'seo.lastSitemapGenerated': new Date() }
      });
    } catch(e) {
      console.error('Sitemap generation error:', e);
    }

    // 2. Submit to Google
    try {
      const googleResult = await submitToGoogle(baseUrl);
      results.google = googleResult.success;

      if (googleResult.success) {
        await User.findByIdAndUpdate(req.userId, {
          $set: { 'seo.googleVerified': true, 'seo.googleSiteUrl': baseUrl }
        });
      }
    } catch(e) {
      console.error('Google submission error:', e);
    }

    // 3. Ping IndexNow
    try {
      const indexNowResult = await pingIndexNow(baseUrl, domain);
      results.indexNow = indexNowResult.success;

      if (indexNowResult.success) {
        await User.findByIdAndUpdate(req.userId, {
          $set: { 'seo.lastIndexNowPing': new Date() }
        });
      }
    } catch(e) {
      console.error('IndexNow ping error:', e);
    }

    // 4. Structured data is embedded in templates
    results.structuredData = true;

    res.json({ 
      success: true, 
      message: 'SEO setup complete',
      results,
      domain,
      nextSteps: [
        'Verify domain in Google Search Console manually',
        'Add your site to Google Analytics',
        'Share your link on social media for faster indexing'
      ]
    });
  } catch (err) {
    res.status(500).json({ error: 'SEO setup failed' });
  }
});


// Get Google Ads config (public - for frontend conversion tracking)
app.get('/api/google-ads-config', (req, res) => {
  res.json({
    id: GOOGLE_ADS_ID,
    sendTo: GOOGLE_ADS_SEND_TO,
    enabled: !!GOOGLE_ADS_CONVERSION_LABEL
  });
});

// Get SEO status
app.get('/api/seo/status', verifyToken, async (req, res) => {
  try {
    const user = await User.findById(req.userId).select('seo subdomain customDomain');
    if (!user) return res.status(404).json({ error: 'User not found' });

    res.json({
      success: true,
      seo: user.seo,
      domain: user.customDomain || `${user.subdomain}.sitesawa.com`,
      sitemapUrl: `https://${user.customDomain || user.subdomain + '.sitesawa.com'}/sitemap.xml`
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch SEO status' });
  }
});

// Get public site data
app.get('/api/site/:identifier', async (req, res) => {
  try {
    const { identifier } = req.params;
    const user = await User.findOne({
      $or: [{ subdomain: identifier }, { customDomain: identifier }, { phone: identifier }]
    }).select('-secretKey -mpesaConfig');
    if (!user) return res.status(404).json({ error: 'Site not found' });
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch site' });
  }
});

// ── ADMIN ROUTES ──

// Admin login
app.post('/api/admin/login', async (req, res) => {
  try {
    const { phone, secretKey } = req.body;

    // Check 1: Phone must match ADMIN_PHONE env var exactly
    if (phone !== process.env.ADMIN_PHONE) {
      return res.status(401).json({ 
        error: 'Phone not authorized as admin',
        detail: `You sent: "${phone}". ADMIN_PHONE env var is: "${process.env.ADMIN_PHONE || 'NOT SET'}". Must match exactly including + sign.`
      });
    }

    // Check 2: Phone must be a registered user in the database
    const user = await User.findOne({ phone });
    if (!user) {
      return res.status(401).json({ 
        error: 'Phone not registered',
        detail: 'This phone is authorized as admin but has no user account. Sign up as a regular customer first, then use admin login.'
      });
    }

    // Check 3: Secret key must match (user's key OR ADMIN_SECRET env var)
    let valid = await bcrypt.compare(secretKey, user.secretKey);

    // Fallback: check ADMIN_SECRET if bcrypt fails
    if (!valid && process.env.ADMIN_SECRET) {
      valid = secretKey === process.env.ADMIN_SECRET;
    }

    if (!valid) {
      return res.status(401).json({ 
        error: 'Wrong secret key',
        detail: 'The secret key you entered does not match your account key or ADMIN_SECRET.'
      });
    }

    const token = jwt.sign({ userId: user._id, isAdmin: true }, process.env.JWT_SECRET, { expiresIn: '1d' });
    res.json({ success: true, token });
  } catch (err) {
    res.status(500).json({ error: 'Admin login failed' });
  }
});

// Get all customers (admin)
app.get('/api/admin/customers', verifyAdmin, async (req, res) => {
  try {
    const customers = await User.find().select('-secretKey').sort({ createdAt: -1 });
    res.json({ success: true, customers });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch customers' });
  }
});

// Get single customer (admin)
app.get('/api/admin/customers/:id', verifyAdmin, async (req, res) => {
  try {
    const customer = await User.findById(req.params.id).select('-secretKey');
    if (!customer) return res.status(404).json({ error: 'Customer not found' });
    res.json({ success: true, customer });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch customer' });
  }
});

// Delete customer (admin)
app.delete('/api/admin/customers/:id', verifyAdmin, async (req, res) => {
  try {
    await User.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Delete failed' });
  }
});

// ── ROOT ROUTE: Serve landing page ──
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'frontend', 'index.html'));
});

// ── SERVE TEMPLATES ──
app.get('/:identifier', async (req, res) => {
  try {
    const { identifier } = req.params;
    if (identifier.startsWith('api') || identifier.includes('.')) return res.status(404).send('Not found');

    const user = await User.findOne({
      $or: [{ subdomain: identifier }, { customDomain: identifier }]
    });
    if (!user) return res.status(404).send('Site not found');

    const templateFile = `${user.template}-template.html`;
    res.sendFile(path.join(__dirname, 'templates', templateFile));
  } catch (err) {
    res.status(500).send('Server error');
  }
});

// ── START SERVER ──
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`SiteSawa server running on port ${PORT}`));
