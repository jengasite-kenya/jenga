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

// ==================== TEMPLATE MANAGER ====================
class TemplateManager {
    constructor() {
        this.templatesDir = path.join(__dirname, 'templates');
        this.ensureTemplatesExist();
    }

    ensureTemplatesExist() {
        if (!fs.existsSync(this.templatesDir)) {
            fs.mkdirSync(this.templatesDir, { recursive: true });
        }

        const templates = {
            'business-showcase': this.getBusinessShowcaseTemplate(),
            'professional-portfolio': this.getPortfolioTemplate(),
            'online-store-pro': this.getStoreTemplate(),
            'admin-dashboard': this.getAdminTemplate()
        };

        for (const [name, content] of Object.entries(templates)) {
            const filePath = path.join(this.templatesDir, `${name}.html`);
            if (!fs.existsSync(filePath)) {
                fs.writeFileSync(filePath, content);
                console.log(`✅ Created template: ${name}`);
            }
        }
    }

    getBusinessShowcaseTemplate() {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>{{BUSINESS_NAME}}</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@300;400;500;600;700&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <script>
        tailwind.config = {
            theme: {
                extend: {
                    colors: {
                        primary: '#14B8A6',
                        secondary: '#F97316',
                        accent: '#FACC15',
                        cream: '#FEFCE8'
                    },
                    fontFamily: { sans: ['Poppins', 'sans-serif'] }
                }
            }
        }
    </script>
    <style>
        .gradient-text { background: linear-gradient(135deg, #14B8A6 0%, #F97316 100%); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
        .hero-pattern { background-image: url("data:image/svg+xml,%3Csvg width='60' height='60' viewBox='0 0 60 60' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='none' fill-rule='evenodd'%3E%3Cg fill='%2314B8A6' fill-opacity='0.05'%3E%3Cpath d='M36 34v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zm0-30V0h-2v4h-4v2h4v4h2V6h4V4h-4zM6 34v-4H4v4H0v2h4v4h2v-4h4v-2H6zM6 4V0H4v4H0v2h4v4h2V6h4V4H6z'/%3E%3C/g%3E%3C/g%3E%3C/svg%3E"); }
        .float-animation { animation: float 6s ease-in-out infinite; }
        @keyframes float { 0%, 100% { transform: translateY(0px); } 50% { transform: translateY(-20px); } }
    </style>
</head>
<body class="bg-cream font-sans text-gray-800">
    <nav class="fixed w-full bg-white/90 backdrop-blur-md shadow-sm z-50">
        <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div class="flex justify-between items-center h-20">
                <span class="text-3xl font-bold gradient-text">{{BUSINESS_NAME}}</span>
                <div class="hidden md:flex space-x-8">
                    <a href="#home" class="text-gray-700 hover:text-primary transition font-medium">Home</a>
                    <a href="#services" class="text-gray-700 hover:text-primary transition font-medium">Services</a>
                    <a href="#about" class="text-gray-700 hover:text-primary transition font-medium">About</a>
                    <a href="#contact" class="px-6 py-2 bg-primary text-white rounded-full hover:bg-teal-600 transition font-medium">Contact Us</a>
                </div>
                <button class="md:hidden text-2xl text-primary" onclick="document.getElementById('mobileMenu').classList.toggle('hidden')">
                    <i class="fas fa-bars"></i>
                </button>
            </div>
        </div>
        <div id="mobileMenu" class="hidden md:hidden bg-white border-t">
            <div class="px-4 py-4 space-y-3">
                <a href="#home" class="block text-gray-700 hover:text-primary">Home</a>
                <a href="#services" class="block text-gray-700 hover:text-primary">Services</a>
                <a href="#about" class="block text-gray-700 hover:text-primary">About</a>
                <a href="#contact" class="block text-primary font-medium">Contact Us</a>
            </div>
        </div>
    </nav>

    <section id="home" class="relative pt-32 pb-20 lg:pt-40 lg:pb-32 overflow-hidden">
        <div class="absolute inset-0 hero-pattern opacity-50"></div>
        <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 relative">
            <div class="grid lg:grid-cols-2 gap-12 items-center">
                <div class="text-center lg:text-left">
                    <div class="inline-block px-4 py-2 bg-primary/10 text-primary rounded-full text-sm font-semibold mb-6">✨ Welcome to {{BUSINESS_NAME}}</div>
                    <h1 class="text-5xl lg:text-6xl font-bold leading-tight mb-6">{{TAGLINE}} <span class="gradient-text">Excellence</span></h1>
                    <p class="text-xl text-gray-600 mb-8 leading-relaxed">{{DESCRIPTION}}</p>
                    <div class="flex flex-col sm:flex-row gap-4 justify-center lg:justify-start">
                        <a href="#contact" class="px-8 py-4 bg-primary text-white rounded-full font-semibold hover:bg-teal-600 transition shadow-lg">Book Now</a>
                        <a href="https://wa.me/{{WHATSAPP_NUMBER}}" class="px-8 py-4 bg-green-500 text-white rounded-full font-semibold hover:bg-green-600 transition flex items-center justify-center gap-2">
                            <i class="fab fa-whatsapp text-xl"></i>WhatsApp Us
                        </a>
                    </div>
                </div>
                <div class="relative">
                    <div class="absolute inset-0 bg-gradient-to-r from-primary/20 to-secondary/20 rounded-3xl transform rotate-3"></div>
                    <img src="{{HERO_IMAGE}}" alt="{{BUSINESS_NAME}}" class="relative rounded-3xl shadow-2xl float-animation w-full object-cover h-96 lg:h-[500px]">
                </div>
            </div>
        </div>
    </section>

    <section id="services" class="py-20 bg-white">
        <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div class="text-center mb-16">
                <span class="text-secondary font-semibold text-sm uppercase tracking-wide">What We Offer</span>
                <h2 class="text-4xl font-bold mt-2 mb-4">Our Services</h2>
                <div class="w-24 h-1 bg-primary mx-auto rounded-full"></div>
            </div>
            <div class="grid md:grid-cols-2 lg:grid-cols-3 gap-8">
                {{SERVICES}}
            </div>
        </div>
    </section>

    <section id="contact" class="py-20 bg-gradient-to-br from-primary/5 to-secondary/5">
        <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div class="text-center mb-16">
                <span class="text-secondary font-semibold text-sm uppercase tracking-wide">Get In Touch</span>
                <h2 class="text-4xl font-bold mt-2 mb-4">Contact Us</h2>
                <div class="w-24 h-1 bg-primary mx-auto rounded-full"></div>
            </div>
            <div class="grid lg:grid-cols-2 gap-12">
                <div class="space-y-8">
                    <div class="bg-white p-8 rounded-2xl shadow-lg">
                        <h3 class="text-2xl font-bold mb-6">Visit Us</h3>
                        <div class="space-y-4">
                            <div class="flex items-start gap-4">
                                <div class="w-12 h-12 bg-primary/10 rounded-full flex items-center justify-center text-primary shrink-0"><i class="fas fa-map-marker-alt text-xl"></i></div>
                                <div><h4 class="font-semibold mb-1">Address</h4><p class="text-gray-600">{{ADDRESS}}</p></div>
                            </div>
                            <div class="flex items-start gap-4">
                                <div class="w-12 h-12 bg-primary/10 rounded-full flex items-center justify-center text-primary shrink-0"><i class="fas fa-phone text-xl"></i></div>
                                <div><h4 class="font-semibold mb-1">Phone</h4><p class="text-gray-600">{{PHONE}}</p></div>
                            </div>
                            <div class="flex items-start gap-4">
                                <div class="w-12 h-12 bg-primary/10 rounded-full flex items-center justify-center text-primary shrink-0"><i class="fas fa-envelope text-xl"></i></div>
                                <div><h4 class="font-semibold mb-1">Email</h4><p class="text-gray-600">{{EMAIL}}</p></div>
                            </div>
                        </div>
                    </div>
                </div>
                <div class="bg-white p-8 rounded-2xl shadow-lg">
                    <h3 class="text-2xl font-bold mb-6">Send us a Message</h3>
                    <form id="contactForm" class="space-y-6">
                        <div class="grid md:grid-cols-2 gap-6">
                            <div>
                                <label class="block text-sm font-medium text-gray-700 mb-2">Your Name</label>
                                <input type="text" required class="w-full px-4 py-3 border border-gray-300 rounded-xl focus:ring-2 focus:ring-primary outline-none" placeholder="John Doe">
                            </div>
                            <div>
                                <label class="block text-sm font-medium text-gray-700 mb-2">Phone Number</label>
                                <input type="tel" required class="w-full px-4 py-3 border border-gray-300 rounded-xl focus:ring-2 focus:ring-primary outline-none" placeholder="0712345678">
                            </div>
                        </div>
                        <div>
                            <label class="block text-sm font-medium text-gray-700 mb-2">Email Address</label>
                            <input type="email" required class="w-full px-4 py-3 border border-gray-300 rounded-xl focus:ring-2 focus:ring-primary outline-none" placeholder="john@example.com">
                        </div>
                        <div>
                            <label class="block text-sm font-medium text-gray-700 mb-2">Message</label>
                            <textarea rows="4" required class="w-full px-4 py-3 border border-gray-300 rounded-xl focus:ring-2 focus:ring-primary outline-none" placeholder="Tell us what you need..."></textarea>
                        </div>
                        <button type="submit" class="w-full py-4 bg-primary text-white rounded-xl font-semibold hover:bg-teal-600 transition">Send Message</button>
                    </form>
                </div>
            </div>
        </div>
    </section>

    <footer class="bg-gray-900 text-white py-12">
        <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
            <p class="text-gray-400">&copy; 2024 {{BUSINESS_NAME}}. All rights reserved.</p>
        </div>
    </footer>

    <script>
        document.getElementById('contactForm')?.addEventListener('submit', function(e) {
            e.preventDefault();
            alert('Thank you for your message! We will get back to you soon.');
            this.reset();
        });
    </script>
</body>
</html>`;
    }

    getPortfolioTemplate() {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>{{NAME}} - {{TITLE}}</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <script>
        tailwind.config = {
            theme: {
                extend: {
                    colors: {
                        electric: '#3B82F6',
                        hotpink: '#EC4899',
                        lime: '#84CC16'
                    },
                    fontFamily: { display: ['Outfit', 'sans-serif'] }
                }
            }
        }
    </script>
    <style>
        .text-gradient { background: linear-gradient(135deg, #3B82F6 0%, #EC4899 100%); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
        .blob { position: absolute; filter: blur(40px); opacity: 0.4; animation: move 20s infinite alternate; }
        @keyframes move { from { transform: translate(0, 0) scale(1); } to { transform: translate(20px, -20px) scale(1.1); } }
    </style>
</head>
<body class="font-sans bg-gray-50 text-gray-800 overflow-x-hidden">
    <nav class="fixed w-full bg-white/80 backdrop-blur-lg z-50 border-b border-gray-100">
        <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div class="flex justify-between items-center h-20">
                <span class="font-display text-2xl font-bold text-gradient">{{NAME}}</span>
                <div class="hidden md:flex space-x-8">
                    <a href="#work" class="text-gray-600 hover:text-electric transition font-medium">Work</a>
                    <a href="#about" class="text-gray-600 hover:text-electric transition font-medium">About</a>
                    <a href="#contact" class="px-6 py-2 bg-electric text-white rounded-full hover:bg-blue-600 transition font-medium">Let's Talk</a>
                </div>
            </div>
        </div>
    </nav>

    <section class="relative min-h-screen flex items-center justify-center pt-20 overflow-hidden">
        <div class="blob bg-electric w-96 h-96 rounded-full top-0 left-0 -translate-x-1/2 -translate-y-1/2"></div>
        <div class="blob bg-hotpink w-96 h-96 rounded-full bottom-0 right-0 translate-x-1/2 translate-y-1/2"></div>
        <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 relative z-10">
            <div class="grid lg:grid-cols-2 gap-12 items-center">
                <div class="text-center lg:text-left">
                    <p class="text-electric font-semibold mb-4">👋 Hello, I'm {{NAME}}</p>
                    <h1 class="font-display text-5xl lg:text-7xl font-bold leading-tight mb-6">{{TITLE}}<br><span class="text-gradient">& Creative</span></h1>
                    <p class="text-xl text-gray-600 mb-8 leading-relaxed">{{DESCRIPTION}}</p>
                    <div class="flex flex-col sm:flex-row gap-4 justify-center lg:justify-start">
                        <a href="#work" class="px-8 py-4 bg-electric text-white rounded-full font-semibold hover:bg-blue-600 transition shadow-lg">View My Work</a>
                        <a href="{{RESUME_URL}}" class="px-8 py-4 border-2 border-electric text-electric rounded-full font-semibold hover:bg-electric hover:text-white transition">Download CV</a>
                    </div>
                </div>
                <div class="relative">
                    <div class="absolute inset-0 bg-gradient-to-r from-electric to-hotpink rounded-3xl transform rotate-6 opacity-20"></div>
                    <img src="{{PROFILE_IMAGE}}" alt="{{NAME}}" class="relative rounded-3xl shadow-2xl w-full object-cover h-96 lg:h-[600px]">
                </div>
            </div>
        </div>
    </section>

    <section id="work" class="py-20 bg-white">
        <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div class="text-center mb-16">
                <span class="text-hotpink font-semibold">Portfolio</span>
                <h2 class="font-display text-4xl font-bold mt-2">Selected Works</h2>
            </div>
            <div class="grid md:grid-cols-2 lg:grid-cols-3 gap-8">
                {{PORTFOLIO_ITEMS}}
            </div>
        </div>
    </section>

    <section id="contact" class="py-20 bg-gray-50">
        <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
            <h2 class="font-display text-4xl font-bold mb-6">Let's Work Together</h2>
            <p class="text-gray-600 mb-8">Have a project in mind? I'd love to hear about it.</p>
            <a href="mailto:{{EMAIL}}" class="px-8 py-4 bg-gradient-to-r from-electric to-hotpink text-white rounded-full font-semibold hover:shadow-lg transition">Get In Touch</a>
        </div>
    </section>

    <footer class="bg-gray-900 text-white py-12">
        <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
            <p class="text-gray-400">&copy; 2024 {{NAME}}. All rights reserved.</p>
        </div>
    </footer>
</body>
</html>`;
    }

    getStoreTemplate() {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>{{STORE_NAME}} - {{TAGLINE}}</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <script>
        tailwind.config = {
            theme: {
                extend: {
                    colors: {
                        emerald: '#10B981',
                        orange: '#F97316',
                        sky: '#0EA5E9'
                    }
                }
            }
        }
    </script>
    <style>
        .product-card:hover { transform: translateY(-8px); box-shadow: 0 20px 40px rgba(0,0,0,0.1); }
    </style>
</head>
<body class="font-sans bg-gray-50 text-gray-800">
    <nav class="fixed w-full bg-white shadow-sm z-50">
        <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div class="flex justify-between items-center h-16">
                <a href="/" class="text-2xl font-bold text-emerald">{{STORE_NAME}}</a>
                <div class="flex items-center gap-6">
                    <a href="/admin" class="text-gray-600 hover:text-emerald transition">Admin</a>
                    <button onclick="toggleCart()" class="relative">
                        <i class="fas fa-shopping-cart text-xl text-gray-700"></i>
                        <span id="cartCount" class="absolute -top-2 -right-2 bg-orange text-white text-xs w-5 h-5 rounded-full flex items-center justify-center hidden">0</span>
                    </button>
                </div>
            </div>
        </div>
    </nav>

    <section class="pt-24 pb-12 bg-gradient-to-r from-emerald/10 to-orange/10">
        <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
            <h1 class="text-4xl md:text-5xl font-bold mb-4">{{TAGLINE}}</h1>
            <p class="text-gray-600 text-lg mb-8">{{DESCRIPTION}}</p>
            <a href="#products" class="px-8 py-3 bg-emerald text-white rounded-full font-semibold hover:bg-emerald-600 transition">Shop Now</a>
        </div>
    </section>

    <section id="products" class="py-12">
        <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <h2 class="text-2xl font-bold mb-8">Our Products</h2>
            <div id="productGrid" class="grid md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
                {{PRODUCTS}}
            </div>
        </div>
    </section>

    <div id="cartSidebar" class="fixed inset-y-0 right-0 w-full md:w-96 bg-white shadow-2xl transform translate-x-full transition-transform duration-300 z-50">
        <div class="p-6 h-full flex flex-col">
            <div class="flex justify-between items-center mb-6">
                <h3 class="text-xl font-bold">Your Cart</h3>
                <button onclick="toggleCart()" class="text-gray-500"><i class="fas fa-times text-xl"></i></button>
            </div>
            <div id="cartItems" class="flex-1 overflow-y-auto space-y-4"></div>
            <div class="border-t pt-4 mt-4">
                <div class="flex justify-between mb-4">
                    <span class="font-semibold">Total:</span>
                    <span id="cartTotal" class="text-xl font-bold text-emerald">KES 0</span>
                </div>
                <button onclick="checkout()" class="w-full py-3 bg-emerald text-white rounded-full font-semibold hover:bg-emerald-600 transition">Checkout with M-Pesa</button>
            </div>
        </div>
    </div>

    <footer class="bg-gray-900 text-white py-12">
        <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
            <p>&copy; 2024 {{STORE_NAME}}. All rights reserved.</p>
        </div>
    </footer>

    <script>
        let cart = JSON.parse(localStorage.getItem('cart')) || [];

        function updateCart() {
            const count = cart.reduce((sum, item) => sum + item.qty, 0);
            const badge = document.getElementById('cartCount');
            if (count > 0) { badge.textContent = count; badge.classList.remove('hidden'); }
            else { badge.classList.add('hidden'); }
            renderCart(); localStorage.setItem('cart', JSON.stringify(cart));
        }

        function renderCart() {
            const container = document.getElementById('cartItems');
            if (cart.length === 0) { container.innerHTML = '<p class="text-gray-500 text-center">Your cart is empty</p>'; document.getElementById('cartTotal').textContent = 'KES 0'; return; }
            let total = 0;
            container.innerHTML = cart.map((item, idx) => { total += item.price * item.qty; return '<div class="flex gap-4 bg-gray-50 p-4 rounded-lg"><img src="' + item.image + '" class="w-20 h-20 object-cover rounded"><div class="flex-1"><h4 class="font-semibold">' + item.name + '</h4><p class="text-emerald font-bold">KES ' + item.price.toLocaleString() + '</p><div class="flex items-center gap-2 mt-2"><button onclick="updateQty(' + idx + ', -1)" class="w-6 h-6 bg-gray-200 rounded">-</button><span>' + item.qty + '</span><button onclick="updateQty(' + idx + ', 1)" class="w-6 h-6 bg-gray-200 rounded">+</button></div></div><button onclick="removeItem(' + idx + ')" class="text-red-500"><i class="fas fa-trash"></i></button></div>'; }).join('');
            document.getElementById('cartTotal').textContent = 'KES ' + total.toLocaleString();
        }

        function addToCart(id, name, price, image) { const existing = cart.find(item => item.id === id); if (existing) { existing.qty++; } else { cart.push({ id, name, price, image, qty: 1 }); } updateCart(); toggleCart(); }
        function updateQty(idx, change) { cart[idx].qty += change; if (cart[idx].qty <= 0) cart.splice(idx, 1); updateCart(); }
        function removeItem(idx) { cart.splice(idx, 1); updateCart(); }
        function toggleCart() { document.getElementById('cartSidebar').classList.toggle('translate-x-full'); }

        async function checkout() {
            if (cart.length === 0) { alert('Your cart is empty!'); return; }
            const total = cart.reduce((sum, item) => sum + item.price * item.qty, 0) + 200;
            const phone = prompt('Enter M-Pesa phone number (2547XXXXXXXX):'); if (!phone) return;
            try {
                const response = await fetch('/api/create-order', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Customer', phone, email: 'customer@store.com', item: 'Store Order', price: total, type: 'template' }) });
                const result = await response.json();
                if (result.success) { alert('Payment request sent! Please enter M-Pesa PIN.'); cart = []; updateCart(); toggleCart(); }
                else { alert('Payment failed: ' + result.message); }
            } catch (error) { alert('Network error. Please try again.'); }
        }
        updateCart();
    </script>
</body>
</html>`;
    }

    getAdminTemplate() {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Admin - {{STORE_NAME}}</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css" rel="stylesheet">
</head>
<body class="bg-gray-50">
    <div id="loginScreen" class="fixed inset-0 bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center z-50">
        <div class="bg-white p-8 rounded-2xl shadow-2xl w-full max-w-md mx-4">
            <h1 class="text-2xl font-bold text-center mb-8">Admin Login</h1>
            <form id="loginForm" class="space-y-6">
                <div>
                    <label class="block text-sm font-medium mb-2">Username</label>
                    <input type="text" id="username" value="admin" class="w-full px-4 py-3 border rounded-xl focus:ring-2 focus:ring-emerald outline-none">
                </div>
                <div>
                    <label class="block text-sm font-medium mb-2">Password</label>
                    <input type="password" id="password" placeholder="admin123" class="w-full px-4 py-3 border rounded-xl focus:ring-2 focus:ring-emerald outline-none">
                </div>
                <button type="submit" class="w-full py-3 bg-emerald text-white rounded-xl font-semibold hover:bg-emerald-600 transition">Sign In</button>
            </form>
        </div>
    </div>

    <div id="dashboard" class="hidden">
        <div class="flex h-screen">
            <aside class="w-64 bg-white shadow-lg">
                <div class="p-6 border-b">
                    <h2 class="text-xl font-bold text-emerald">{{STORE_NAME}}</h2>
                </div>
                <nav class="p-4">
                    <button onclick="showSection('products')" class="w-full text-left px-4 py-3 rounded-xl hover:bg-gray-50"><i class="fas fa-box mr-3"></i>Products</button>
                    <button onclick="logout()" class="w-full text-left px-4 py-3 rounded-xl hover:bg-red-50 text-red-600 mt-8"><i class="fas fa-sign-out-alt mr-3"></i>Logout</button>
                </nav>
            </aside>
            <main class="flex-1 p-8">
                <h1 class="text-2xl font-bold mb-6">Products</h1>
                <button onclick="openProductModal()" class="px-4 py-2 bg-emerald text-white rounded-lg mb-4"><i class="fas fa-plus mr-2"></i>Add Product</button>
                <div class="bg-white rounded-2xl shadow overflow-hidden">
                    <table class="w-full">
                        <thead class="bg-gray-50"><tr><th class="text-left p-4">Image</th><th class="text-left p-4">Name</th><th class="text-left p-4">Price</th><th class="text-left p-4">Actions</th></tr></thead>
                        <tbody id="productsTable"></tbody>
                    </table>
                </div>
            </main>
        </div>
    </div>

    <div id="productModal" class="fixed inset-0 bg-black/50 hidden z-50 flex items-center justify-center p-4">
        <div class="bg-white rounded-2xl max-w-lg w-full p-6">
            <h3 class="text-xl font-bold mb-4">Add Product</h3>
            <form id="productForm" class="space-y-4">
                <input type="text" id="productName" placeholder="Product Name" required class="w-full px-4 py-2 border rounded-lg">
                <input type="number" id="productPrice" placeholder="Price (KES)" required class="w-full px-4 py-2 border rounded-lg">
                <input type="url" id="productImage" placeholder="Image URL" required class="w-full px-4 py-2 border rounded-lg">
                <button type="submit" class="w-full py-3 bg-emerald text-white rounded-lg font-semibold">Save Product</button>
            </form>
        </div>
    </div>

    <script>
        let products = JSON.parse(localStorage.getItem('products')) || [];
        if (localStorage.getItem('adminLoggedIn') === 'true') showDashboard();
        document.getElementById('loginForm').addEventListener('submit', function(e) { e.preventDefault(); if (document.getElementById('username').value === 'admin' && document.getElementById('password').value === 'admin123') { localStorage.setItem('adminLoggedIn', 'true'); showDashboard(); } else { alert('Invalid credentials'); } });
        function showDashboard() { document.getElementById('loginScreen').classList.add('hidden'); document.getElementById('dashboard').classList.remove('hidden'); renderProducts(); }
        function logout() { localStorage.removeItem('adminLoggedIn'); location.reload(); }
        function showSection(section) { renderProducts(); }
        function openProductModal() { document.getElementById('productModal').classList.remove('hidden'); }
        document.getElementById('productForm').addEventListener('submit', async function(e) { e.preventDefault(); const product = { id: Date.now().toString(), name: document.getElementById('productName').value, price: parseInt(document.getElementById('productPrice').value), image: document.getElementById('productImage').value }; products.push(product); localStorage.setItem('products', JSON.stringify(products)); try { await fetch('/api/products', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(product) }); } catch (e) { console.log('Server sync failed'); } document.getElementById('productModal').classList.add('hidden'); this.reset(); renderProducts(); alert('Product saved! Changes live in 2-3 minutes.'); });
        function renderProducts() { document.getElementById('productsTable').innerHTML = products.map(p => '<tr class="border-b"><td class="p-4"><img src="' + p.image + '" class="w-12 h-12 object-cover rounded"></td><td class="p-4">' + p.name + '</td><td class="p-4">KES ' + p.price.toLocaleString() + '</td><td class="p-4"><button onclick="deleteProduct(' + p.id + ')" class="text-red-600"><i class="fas fa-trash"></i></button></td></tr>').join(''); }
        function deleteProduct(id) { products = products.filter(p => p.id != id); localStorage.setItem('products', JSON.stringify(products)); renderProducts(); }
    </script>
</body>
</html>`;
    }

    renderTemplate(templateName, data) {
        let template = fs.readFileSync(path.join(this.templatesDir, `${templateName}.html`), 'utf8');
        for (const [key, value] of Object.entries(data)) {
            template = template.replace(new RegExp(`{{${key}}}`, 'g'), value);
        }
        return template;
    }
}

const templateManager = new TemplateManager();

// ==================== DATA STORAGE ====================
const DATA_FILE = path.join(__dirname, 'orders.json');
const PRODUCTS_FILE = path.join(__dirname, 'products.json');

let orders = new Map();
let products = new Map();

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
    } catch (error) {
        console.error('Error loading data:', error);
    }
}

function saveData() {
    try {
        const data = { orders: Object.fromEntries(orders) };
        fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
        fs.writeFileSync(PRODUCTS_FILE, JSON.stringify(Object.fromEntries(products), null, 2));
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
        console.warn('Africa's Talking not configured - SMS will be logged only');
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

// ==================== ROUTES ====================
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        time: new Date().toISOString(),
        orders: orders.size,
        products: products.size,
        uptime: process.uptime(),
        email_configured: !!(WORKSPACE_EMAIL && WORKSPACE_APP_PASSWORD),
        sms_configured: !!(AT_USERNAME && AT_APIKEY),
        render_configured: !!RENDER_API_KEY
    });
});

// Create order
app.post('/api/create-order', createOrderLimiter, async (req, res) => {
    try {
        const { name, email, phone, domain, item, price } = req.body;

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
                // Deploy to Render
                if (RENDER_API_KEY) {
                    let templateType;
                    if (order.item === 'Business Showcase') templateType = 'business-showcase';
                    else if (order.item === 'Professional Portfolio') templateType = 'professional-portfolio';
                    else if (order.item === 'Online Store Pro') templateType = 'online-store-pro';

                    const deployResult = await render.deploySite(order, templateType);
                    if (deployResult.success) {
                        order.deployedUrl = deployResult.url;
                        order.customDomainUrl = deployResult.customDomain;
                        order.renderServiceId = deployResult.serviceId;
                        order.adminUrl = deployResult.adminUrl;
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
                            <p>Password: admin123</p>
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 SiteSawa Server v2.0 running on port ${PORT}`);
    console.log(`📧 Email: ${WORKSPACE_EMAIL ? 'Google Workspace ready' : 'Not configured'}`);
    console.log(`📱 SMS: ${AT_USERNAME ? 'Africa's Talking ready' : 'Not configured'}`);
    console.log(`🚀 Render: ${RENDER_API_KEY ? 'Deployment ready' : 'Not configured'}`);
    console.log(`📦 Templates: ${VALID_ITEMS.join(', ')}`);
    console.log(`💰 Prices: Business/Portfolio KES 6,000 | Store KES 8,000`);
});
