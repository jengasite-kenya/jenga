const express = require('express');
const cors = require('cors');
const axios = require('axios');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const validator = require('validator');
const path = require('path');
const fs = require('fs');

const app = express();

// Security middleware
app.use(helmet());
app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));
app.use(express.json({ limit: '10mb' }));

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: { success: false, message: 'Too many requests, please try again later.' }
});
app.use('/api/', limiter);

const createOrderLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 5,
    message: { success: false, message: 'Please wait before creating another order.' }
});

// STATIC FILE SERVING - This serves your index.html!
app.use(express.static(path.join(__dirname)));

// File-based storage
const DATA_FILE = path.join(__dirname, 'orders.json');
const TOKEN_INDEX_FILE = path.join(__dirname, 'token-index.json');

let orders = new Map();
let tokenIndex = new Map();

function loadData() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
            orders = new Map(Object.entries(data.orders || {}));
            for (const [id, order] of orders) {
                order.createdAt = new Date(order.createdAt);
                if (order.paidAt) order.paidAt = new Date(order.paidAt);
            }
        }
        if (fs.existsSync(TOKEN_INDEX_FILE)) {
            const data = JSON.parse(fs.readFileSync(TOKEN_INDEX_FILE, 'utf8'));
            tokenIndex = new Map(Object.entries(data));
        }
    } catch (error) {
        console.error('Error loading data:', error);
    }
}

function saveData() {
    try {
        const data = { orders: Object.fromEntries(orders) };
        fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
        fs.writeFileSync(TOKEN_INDEX_FILE, JSON.stringify(Object.fromEntries(tokenIndex), null, 2));
    } catch (error) {
        console.error('Error saving data:', error);
    }
}

function cleanupOldOrders() {
    const now = Date.now();
    const cutoff = 24 * 60 * 60 * 1000;
    let cleaned = 0;
    for (const [id, order] of orders) {
        if (order.status === 'pending' && (now - order.createdAt.getTime()) > cutoff) {
            orders.delete(id);
            if (order.downloadToken) tokenIndex.delete(order.downloadToken);
            cleaned++;
        }
    }
    if (cleaned > 0) {
        console.log(`Cleaned up ${cleaned} old pending orders`);
        saveData();
    }
}

setInterval(cleanupOldOrders, 60 * 60 * 1000);
loadData();

// Environment variables
const MPESA_KEY = process.env.MPESA_KEY;
const MPESA_SECRET = process.env.MPESA_SECRET;
const MPESA_SHORTCODE = process.env.MPESA_SHORTCODE;
const MPESA_PASSKEY = process.env.MPESA_PASSKEY;
const FROM_EMAIL = process.env.FROM_EMAIL || 'orders@jengasite.co.ke';
const FROM_NAME = process.env.FROM_NAME || 'JengaSite';
const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;
const AT_USERNAME = process.env.AT_USERNAME;
const AT_APIKEY = process.env.AT_APIKEY;
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
const MPESA_ENVIRONMENT = process.env.MPESA_ENVIRONMENT || 'sandbox';

const VALID_ITEMS = [
    'Business Showcase',
    'Professional Portfolio',
    'Online Store Pro',
    'Starter Package',
    'Business Package'
];

const TEMPLATE_FILES = {
    'Business Showcase': 'templates/business-showcase.zip',
    'Professional Portfolio': 'templates/portfolio.zip',
    'Online Store Pro': 'templates/ecommerce-pro.zip',
    'Starter Package': 'templates/starter-package.zip',
    'Business Package': 'templates/business-package.zip'
};

function validateConfig() {
    const required = ['MPESA_KEY', 'MPESA_SECRET', 'MPESA_SHORTCODE', 'MPESA_PASSKEY'];
    const missing = required.filter(key => !process.env[key]);
    if (missing.length > 0) {
        console.warn(`Missing: ${missing.join(', ')}`);
    }
    if (!GMAIL_USER || !GMAIL_APP_PASSWORD) {
        console.warn('Gmail not configured - emails will be logged only');
    }
}
validateConfig();

async function getMpesaToken() {
    const auth = Buffer.from(`${MPESA_KEY}:${MPESA_SECRET}`).toString('base64');
    const baseUrl = MPESA_ENVIRONMENT === 'production'
        ? 'https://api.safaricom.co.ke'
        : 'https://sandbox.safaricom.co.ke';
    
    const response = await axios.get(`${baseUrl}/oauth/v1/generate?grant_type=client_credentials`, {
        headers: { Authorization: `Basic ${auth}` },
        timeout: 10000
    });
    return response.data.access_token;
}

async function sendEmail(to, subject, html) {
    if (!GMAIL_USER || !GMAIL_APP_PASSWORD) {
        console.log('📧 [EMAIL LOG] To:', to, 'Subject:', subject);
        return;
    }
    
    try {
        const transporter = nodemailer.createTransport({
            host: 'smtp.gmail.com',
            port: 587,
            secure: false,
            requireTLS: true,
            auth: {
                user: GMAIL_USER,
                pass: GMAIL_APP_PASSWORD
            }
        });
        
        await transporter.verify();
        
        const info = await transporter.sendMail({
            from: `"${FROM_NAME}" <${GMAIL_USER}>`,
            to: to,
            subject: subject,
            html: html,
            text: html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
        });
        
        console.log(`📧 Email sent: ${info.messageId}`);
        transporter.close();
        
    } catch (error) {
        console.error('Email failed:', error.message);
    }
}

async function sendSMS(phone, message) {
    if (!AT_APIKEY || !AT_USERNAME) {
        console.log('📱 SMS skipped:', phone);
        return;
    }
    
    await axios.post('https://api.africastalking.com/version1/messaging', {
        username: AT_USERNAME,
        to: phone,
        message: message
    }, {
        headers: { apiKey: AT_APIKEY },
        timeout: 10000
    });
}

function sanitizeInput(input) {
    if (!input) return '';
    return validator.escape(input.trim());
}

function validatePhone(phone) {
    let cleaned = phone.replace(/\s/g, '');
    if (cleaned.startsWith('0') && cleaned.length === 10) {
        cleaned = '254' + cleaned.substring(1);
    }
    return /^254[710][0-9]{8}$/.test(cleaned) ? cleaned : null;
}

function generateMpesaPassword(timestamp) {
    const str = `${MPESA_SHORTCODE}${MPESA_PASSKEY}${timestamp}`;
    return Buffer.from(str).toString('base64');
}

app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        time: new Date().toISOString(),
        orders: orders.size,
        uptime: process.uptime(),
        email_configured: !!(GMAIL_USER && GMAIL_APP_PASSWORD)
    });
});

app.post('/api/create-order', createOrderLimiter, async (req, res) => {
    try {
        const { name, email, phone, domain, item, price, type } = req.body;
        
        if (!name || !email || !phone || !item || !price || !type) {
            return res.status(400).json({ success: false, message: 'Please fill all fields' });
        }
        
        const cleanName = sanitizeInput(name);
        const cleanEmail = sanitizeInput(email).toLowerCase();
        const cleanDomain = domain ? sanitizeInput(domain).toLowerCase() : null;
        
        if (!validator.isEmail(cleanEmail)) {
            return res.status(400).json({ success: false, message: 'Invalid email' });
        }
        
        const cleanPhone = validatePhone(phone);
        if (!cleanPhone) {
            return res.status(400).json({ success: false, message: 'Invalid phone. Use 2547XXXXXXXX or 07XXXXXXXX' });
        }
        
        if (!VALID_ITEMS.includes(item)) {
            return res.status(400).json({ success: false, message: 'Invalid item' });
        }
        
        const validPrices = { 'Business Showcase': 6000, 'Professional Portfolio': 6000, 'Online Store Pro': 8000, 'Starter Package': 9999, 'Business Package': 14999 };
        if (validPrices[item] !== price) {
            return res.status(400).json({ success: false, message: 'Invalid price' });
        }
        
        if (!['template', 'package'].includes(type)) {
            return res.status(400).json({ success: false, message: 'Invalid type' });
        }
        
        if (type === 'package' && !cleanDomain) {
            return res.status(400).json({ success: false, message: 'Domain required for packages' });
        }
        
        if (cleanDomain && !validator.isFQDN(cleanDomain)) {
            return res.status(400).json({ success: false, message: 'Invalid domain' });
        }
        
        const orderId = crypto.randomUUID();
        const accountRef = orderId.slice(0, 12).toUpperCase();
        
        const orderData = {
            id: orderId,
            accountRef,
            name: cleanName,
            email: cleanEmail,
            phone: cleanPhone,
            domain: cleanDomain,
            item,
            price,
            type,
            status: 'pending',
            paid: false,
            createdAt: new Date()
        };
        
        orders.set(orderId, orderData);
        saveData();
        
        const token = await getMpesaToken();
        const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
        const password = generateMpesaPassword(timestamp);
        
        const baseUrl = MPESA_ENVIRONMENT === 'production'
            ? 'https://api.safaricom.co.ke'
            : 'https://sandbox.safaricom.co.ke';
        
        const callbackUrl = `${req.protocol}://${req.get('host')}/mpesa-callback`;
        
        const stkResponse = await axios.post(`${baseUrl}/mpesa/stkpush/v1/processrequest`, {
            BusinessShortCode: MPESA_SHORTCODE,
            Password: password,
            Timestamp: timestamp,
            TransactionType: 'CustomerPayBillOnline',
            Amount: price,
            PartyA: cleanPhone,
            PartyB: MPESA_SHORTCODE,
            PhoneNumber: cleanPhone,
            CallBackURL: callbackUrl,
            AccountReference: accountRef,
            TransactionDesc: `JengaSite ${item}`
        }, {
            headers: { Authorization: `Bearer ${token}` },
            timeout: 30000
        });
        
        orderData.checkoutRequestId = stkResponse.data.CheckoutRequestID;
        saveData();
        
        res.json({
            success: true,
            orderId,
            message: 'Check your phone and enter M-Pesa PIN'
        });
        
    } catch (error) {
        console.error('Error:', error.response?.data || error.message);
        res.status(500).json({ success: false, message: 'Payment failed. Try again.' });
    }
});

app.post('/mpesa-callback', express.raw({ type: 'application/json' }), async (req, res) => {
    try {
        res.json({ ResultCode: 0, ResultDesc: 'Success' });
        
        const body = JSON.parse(req.body);
        const callback = body.Body?.stkCallback;
        if (!callback) return;
        
        const { ResultCode, CheckoutRequestID } = callback;
        
        let order = null;
        for (const [id, o] of orders) {
            if (o.checkoutRequestId === CheckoutRequestID) {
                order = o;
                break;
            }
        }
        
        if (!order) return;
        
        if (ResultCode === 0) {
            const metadata = callback.CallbackMetadata?.Item || [];
            const receipt = metadata.find(i => i.Name === 'MpesaReceiptNumber')?.Value;
            
            order.paid = true;
            order.status = 'paid';
            order.mpesaReceipt = receipt;
            order.paidAt = new Date();
            
            const downloadToken = crypto.randomBytes(32).toString('hex');
            order.downloadToken = downloadToken;
            tokenIndex.set(downloadToken, order.id);
            
            const downloadUrl = `${FRONTEND_URL}/download/${downloadToken}`;
            order.downloadUrl = downloadUrl;
            
            saveData();
            
            await sendEmail(order.email, '🎉 Your JengaSite Order is Ready!', `
                <!DOCTYPE html>
                <html>
                <body style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                    <div style="background: #059669; color: white; padding: 30px; text-align: center;">
                        <h1>🏗️ JengaSite</h1>
                    </div>
                    <div style="padding: 30px;">
                        <h2>Hi ${validator.escape(order.name)},</h2>
                        <p>Thank you for your purchase! Payment confirmed.</p>
                        <div style="background: #f0fdf4; padding: 20px; border-left: 4px solid #059669; margin: 20px 0;">
                            <p><strong>Item:</strong> ${validator.escape(order.item)}</p>
                            <p><strong>Amount:</strong> KES ${order.price.toLocaleString()}</p>
                            <p><strong>Receipt:</strong> ${validator.escape(receipt || 'N/A')}</p>
                        </div>
                        <div style="text-align: center; margin: 30px 0;">
                            <a href="${downloadUrl}" style="background: #059669; color: white; padding: 16px 32px; text-decoration: none; border-radius: 8px; display: inline-block;">${order.type === 'template' ? 'Download Now' : 'Visit Website'}</a>
                        </div>
                        <p style="color: #6b7280; font-size: 12px; text-align: center;">Link expires in 7 days • 5 download limit</p>
                    </div>
                </body>
                </html>
            `);
            
            await sendSMS(order.phone, `JengaSite: Your ${order.item} is ready! Check your email. Receipt: ${receipt}`);
            
            order.status = 'completed';
            order.deliveredAt = new Date();
            saveData();
            
        } else {
            order.status = 'failed';
            order.failureReason = callback.ResultDesc;
            saveData();
        }
        
    } catch (error) {
        console.error('Callback error:', error);
    }
});

app.get('/api/check-status', async (req, res) => {
    const order = orders.get(req.query.orderId);
    if (!order) return res.json({ paid: false });
    
    res.json({
        paid: order.paid,
        status: order.status,
        mpesaReceipt: order.mpesaReceipt,
        downloadUrl: order.downloadUrl,
        failureReason: order.failureReason,
        domain: order.domain
    });
});

app.get('/download/:token', async (req, res) => {
    const orderId = tokenIndex.get(req.params.token);
    if (!orderId) return res.status(404).send('Link not found');
    
    const order = orders.get(orderId);
    if (!order || !order.paid) return res.status(403).send('Not allowed');
    
    order.downloadCount = (order.downloadCount || 0) + 1;
    if (order.downloadCount > 5) return res.status(403).send('Download limit reached');
    
    if (order.type === 'package') {
        return res.redirect(`https://${order.domain}`);
    }
    
    const filePath = TEMPLATE_FILES[order.item];
    if (!filePath) return res.status(404).send('File not found');
    
    const fullPath = path.join(__dirname, filePath);
    const safeName = order.item.replace(/[^a-z0-9]/gi, '-').toLowerCase() + '.zip';
    
    res.download(fullPath, safeName, (err) => {
        if (!err) saveData();
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});