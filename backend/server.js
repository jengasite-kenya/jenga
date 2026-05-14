const express = require('express');
const nodemailer = require('nodemailer');
const rateLimit = require('express-rate-limit');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
require('dotenv').config();

const app = express();

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: { error: 'Too many requests, please try again later.' }
});
app.use('/api/', limiter);


// ── SECURITY: Crash if JWT_SECRET is missing ──
if (!process.env.JWT_SECRET) {
  console.error('FATAL: JWT_SECRET is required. Set it in your .env file.');
  process.exit(1);
}

// ── MIDDLEWARE ──
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'frontend')));
app.use('/templates', express.static(path.join(__dirname, 'templates')));

// ── MONGOOSE SCHEMAS ──
const UserSchema = new mongoose.Schema({
  phone: { type: String, required: true, unique: true, index: true },
  secretKey: { type: String, required: true },
  template: { type: String, enum: ['me', 'biz', 'shop'], default: 'me' },
  subdomain: { type: String, unique: true, sparse: true },
  customDomain: { type: String, unique: true, sparse: true },
  data: { type: Object, default: {} },
  products: { type: Array, default: [] },
  orders: { type: Array, default: [] },
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', UserSchema);

// ── CONNECT TO MONGO ──
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/sitesawa')
  .then(() => console.log('MongoDB connected'))
  .catch(err => { console.error('MongoDB error:', err); process.exit(1); });

// ── UTILS ──
function generateSecretKey() {
  // SECURITY FIX: Use crypto.randomInt, not Math.random
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

// ── ADMIN AUTH MIDDLEWARE (Header-based) ──
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

// ── ROUTES ──

// Register

// Phone number normalization for Kenya
function normalizePhone(phone) {
  if (!phone) return '';
  // Remove spaces, dashes, and non-digit characters except +
  phone = phone.replace(/[\s\-]/g, '').trim();

  // If starts with 07 or 01, add +254
  if (phone.match(/^0[71]/)) {
    return '+254' + phone.substring(1);
  }

  // If starts with 7 or 1 (no leading 0), add +254
  if (phone.match(/^[71]\d{8}$/)) {
    return '+254' + phone;
  }

  // If starts with 254 but no +, add +
  if (phone.match(/^254/)) {
    return '+' + phone;
  }

  // If already has +, return as is
  if (phone.startsWith('+')) {
    return phone;
  }

  // Default: assume it's a Kenyan number, add +254
  return '+254' + phone.replace(/\D/g, '');
}


// Email transporter using Google Workspace
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.WORKSPACE_EMAIL,
    pass: process.env.WORKSPACE_APP_PASSWORD
  }
});

// Send email function
async function sendEmail(to, subject, text, html = null) {
  try {
    if (!process.env.WORKSPACE_EMAIL || !process.env.WORKSPACE_APP_PASSWORD) {
      console.log('Email skipped: Workspace not configured');
      return { success: false, error: 'Email not configured' };
    }

    const mailOptions = {
      from: `"SiteSawa" <${process.env.WORKSPACE_EMAIL}>`,
      to: to,
      subject: subject,
      text: text,
      html: html || `<p>${text.replace(/\n/g, '<br>')}</p>`
    };

    const info = await transporter.sendMail(mailOptions);
    console.log('Email sent:', info.messageId);
    return { success: true, messageId: info.messageId };
  } catch (err) {
    console.error('Email error:', err);
    return { success: false, error: err.message };
  }
}

app.post('/api/register', async (req, res) => {
  try {
    const { phone, template } = req.body;
    if (!phone || !/^\+?[0-9]{10,15}$/.test(phone)) {
      return res.status(400).json({ error: 'Valid phone number required' });
    }
    const existing = await User.findOne({ phone });
    if (existing) return res.status(409).json({ error: 'Phone already registered' });

    const secretKey = generateSecretKey();
    const hashedKey = await bcrypt.hash(secretKey, 12);
    const user = new User({ phone, secretKey: hashedKey, template: template || 'me' });
    await user.save();

    // Send SMS with secret key via Africa's Talking
    if (process.env.AT_API_KEY && process.env.AT_USERNAME) {
      try {
        const africastalking = require('africastalking')({
          apiKey: process.env.AT_API_KEY,
          username: process.env.AT_USERNAME
        });
        await africastalking.SMS.send({
          to: [phone],
          message: `Your SiteSawa secret key: ${secretKey}. Keep it safe!`,
          from: process.env.AT_SENDER_ID || 'SiteSawa'
        });
      } catch (smsErr) {
        console.log('SMS failed (non-critical):', smsErr.message);
      }
    }

    res.json({ success: true, message: 'Registered. Check SMS for your secret key.' });
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

// Create order (M-Pesa STK Push)
app.post('/api/create-order', async (req, res) => {
  try {
    const { phone, amount, items, userId } = req.body;

    // M-Pesa Daraja integration
    const consumerKey = process.env.MPESA_CONSUMER_KEY;
    const consumerSecret = process.env.MPESA_CONSUMER_SECRET;
    const passkey = process.env.MPESA_PASSKEY;
    const shortcode = process.env.MPESA_SHORTCODE;

    if (!consumerKey || !consumerSecret || !passkey || !shortcode) {
      return res.status(500).json({ error: 'M-Pesa not configured' });
    }

    // Get access token
    const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');
    const tokenRes = await fetch('https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials', {
      headers: { Authorization: `Basic ${auth}` }
    });
    const tokenData = await tokenRes.json();

    const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
    const password = Buffer.from(`${shortcode}${passkey}${timestamp}`).toString('base64');

    const stkRes = await fetch('https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenData.access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        BusinessShortCode: shortcode,
        Password: password,
        Timestamp: timestamp,
        TransactionType: 'CustomerPayBillOnline',
        Amount: amount,
        PartyA: phone,
        PartyB: shortcode,
        PhoneNumber: phone,
        CallBackURL: `${process.env.BASE_URL}/api/mpesa-callback`,
        AccountReference: 'SiteSawa',
        TransactionDesc: 'Purchase'
      })
    });

    const stkData = await stkRes.json();

    // Save order
    if (userId) {
      await User.findByIdAndUpdate(userId, {
        $push: {
          orders: {
            id: crypto.randomUUID(),
            items, amount, phone,
            mpesaRef: stkData.CheckoutRequestID,
            status: 'pending',
            createdAt: new Date()
          }
        }
      });
    }

    res.json({ success: true, checkoutRequestId: stkData.CheckoutRequestID });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Payment initiation failed' });
  }
});

// M-Pesa callback
app.post('/api/mpesa-callback', async (req, res) => {
  try {
    const { Body } = req.body;
    if (Body.stkCallback.ResultCode === 0) {
      const checkoutId = Body.stkCallback.CheckoutRequestID;
      await User.updateMany(
        { 'orders.mpesaRef': checkoutId },
        { $set: { 'orders.$.status': 'paid', 'orders.$.mpesaCode': Body.stkCallback.CallbackMetadata.Item.find(i => i.Name === 'MpesaReceiptNumber')?.Value } }
      );
    }
    res.json({ ResultCode: 0, ResultDesc: 'OK' });
  } catch (err) {
    res.json({ ResultCode: 0, ResultDesc: 'OK' });
  }
});

// Get public site data
app.get('/api/site/:identifier', async (req, res) => {
  try {
    const { identifier } = req.params;
    const user = await User.findOne({
      $or: [{ subdomain: identifier }, { customDomain: identifier }, { phone: identifier }]
    }).select('-secretKey');
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
    if (phone !== process.env.ADMIN_PHONE) {
      return res.status(401).json({ error: 'Invalid admin credentials' });
    }
    const user = await User.findOne({ phone });
    if (!user) return res.status(401).json({ error: 'Invalid admin credentials' });

    const valid = await bcrypt.compare(secretKey, user.secretKey);
    if (!valid) return res.status(401).json({ error: 'Invalid admin credentials' });

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

// Test email route
app.get('/api/test-email', async (req, res) => {
  const result = await sendEmail(
    process.env.WORKSPACE_EMAIL || 'test@sitesawa.co.ke',
    'Test from SiteSawa',
    'This is a test email from your SiteSawa server. If you received this, email is working!'
  );
  res.json(result);
});

app.listen(PORT, () => console.log(`SiteSawa server running on port ${PORT}`));
