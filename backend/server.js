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
app.use(express.raw({ type: 'application/json' }));

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

// ==================== AFRICA'S TALKING SMS ====================
async function sendSMS(phone, message) {
    const username = process.env.AT_USERNAME;
    const apiKey = process.env.AT_APIKEY;

    if (!username || !apiKey) {
        console.log('📱 [SMS LOG] To:', phone, 'Message:', message);
        return { success: false, error: 'SMS not configured' };
    }

    try {
        const response = await axios.post('https://api.africastalking.com/version1/messaging', {
            username: username,
            to: phone,
            message: message
        }, {
            headers: { 
                'apiKey': apiKey,
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            timeout: 10000
        });
        console.log(`📱 SMS sent to ${phone}`);
        return { success: true, data: response.data };
    } catch (error) {
        console.error('SMS failed:', error.message);
        return { success: false, error: error.message };
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
            const service = await this.createRenderService(orderData.domain, repoUrl, templateType);
            await this.configureDomain(service.id, orderData.domain);

            return {
                success: true,
                url: `https://${service.id}.onrender.com`,
                customDomain: `https://${orderData.domain}`,
                serviceId: service.id,
                adminUrl: templateType === 'online-store-pro' ? `https://${orderData.domain}/admin` : null,
                message: 'Site deployed successfully'
            };
        } catch (error) {
            console.error('Deployment failed:', error.message);
            return { success: false, error: error.message };
        }
    }

    async createTemplateRepo(orderData, templateType) {
        const repoName = orderData.domain.replace(/\./g, '-');
        return `https://github.com/sitesawa/${repoName}`;
    }

    async createRenderService(domain, repoUrl, templateType) {
        const serviceName = domain.replace(/\./g, '-');

        const response = await axios.post(`${this.baseUrl}/services`, {
            type: 'static_site',
            name: serviceName,
            ownerId: process.env.RENDER_OWNER_ID,
            repo: repoUrl,
            branch: 'main',
            buildCommand: '',
            publishPath: '.',
            envVars: [
                { key: 'GA_ID', value: process.env.DEFAULT_GA_ID || '' },
                { key: 'RECAPTCHA_SITE_KEY', value: process.env.RECAPTCHA_SITE_KEY || '' },
                { key: 'STORE_DOMAIN', value: domain },
                { key: 'API_BASE', value: process.env.SERVER_URL || '' }
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

// ==================== TEMPLATE MANAGER (FILE-BASED) ====================
class TemplateManager {
    constructor() {
        this.templatesDir = path.join(__dirname, 'templates');
        this.ensureTemplatesExist();
    }

    ensureTemplatesExist() {
        if (!fs.existsSync(this.templatesDir)) {
            fs.mkdirSync(this.templatesDir, { recursive: true });
        }

        const templateFiles = [
            'business-showcase.html',
            'professional-portfolio.html',
            'online-store-pro.html',
            'admin-dashboard.html'
        ];

        for (const file of templateFiles) {
            const filePath = path.join(this.templatesDir, file);
            if (!fs.existsSync(filePath)) {
                console.warn(`⚠️ Template missing: ${file}. Please add template files to /templates/`);
            }
        }
    }

    loadTemplate(templateName) {
        const filePath = path.join(this.templatesDir, `${templateName}.html`);
        if (!fs.existsSync(filePath)) {
            throw new Error(`Template not found: ${templateName}`);
        }
        return fs.readFileSync(filePath, 'utf8');
    }

    // Inject customer data into template using regex replacement
    renderTemplate(templateName, data) {
        let template = this.loadTemplate(templateName);

        // Replace all data placeholders like <!--DATA:KEY-->value<!--/DATA:KEY-->
        // or simple comments that mark editable regions
        for (const [key, value] of Object.entries(data)) {
            // Replace HTML comments: <!-- KEY --> ... <!-- /KEY -->
            const regex = new RegExp(`<!--\s*${key}\s*-->.*?<!--\s*/${key}\s*-->`, 'gs');
            template = template.replace(regex, `<!-- ${key} -->${value}<!-- /${key} -->`);

            // Also replace simple text placeholders if they exist
            const simpleRegex = new RegExp(`\[\[${key}\]\]`, 'g');
            template = template.replace(simpleRegex, value);
        }

        return template;
    }

    // Generate a complete site package for a customer
    generateSitePackage(orderData, templateType) {
        const template = this.loadTemplate(templateType);
        const adminTemplate = templateType === 'online-store-pro' ? this.loadTemplate('admin-dashboard') : null;

        // Build customer data injection
        const customerData = this.buildCustomerData(orderData, templateType);

        // Render main site
        let mainHtml = template;
        for (const [key, value] of Object.entries(customerData)) {
            mainHtml = mainHtml.replace(new RegExp(`\[\[${key}\]\]`, 'g'), value);
        }

        // Render admin if store
        let adminHtml = null;
        if (adminTemplate) {
            adminHtml = adminTemplate;
            for (const [key, value] of Object.entries(customerData)) {
                adminHtml = adminHtml.replace(new RegExp(`\[\[${key}\]\]`, 'g'), value);
            }
        }

        return {
            mainHtml,
            adminHtml,
            templateType
        };
    }

    buildCustomerData(orderData, templateType) {
        const baseData = {
            TIKTOK_PIXEL_ID: orderData.tiktokPixelId || process.env.DEFAULT_TIKTOK_PIXEL || '',
            BUSINESS_NAME: orderData.businessName || orderData.name || 'My Business',
            NAME: orderData.name || 'John Doe',
            STORE_NAME: orderData.businessName || orderData.name || 'My Store',
            TAGLINE: orderData.tagline || 'Quality Service You Can Trust',
            DESCRIPTION: orderData.description || 'We provide excellent services to our customers.',
            EMAIL: orderData.email || 'info@example.com',
            PHONE: orderData.phone || '+254 712 345 678',
            WHATSAPP_NUMBER: orderData.whatsapp || orderData.phone || '254712345678',
            ADDRESS: orderData.address || 'Nairobi, Kenya',
            HERO_IMAGE: orderData.heroImage || 'https://images.unsplash.com/photo-1486406146926-c627a92ad1ab?w=800',
            ABOUT_IMAGE: orderData.aboutImage || 'https://images.unsplash.com/photo-1497215842964-222b430dc094?w=800',
            PROFILE_IMAGE: orderData.profileImage || 'https://images.unsplash.com/photo-1542744173-8e7e53415bb0?w=800',
            API_BASE: process.env.SERVER_URL || '',
            ADMIN_PASSWORD: orderData.adminPassword || this.generatePassword(),
            FACEBOOK_URL: orderData.facebook || 'https://facebook.com',
            INSTAGRAM_URL: orderData.instagram || 'https://instagram.com',
            TWITTER_URL: orderData.twitter || 'https://twitter.com',
            LINKEDIN_URL: orderData.linkedin || 'https://linkedin.com',
            DOMAIN: orderData.domain || 'example.co.ke'
        };

        // Template-specific data
        if (templateType === 'business-showcase') {
            baseData.SERVICES = this.buildServicesHtml(orderData.services);
        }

        if (templateType === 'professional-portfolio') {
            baseData.TITLE = orderData.title || 'Creative Professional';
            baseData.PORTFOLIO_ITEMS = this.buildPortfolioHtml(orderData.portfolio);
            baseData.RESUME_URL = orderData.resumeUrl || '#';
        }

        if (templateType === 'online-store-pro') {
            baseData.PRODUCTS = this.buildProductsHtml(orderData.products);
        }

        return baseData;
    }

    buildServicesHtml(services) {
        if (!services || services.length === 0) {
            return `<div class="col-md-4"><div class="card service-card h-100 p-4"><div class="card-body"><h5 class="card-title fw-bold">Service One</h5><p class="card-text text-muted">Description here.</p><p class="fw-bold text-primary">KES 2,000</p><button class="btn mpesa-btn btn-sm"><i class="fas fa-mobile-alt me-1"></i>Pay with M-Pesa</button></div></div></div>`;
        }
        return services.map((s, i) => `
            <div class="col-md-4">
                <div class="card service-card h-100 p-4">
                    <div class="card-body">
                        <h5 class="card-title fw-bold">${s.name || 'Service ' + (i+1)}</h5>
                        <p class="card-text text-muted">${s.description || ''}</p>
                        <p class="fw-bold text-primary">KES ${(s.price || 2000).toLocaleString()}</p>
                        <button class="btn mpesa-btn btn-sm" onclick="openMpesaModal('${s.name}', ${s.price || 2000})">
                            <i class="fas fa-mobile-alt me-1"></i>Pay with M-Pesa
                        </button>
                    </div>
                </div>
            </div>
        `).join('');
    }

    buildPortfolioHtml(items) {
        if (!items || items.length === 0) {
            return `<div class="col-md-4"><div class="card portfolio-card"><img src="https://images.unsplash.com/photo-1561070791-2526d30994b5?w=600" class="card-img-top"><div class="card-body"><h5 class="card-title fw-bold">Project One</h5><p class="card-text text-muted">Description here.</p></div></div></div>`;
        }
        return items.map((item, i) => `
            <div class="col-md-4">
                <div class="card portfolio-card">
                    <img src="${item.image || 'https://images.unsplash.com/photo-1561070791-2526d30994b5?w=600'}" class="card-img-top" alt="${item.title}">
                    <div class="card-body">
                        <h5 class="card-title fw-bold">${item.title || 'Project ' + (i+1)}</h5>
                        <p class="card-text text-muted">${item.description || ''}</p>
                        ${item.price ? `<p class="fw-bold text-primary">KES ${item.price.toLocaleString()}</p><button class="btn mpesa-btn btn-sm" onclick="openMpesaModal('${item.title}', ${item.price})"><i class="fas fa-mobile-alt me-1"></i>Book & Pay</button>` : ''}
                    </div>
                </div>
            </div>
        `).join('');
    }

    buildProductsHtml(products) {
        if (!products || products.length === 0) {
            return this.getDefaultProductsHtml();
        }
        return products.map((p, i) => `
            <div class="col-md-3">
                <div class="card product-card h-100">
                    <img src="${p.image || 'https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=400'}" class="card-img-top" alt="${p.name}">
                    <div class="card-body">
                        <h5 class="card-title fw-bold">${p.name || 'Product ' + (i+1)}</h5>
                        <p class="card-text text-muted small">${p.description || ''}</p>
                        <div class="d-flex justify-content-between align-items-center">
                            <span class="fw-bold">KES ${(p.price || 1500).toLocaleString()}</span>
                            <button class="btn btn-dark btn-sm" onclick="addToCart('${p.id || i}', '${p.name}', ${p.price || 1500}, '${p.image || ''}')">Add</button>
                        </div>
                    </div>
                </div>
            </div>
        `).join('');
    }

    getDefaultProductsHtml() {
        const defaults = [
            { id: '1', name: 'Product One', price: 1500, image: 'https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=400', desc: 'High quality item' },
            { id: '2', name: 'Product Two', price: 2000, image: 'https://images.unsplash.com/photo-1505740420928-5e560c06d30e?w=400', desc: 'Premium quality' },
            { id: '3', name: 'Product Three', price: 1200, image: 'https://images.unsplash.com/photo-1572635196237-14b3f281503f?w=400', desc: 'Best seller' },
            { id: '4', name: 'Product Four', price: 3500, image: 'https://images.unsplash.com/photo-1560343090-f0409e92791a?w=400', desc: 'New arrival' }
        ];
        return defaults.map(p => `
            <div class="col-md-3">
                <div class="card product-card h-100">
                    <img src="${p.image}" class="card-img-top" alt="${p.name}">
                    <div class="card-body">
                        <h5 class="card-title fw-bold">${p.name}</h5>
                        <p class="card-text text-muted small">${p.desc}</p>
                        <div class="d-flex justify-content-between align-items-center">
                            <span class="fw-bold">KES ${p.price.toLocaleString()}</span>
                            <button class="btn btn-dark btn-sm" onclick="addToCart('${p.id}', '${p.name}', ${p.price}, '${p.image}')">Add</button>
                        </div>
                    </div>
                </div>
            </div>
        `).join('');
    }

    generatePassword() {
        return crypto.randomBytes(4).toString('hex');
    }
}

const templateManager = new TemplateManager();

// ==================== DATA STORAGE ====================
const DATA_FILE = path.join(__dirname, 'orders.json');
const PRODUCTS_FILE = path.join(__dirname, 'products.json');
const DEPLOYMENTS_FILE = path.join(__dirname, 'deployments.json');

let orders = new Map();
let products = new Map();
let deployments = new Map();

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
        if (fs.existsSync(PRODUCTS_FILE)) {
            const data = JSON.parse(fs.readFileSync(PRODUCTS_FILE, 'utf8'));
            products = new Map(Object.entries(data));
        }
        if (fs.existsSync(DEPLOYMENTS_FILE)) {
            const data = JSON.parse(fs.readFileSync(DEPLOYMENTS_FILE, 'utf8'));
            deployments = new Map(Object.entries(data));
        }
    } catch (error) {
        console.error('Error loading data:', error);
    }
}

function saveData() {
    try {
        const data = { orders: Object.fromEntries(orders) };
        fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
        fs.writeFileSync(PRODUCTS_FILE, JSON.stringify(Object.fromEntries(products), null, 2));
        fs.writeFileSync(DEPLOYMENTS_FILE, JSON.stringify(Object.fromEntries(deployments), null, 2));
    } catch (error) {
        console.error('Error saving data:', error);
    }
}

loadData();

// ==================== CONFIGURATION ====================
const MPESA_KEY = process.env.MPESA_KEY;
const MPESA_SECRET = process.env.MPESA_SECRET;
const MPESA_SHORTCODE = process.env.MPESA_SHORTCODE;
const MPESA_PASSKEY = process.env.MPESA_PASSKEY;
const FROM_EMAIL = process.env.FROM_EMAIL || 'orders@sitesawa.co.ke';
const FROM_NAME = process.env.FROM_NAME || 'SiteSawa';
const WORKSPACE_EMAIL = process.env.WORKSPACE_EMAIL;
const WORKSPACE_APP_PASSWORD = process.env.WORKSPACE_APP_PASSWORD;
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
const MPESA_ENVIRONMENT = process.env.MPESA_ENVIRONMENT || 'sandbox';
const AT_USERNAME = process.env.AT_USERNAME;
const AT_APIKEY = process.env.AT_APIKEY;
const RENDER_API_KEY = process.env.RENDER_API_KEY;
const RENDER_OWNER_ID = process.env.RENDER_OWNER_ID;

const VALID_ITEMS = [
    'Business Showcase',
    'Professional Portfolio',
    'Online Store Pro'
];

const VALID_PRICES = {
    'Business Showcase': 6000,
    'Professional Portfolio': 6000,
    'Online Store Pro': 8000
};

const TEMPLATE_MAP = {
    'Business Showcase': 'business-showcase',
    'Professional Portfolio': 'professional-portfolio',
    'Online Store Pro': 'online-store-pro'
};

// Initialize managers
const render = new RenderDeployer(RENDER_API_KEY);

function validateConfig() {
    const required = ['MPESA_KEY', 'MPESA_SECRET', 'MPESA_SHORTCODE', 'MPESA_PASSKEY'];
    const missing = required.filter(key => !process.env[key]);
    if (missing.length > 0) {
        console.warn(`Missing M-Pesa config: ${missing.join(', ')}`);
    }
    if (!WORKSPACE_EMAIL || !WORKSPACE_APP_PASSWORD) {
        console.warn('Google Workspace not configured - emails will be logged only');
    }
    if (!AT_USERNAME || !AT_APIKEY) {
        console.warn('Africa\'s Talking not configured - SMS will be logged only');
    }
    if (!RENDER_API_KEY) {
        console.warn('Render not configured - auto-deployment disabled');
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
    if (!WORKSPACE_EMAIL || !WORKSPACE_APP_PASSWORD) {
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
                user: WORKSPACE_EMAIL,
                pass: WORKSPACE_APP_PASSWORD
            }
        });

        await transporter.verify();

        const info = await transporter.sendMail({
            from: `\"${FROM_NAME}\" <${WORKSPACE_EMAIL}>`,
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

// ==================== SITE GENERATION & DEPLOYMENT ====================
async function generateAndDeploySite(orderData) {
    const templateType = TEMPLATE_MAP[orderData.item];
    if (!templateType) {
        throw new Error('Invalid template type');
    }

    // Generate site package with customer data
    const sitePackage = templateManager.generateSitePackage(orderData, templateType);

    // Save deployment record
    const deployId = crypto.randomUUID();
    deployments.set(deployId, {
        id: deployId,
        orderId: orderData.id,
        domain: orderData.domain,
        templateType,
        createdAt: new Date(),
        status: 'building'
    });
    saveData();

    // Deploy to Render if configured
    if (RENDER_API_KEY) {
        const deployResult = await render.deploySite(orderData, templateType);
        if (deployResult.success) {
            const dep = deployments.get(deployId);
            dep.status = 'deployed';
            dep.url = deployResult.url;
            dep.customDomain = deployResult.customDomain;
            dep.serviceId = deployResult.serviceId;
            dep.adminUrl = deployResult.adminUrl;
            saveData();
            return deployResult;
        }
    }

    // Fallback: save files locally for manual deployment
    const deployDir = path.join(__dirname, 'deployments', orderData.domain);
    fs.mkdirSync(deployDir, { recursive: true });
    fs.writeFileSync(path.join(deployDir, 'index.html'), sitePackage.mainHtml);
    if (sitePackage.adminHtml) {
        fs.mkdirSync(path.join(deployDir, 'admin'), { recursive: true });
        fs.writeFileSync(path.join(deployDir, 'admin', 'index.html'), sitePackage.adminHtml);
    }

    const dep = deployments.get(deployId);
    dep.status = 'files_ready';
    dep.localPath = deployDir;
    saveData();

    return {
        success: true,
        url: `/deployments/${orderData.domain}/`,
        customDomain: `https://${orderData.domain}`,
        message: 'Site files ready for deployment'
    };
}

// ==================== ROUTES ====================
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        time: new Date().toISOString(),
        orders: orders.size,
        products: products.size,
        deployments: deployments.size,
        uptime: process.uptime(),
        email_configured: !!(WORKSPACE_EMAIL && WORKSPACE_APP_PASSWORD),
        sms_configured: !!(AT_USERNAME && AT_APIKEY),
        render_configured: !!RENDER_API_KEY
    });
});

// Preview template with customer data (for testing)
app.post('/api/preview-site', async (req, res) => {
    try {
        const { templateType, ...customerData } = req.body;

        if (!templateType || !['business-showcase', 'professional-portfolio', 'online-store-pro'].includes(templateType)) {
            return res.status(400).json({ success: false, message: 'Invalid template type' });
        }

        const html = templateManager.generateSitePackage(customerData, templateType).mainHtml;
        res.send(html);
    } catch (error) {
        console.error('Preview error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// Create order
app.post('/api/create-order', createOrderLimiter, async (req, res) => {
    try {
        const { name, email, phone, domain, item, price, businessName, tagline, description, services, portfolio, products: customerProducts, ...extraData } = req.body;

        if (!name || !email || !phone || !domain || !item || !price) {
            return res.status(400).json({ success: false, message: 'Please fill all fields' });
        }

        const cleanName = sanitizeInput(name);
        const cleanEmail = sanitizeInput(email).toLowerCase();

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

        if (!validator.isFQDN(domain)) {
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
            domain: domain.toLowerCase(),
            item,
            price,
            businessName: sanitizeInput(businessName || name),
            tagline: sanitizeInput(tagline || ''),
            description: sanitizeInput(description || ''),
            services: services || [],
            portfolio: portfolio || [],
            products: customerProducts || [],
            ...extraData,
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

// M-Pesa callback
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

            saveData();

            // AUTO-PROVISIONING
            try {
                const deployResult = await generateAndDeploySite(order);

                if (deployResult.success) {
                    order.deployedUrl = deployResult.url;
                    order.customDomainUrl = deployResult.customDomain;
                    order.adminUrl = deployResult.adminUrl;
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

            // Send notifications
            const isStore = order.item === 'Online Store Pro';
            const accessUrl = order.customDomainUrl || order.deployedUrl || `https://${order.domain}`;

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
                        </div>
                        <div style="text-align: center; margin: 30px 0;">
                            <a href="${accessUrl}" style="background: #059669; color: white; padding: 16px 32px; text-decoration: none; border-radius: 8px; display: inline-block;">Visit Your Website</a>
                        </div>
                        ${isStore && order.adminUrl ? `
                        <div style="background: #fef3c7; padding: 15px; border-radius: 8px; margin: 20px 0;">
                            <p><strong>Admin Panel:</strong></p>
                            <p>URL: ${order.adminUrl}</p>
                            <p>Username: admin</p>
                            <p>Password: ${order.adminPassword || 'Check your deployment email'}</p>
                            <p style="font-size: 12px; color: #92400e;">Change this password immediately after login.</p>
                        </div>
                        ` : ''}
                        <p style="color: #6b7280; font-size: 12px; text-align: center;">Need help? Reply to this email or WhatsApp us.</p>
                    </div>
                </body>
                </html>
            `);

            await sendSMS(order.phone, `SiteSawa: Your ${order.item} is ready! Domain: ${order.domain}. Check your email for details.`);

        } else {
            order.status = 'failed';
            order.failureReason = callback.ResultDesc;
            saveData();
        }

    } catch (error) {
        console.error('Callback error:', error);
    }
});

// Check order status
app.get('/api/check-status', async (req, res) => {
    const order = orders.get(req.query.orderId);
    if (!order) return res.json({ paid: false });

    res.json({
        paid: order.paid,
        status: order.status,
        mpesaReceipt: order.mpesaReceipt,
        domain: order.domain,
        deployedUrl: order.deployedUrl,
        adminUrl: order.adminUrl,
        failureReason: order.failureReason
    });
});

// Product API
app.get('/api/products', (req, res) => {
    const storeDomain = req.query.store || req.headers.host;
    const storeProducts = Array.from(products.values()).filter(
        p => p.storeDomain === storeDomain || p.storeDomain === 'default'
    );
    res.json({
        success: true,
        store: storeDomain,
        count: storeProducts.length,
        products: storeProducts
    });
});

app.post('/api/products', async (req, res) => {
    try {
        const { id, name, price, image, description, category, stock, storeDomain } = req.body;

        if (!name || !price) {
            return res.status(400).json({ success: false, message: 'Product name and price required' });
        }

        const product = {
            id: id || crypto.randomUUID(),
            name: sanitizeInput(name),
            price: parseInt(price) || 0,
            image: image || 'https://via.placeholder.com/300',
            description: sanitizeInput(description || ''),
            category: category || 'general',
            stock: parseInt(stock) || 10,
            storeDomain: storeDomain || req.headers.host || 'default',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };

        products.set(product.id, product);
        saveData();

        res.json({ 
            success: true, 
            message: 'Product saved. Will be live in 2-3 minutes.',
            product 
        });

    } catch (error) {
        console.error('Product save error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.delete('/api/products/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const product = products.get(id);

        if (!product) {
            return res.status(404).json({ success: false, message: 'Product not found' });
        }

        products.delete(id);
        saveData();

        res.json({ success: true, message: 'Product deleted.' });

    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Deployment API
app.get('/api/deployments/:orderId', async (req, res) => {
    try {
        const order = orders.get(req.params.orderId);
        if (!order) {
            return res.status(404).json({ success: false, message: 'Order not found' });
        }

        const deployment = Array.from(deployments.values()).find(d => d.orderId === req.params.orderId);

        res.json({
            success: true,
            order: {
                id: order.id,
                domain: order.domain,
                item: order.item,
                status: order.status,
                deployedUrl: order.deployedUrl,
                adminUrl: order.adminUrl
            },
            deployment: deployment || null
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Serve deployment files
app.use('/deployments', express.static(path.join(__dirname, 'deployments')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 SiteSawa Server v2.1 running on port ${PORT}`);
    console.log(`📧 Email: ${WORKSPACE_EMAIL ? 'Google Workspace ready' : 'Not configured'}`);
    console.log(`📱 SMS: ${AT_USERNAME ? 'Africa\'s Talking ready' : 'Not configured'}`);
    console.log(`🚀 Render: ${RENDER_API_KEY ? 'Deployment ready' : 'Not configured'}`);
    console.log(`📦 Templates: ${VALID_ITEMS.join(', ')}`);
    console.log(`💰 Prices: Business/Portfolio KES 6,000 | Store KES 8,000`);
    console.log(`🔧 File-based templates: ${fs.existsSync(path.join(__dirname, 'templates')) ? 'Ready' : 'Create /templates/ folder'}`);
});
