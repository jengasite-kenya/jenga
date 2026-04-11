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
require('dotenv').config();

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

// STATIC FILE SERVING
app.use(express.static(path.join(__dirname)));

// ==================== HOST AFRICA DOMAIN MANAGER ====================
class HostAfricaManager {
    constructor(apiKey, username) {
        this.apiKey = apiKey;
        this.username = username;
        this.baseUrl = 'https://api.hostafrica.co.ke/v1';
    }

    async checkDomain(domain) {
        try {
            const response = await axios.get(`${this.baseUrl}/domains/check`, {
                params: {
                    username: this.username,
                    apikey: this.apiKey,
                    domain: domain,
                    tlds: '.co.ke,.com,.org,.net'
                },
                timeout: 10000
            });
            return {
                available: response.data.available,
                price: response.data.price || 1500,
                message: response.data.available ? 'Domain available' : 'Domain taken'
            };
        } catch (error) {
            console.error('Domain check error:', error.message);
            return { available: false, error: error.message };
        }
    }

    async registerDomain(domain, contactInfo) {
        try {
            const response = await axios.post(`${this.baseUrl}/domains/register`, {
                username: this.username,
                apikey: this.apiKey,
                domain: domain,
                ns1: 'ns1.hostafrica.co.ke',
                ns2: 'ns2.hostafrica.co.ke',
                contact: {
                    name: contactInfo.name,
                    email: contactInfo.email,
                    phone: contactInfo.phone,
                    address: contactInfo.address || 'Nairobi, Kenya',
                    city: contactInfo.city || 'Nairobi',
                    country: 'KE'
                }
            }, {
                timeout: 30000
            });
            
            return {
                success: true,
                domainId: response.data.domainId,
                nameservers: ['ns1.hostafrica.co.ke', 'ns2.hostafrica.co.ke'],
                message: 'Domain registered successfully'
            };
        } catch (error) {
            console.error('Domain registration failed:', error.response?.data || error.message);
            return {
                success: false,
                error: error.response?.data?.message || error.message
            };
        }
    }

    async configureDNS(domain) {
        const records = [
            { type: 'A', name: '@', value: '216.24.57.1', ttl: 3600 },
            { type: 'CNAME', name: 'www', value: domain, ttl: 3600 }
        ];
        
        try {
            await axios.post(`${this.baseUrl}/dns/set`, {
                username: this.username,
                apikey: this.apiKey,
                domain: domain,
                records: records
            }, {
                timeout: 15000
            });
            
            return { success: true, message: 'DNS configured for Render hosting' };
        } catch (error) {
            console.error('DNS config failed:', error.message);
            return { success: false, error: error.message };
        }
    }

    async createEmailAccounts(domain, emails, packageType) {
        const emailCount = packageType === 'business' ? 5 : 1;
        const createdEmails = [];
        
        try {
            for (let i = 0; i < Math.min(emails.length, emailCount); i++) {
                const emailUser = emails[i];
                const password = this.generatePassword();
                const response = await axios.post(`${this.baseUrl}/email/create`, {
                    username: this.username,
                    apikey: this.apiKey,
                    domain: domain,
                    email: `${emailUser}@${domain}`,
                    password: password,
                    quota: packageType === 'business' ? 2048 : 1024
                }, {
                    timeout: 10000
                });
                
                createdEmails.push({
                    email: `${emailUser}@${domain}`,
                    password: password,
                    quota: response.data.quota
                });
            }
            
            return {
                success: true,
                emails: createdEmails,
                message: `${createdEmails.length} email accounts created`
            };
        } catch (error) {
            console.error('Email creation failed:', error.message);
            return { success: false, error: error.message };
        }
    }

    generatePassword() {
        const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
        let password = '';
        for (let i = 0; i < 12; i++) {
            password += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return password;
    }
}

// ==================== RENDER DEPLOYER ====================
class RenderDeployer {
    constructor(apiKey) {
        this.apiKey = apiKey;
        this.baseUrl = 'https://api.render.com/v1';
    }

    async deploySite(orderData, templateType) {
        try {
            const repoUrl = await this.createTemplateRepo(orderData, templateType);
            const service = await this.createRenderService(orderData.domain, repoUrl);
            await this.configureDomain(service.id, orderData.domain);
            
            return {
                success: true,
                url: `https://${service.id}.onrender.com`,
                customDomain: `https://${orderData.domain}`,
                serviceId: service.id,
                message: 'Site deployed successfully'
            };
        } catch (error) {
            console.error('Deployment failed:', error.message);
            return { success: false, error: error.message };
        }
    }

    async createTemplateRepo(orderData, templateType) {
        return `https://github.com/sitesawa/${orderData.domain.replace(/\./g, '-')}`;
    }

    async createRenderService(domain, repoUrl) {
        const response = await axios.post(`${this.baseUrl}/services`, {
            type: 'static_site',
            name: domain.replace(/\./g, '-'),
            ownerId: process.env.RENDER_OWNER_ID,
            repo: repoUrl,
            branch: 'main',
            buildCommand: '',
            publishPath: '.',
            envVars: [
                { key: 'GA_ID', value: process.env.DEFAULT_GA_ID || '' },
                { key: 'RECAPTCHA_SITE_KEY', value: process.env.RECAPTCHA_SITE_KEY || '' }
            ]
        }, {
            headers: {
                'Authorization': `Bearer ${this.apiKey}`,
                'Content-Type': 'application/json'
            },
            timeout: 30000
        });

        return response.data;
    }

    async configureDomain(serviceId, domain) {
        await axios.post(`${this.baseUrl}/services/${serviceId}/custom-domains`, {
            name: domain
        }, {
            headers: { 'Authorization': `Bearer ${this.apiKey}` }
        });
    }
}

// ==================== DATA STORAGE ====================
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

// ==================== CONFIGURATION ====================
const MPESA_KEY = process.env.MPESA_KEY;
const MPESA_SECRET = process.env.MPESA_SECRET;
const MPESA_SHORTCODE = process.env.MPESA_SHORTCODE;
const MPESA_PASSKEY = process.env.MPESA_PASSKEY;
const FROM_EMAIL = process.env.FROM_EMAIL || 'orders@sitesawa.co.ke';
const FROM_NAME = process.env.FROM_NAME || 'SiteSawa';
const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
const MPESA_ENVIRONMENT = process.env.MPESA_ENVIRONMENT || 'sandbox';
const HOSTAFRICA_API_KEY = process.env.HOSTAFRICA_API_KEY;
const HOSTAFRICA_USERNAME = process.env.HOSTAFRICA_USERNAME;
const RENDER_API_KEY = process.env.RENDER_API_KEY;
const AT_USERNAME = process.env.AT_USERNAME;
const AT_APIKEY = process.env.AT_APIKEY;

const hostafrica = new HostAfricaManager(HOSTAFRICA_API_KEY, HOSTAFRICA_USERNAME);
const render = new RenderDeployer(RENDER_API_KEY);

const VALID_ITEMS = [
    'Business Showcase',
    'Professional Portfolio',
    'Online Store Pro',
    'Starter Package',
    'Business Package'
];

const VALID_PRICES = {
    'Business Showcase': 7500,
    'Professional Portfolio': 7500,
    'Online Store Pro': 9500,
    'Starter Package': 9999,
    'Business Package': 14999
};

function validateConfig() {
    const required = ['MPESA_KEY', 'MPESA_SECRET', 'MPESA_SHORTCODE', 'MPESA_PASSKEY'];
    const missing = required.filter(key => !process.env[key]);
    if (missing.length > 0) {
        console.warn(`Missing M-Pesa config: ${missing.join(', ')}`);
    }
    if (!GMAIL_USER || !GMAIL_APP_PASSWORD) {
        console.warn('Gmail not configured - emails will be logged only');
    }
    if (!HOSTAFRICA_API_KEY) {
        console.warn('Host Africa not configured - domain registration disabled');
    }
    if (!RENDER_API_KEY) {
        console.warn('Render not configured - auto-deployment disabled');
    }
    if (!AT_USERNAME || !AT_APIKEY) {
        console.warn('Africa\'s Talking not configured - SMS disabled');
    }
}
validateConfig();

// ==================== HELPER FUNCTIONS ====================
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
    if (!AT_USERNAME || !AT_APIKEY) {
        console.log('📱 [SMS LOG] To:', phone, 'Message:', message);
        return;
    }
    
    try {
        await axios.post('https://api.africastalking.com/version1/messaging', {
            username: AT_USERNAME,
            to: phone,
            message: message
        }, {
            headers: { 
                'apiKey': AT_APIKEY,
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            timeout: 10000
        });
        console.log(`📱 SMS sent to ${phone}`);
    } catch (error) {
        console.error('SMS failed:', error.message);
    }
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

// ==================== ROUTES ====================
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        time: new Date().toISOString(),
        orders: orders.size,
        uptime: process.uptime(),
        email_configured: !!(GMAIL_USER && GMAIL_APP_PASSWORD),
        hostafrica_configured: !!HOSTAFRICA_API_KEY,
        render_configured: !!RENDER_API_KEY,
        sms_configured: !!(AT_USERNAME && AT_APIKEY)
    });
});

app.post('/api/create-order', createOrderLimiter, async (req, res) => {
    try {
        const { name, email, phone, domain, item, price, type, domainOption } = req.body;
        
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
        
        if (VALID_PRICES[item] !== price) {
            return res.status(400).json({ success: false, message: 'Invalid price' });
        }
        
        if (!['template', 'package'].includes(type)) {
            return res.status(400).json({ success: false, message: 'Invalid type' });
        }
        
        let finalDomain = cleanDomain;
        if (domainOption === 'auto') {
            finalDomain = cleanName.toLowerCase().replace(/[^a-z0-9]/g, '') + '-business.co.ke';
        } else if (!cleanDomain || !validator.isFQDN(cleanDomain)) {
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
            domain: finalDomain,
            domainOption: domainOption || 'custom',
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
            TransactionDesc: `SiteSawa ${item}`
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
            
            saveData();
            
            // AUTO-PROVISIONING
            try {
                if (order.domainOption === 'auto' && HOSTAFRICA_API_KEY) {
                    const domainResult = await hostafrica.registerDomain(order.domain, {
                        name: order.name,
                        email: order.email,
                        phone: order.phone
                    });
                    
                    if (domainResult.success) {
                        order.domainRegistered = true;
                        await hostafrica.configureDNS(order.domain);
                        
                        // AUTO-CREATE EMAILS FOR PACKAGES
                        if (order.type === 'package') {
                            const emailCount = order.item === 'Business Package' ? 5 : 1;
                            const emailUsers = ['info', 'admin', 'support', 'sales', 'contact'].slice(0, emailCount);
                            const emailResult = await hostafrica.createEmailAccounts(
                                order.domain, 
                                emailUsers, 
                                order.item === 'Business Package' ? 'business' : 'starter'
                            );
                            order.emailsCreated = emailResult.emails;
                        }
                    }
                }
                
                if (RENDER_API_KEY) {
                    const deployResult = await render.deploySite(order, order.item);
                    if (deployResult.success) {
                        order.deployedUrl = deployResult.url;
                        order.customDomainUrl = deployResult.customDomain;
                        order.renderServiceId = deployResult.serviceId;
                    }
                }
                
                order.status = 'completed';
                order.deliveredAt = new Date();
                saveData();
                
            } catch (provisionError) {
                console.error('Provisioning error:', provisionError);
                order.status = 'provision_failed';
                order.provisionError = provisionError.message;
                saveData();
            }
            
            const isTemplate = ['Business Showcase', 'Professional Portfolio', 'Online Store Pro'].includes(order.item);
            const accessUrl = order.customDomainUrl || order.deployedUrl || `https://${order.domain}`;
            
            // SEND EMAIL
            await sendEmail(order.email, '🎉 Your SiteSawa Order is Ready!', `
                <!DOCTYPE html>
                <html>
                <body style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                    <div style="background: #059669; color: white; padding: 30px; text-align: center;">
                        <h1>🏗️ SiteSawa</h1>
                    </div>
                    <div style="padding: 30px;">
                        <h2>Hi ${validator.escape(order.name)},</h2>
                        <p>Thank you for your purchase! Payment confirmed.</p>
                        <div style="background: #f0fdf4; padding: 20px; border-left: 4px solid #059669; margin: 20px 0;">
                            <p><strong>Item:</strong> ${validator.escape(order.item)}</p>
                            <p><strong>Amount:</strong> KES ${order.price.toLocaleString()}</p>
                            <p><strong>Receipt:</strong> ${validator.escape(receipt || 'N/A')}</p>
                            <p><strong>Domain:</strong> ${validator.escape(order.domain)}</p>
                            ${order.emailsCreated ? `<p><strong>Email Accounts:</strong> ${order.emailsCreated.map(e => e.email).join(', ')}</p>` : ''}
                        </div>
                        <div style="text-align: center; margin: 30px 0;">
                            <a href="${accessUrl}" style="background: #059669; color: white; padding: 16px 32px; text-decoration: none; border-radius: 8px; display: inline-block;">Visit Your Website</a>
                        </div>
                        ${isTemplate ? `
                        <div style="background: #fef3c7; padding: 15px; border-radius: 8px; margin: 20px 0;">
                            <p><strong>Admin Access:</strong></p>
                            <p>URL: ${accessUrl}/admin</p>
                            <p>Username: admin</p>
                            <p>Password: admin123</p>
                            <p style="font-size: 12px; color: #92400e;">Please change this password immediately after login.</p>
                        </div>
                        ` : ''}
                        <p style="color: #6b7280; font-size: 12px; text-align: center;">Need help? Reply to this email or WhatsApp us.</p>
                    </div>
                </body>
                </html>
            `);
            
            // SEND SMS
            await sendSMS(order.phone, `SiteSawa: Your ${order.item} is ready! Check your email. Receipt: ${receipt}`);
            
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
        domain: order.domain,
        deployedUrl: order.deployedUrl,
        failureReason: order.failureReason
    });
});

app.get('/download/:token', async (req, res) => {
    const orderId = tokenIndex.get(req.params.token);
    if (!orderId) return res.status(404).send('Link not found');
    
    const order = orders.get(orderId);
    if (!order || !order.paid) return res.status(403).send('Not allowed');
    
    const accessUrl = order.customDomainUrl || order.deployedUrl || `https://${order.domain}`;
    return res.redirect(accessUrl);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 SiteSawa Server running on port ${PORT}`);
    console.log(`📧 Email: ${GMAIL_USER ? 'Configured' : 'Not configured'}`);
    console.log(`🌐 Domain: ${HOSTAFRICA_API_KEY ? 'Host Africa ready' : 'Not configured'}`);
    console.log(`🚀 Deploy: ${RENDER_API_KEY ? 'Render ready' : 'Not configured'}`);
    console.log(`📱 SMS: ${AT_USERNAME ? 'Africa\'s Talking ready' : 'Not configured'}`);
});
