/**
 * sitesawa-connect.js  v4.0  — Smart Hydration Engine
 * ─────────────────────────────────────────────────────────────────────
 * Hydrates any SiteSawa template with zero changes to template HTML.
 * Uses a cascading strategy: semantic HTML → known selectors → 
 * content-pattern scanning → position heuristics.
 *
 * Server injects before </body>:
 *   <script id="ss-data" type="application/json">{...}</script>
 *   <script src="/sitesawa-connect.js" defer></script>
 */
(function () {
  'use strict';

  /* ── 1. Read injected data ─────────────────────────────────────────── */
  const el = document.getElementById('ss-data');
  if (!el) return;
  let C;
  try { C = JSON.parse(el.textContent); } catch (e) { return; }

  const d        = C.data   || {};
  const soc      = C.social || {};
  const name     = d.businessName || d.bizName || d.shopName || C.name || '';
  const tagline  = d.tagline  || d.heroText    || '';
  const about    = d.aboutText || d.bio || d.description || '';
  const phone    = C.phone || '';
  const email    = d.email || C.email || '';
  const loc      = d.location || d.address || '';
  const logo     = d.logo || '';
  const waPhone  = (soc.whatsapp || phone).replace(/^0/, '254').replace(/\D/g, '');
  const year     = new Date().getFullYear();
  const tpl      = C.templateId || '';
  const isShop   = C.template === 'ECOMMERCE';
  const isBiz    = C.template === 'BUSINESS';
  const products = Array.isArray(d.products) ? d.products : [];
  const services = Array.isArray(d.services) ? d.services : [];

  /* ── 2. Utilities ──────────────────────────────────────────────────── */
  function esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;')
      .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
  function $(sel)  { return document.querySelector(sel); }
  function $$(sel) { return Array.from(document.querySelectorAll(sel)); }
  function parsePrice(v) {
    return parseFloat(String(v || '0').replace(/[^0-9.]/g, '')) || 0;
  }
  function fmtKES(v) {
    return 'KES ' + Number(parsePrice(v)).toLocaleString();
  }

  /* ── 3. Smart field-finder: cascading strategy ─────────────────────── */

  /**
   * findBest(strategies) — try each strategy in order, return first match.
   * Each strategy is a CSS selector string or a function returning an element.
   */
  function findBest(strategies) {
    for (const s of strategies) {
      const el = typeof s === 'function' ? s() : $(s);
      if (el) return el;
    }
    return null;
  }

  /**
   * findAll(strategies) — return all matching elements across all strategies.
   */
  function findAll(strategies) {
    const seen = new Set();
    const results = [];
    for (const s of strategies) {
      const els = typeof s === 'function'
        ? (s() ? [s()] : [])
        : $$(s);
      for (const el of els) {
        if (!seen.has(el)) { seen.add(el); results.push(el); }
      }
    }
    return results;
  }

  /**
   * scanText(pattern, replacement) — find any element whose text matches
   * a regex pattern and replace it. Used for content-aware replacement.
   */
  function scanText(pattern, replacement, scope) {
    if (!replacement) return;
    const root = scope || document.body;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let node;
    while ((node = walker.nextNode())) {
      if (pattern.test(node.textContent)) nodes.push(node);
    }
    nodes.forEach(n => {
      n.textContent = n.textContent.replace(pattern, replacement);
    });
  }

  /* ── 4. Page title ──────────────────────────────────────────────────── */
  if (name) document.title = tagline ? name + ' — ' + tagline : name;

  /* ── 5. Business / person name ──────────────────────────────────────── */
  if (name) {
    // Strategy A: known logo/brand selectors (covers all 30 templates)
    const nameEl = findBest([
      '.logo', '.nav-logo', '.nav-brand', '.brand', '.mast-name',
      '.handle', '.logo-name', '.ft-brand-name', '.site-name',
      // Semantic: first branded link in header
      () => {
        const hdr = $('header nav a, header .wrap a');
        if (hdr && hdr.textContent.length < 40 && !hdr.href?.includes('http')) return hdr;
      },
    ]);
    if (nameEl && !nameEl.querySelector('img')) {
      if (nameEl.children.length === 0) {
        nameEl.textContent = name;
      } else if (nameEl.firstChild?.nodeType === 3) {
        nameEl.firstChild.textContent = name.split(' ')[0] + ' ';
      }
    }

    // me-developer: terminal style logo ~/slug.dev
    if ($('.term') || tpl === 'me-developer') {
      const devLogo = $('.logo');
      if (devLogo && !devLogo.querySelector('img')) {
        const slug = name.toLowerCase().replace(/\s+/g, '').replace(/[^a-z0-9]/g, '');
        devLogo.innerHTML = '~/<b>' + esc(slug) + '</b>.dev';
      }
    }

    // me-resume: sidebar h1
    const sideH1 = $('.side h1');
    if (sideH1) sideH1.innerHTML = name.replace(' ', '<br>');

    // me-linkbio: handle
    const handleEl = $('.handle');
    if (handleEl) handleEl.textContent = name;

    // me-wedding: .names split on &
    const weddingEl = $('.names');
    if (weddingEl) {
      // Only split on & if it looks like two names (both parts >= 2 chars)
    const ampParts = name.split(/\s*&\s*/);
    const parts = (ampParts.length === 2 && ampParts[0].trim().length >= 2 && ampParts[1].trim().length >= 2) ? ampParts : [name];
      const n1 = parts[0]?.trim() || name;
      const n2 = parts[1]?.trim() || '';
      weddingEl.innerHTML = n2
        ? n1 + '<span class="amp script">&amp;</span>' + n2
        : n1;
    }

    // Logo image
    if (logo) {
      $$('.logo img, .logo-img img, .nav-logo img, img.logo').forEach(img => {
        img.src = logo; img.alt = name;
      });
    }

    // Avatar initials (me-resume, me-linkbio)
    $$('.avatar, .av, .side .avatar').forEach(av => {
      if (!av.querySelector('img')) {
        av.textContent = name.trim() ? name.trim()[0].toUpperCase() : '?';
      }
    });
  }

  /* ── 6. Tagline / hero text ─────────────────────────────────────────── */
  if (tagline) {
    // Strategy: find the first paragraph-level element in hero/header
    // that's short enough to be a tagline (not body copy)
    const taglineEl = findBest([
      '.lede', '.hero-sub', '.hero-sub p', '.tagline', '.hero-tagline',
      '.hero-desc', '.hero-c p', '.hero-row p', '.hero-left > p',
      'header > .wrap > p', 'section.hero > p',
      () => {
        // First p in header/hero that's under 250 chars
        const candidates = $$('header p, .hero p, section.hero p, .hero-left p');
        return candidates.find(p => p.textContent.length < 250);
      },
    ]);
    if (taglineEl) taglineEl.textContent = tagline;

    // me-linkbio: .bio
    const bioEl = $('.bio');
    if (bioEl) bioEl.textContent = tagline;
  }

  /* ── 7. About text ──────────────────────────────────────────────────── */
  if (about) {
    const aboutEl = findBest([
      '.dropcap', '.about-text', '.about-inner p', '#about > p',
      '.about p', '.left-sub', '.hero-body', '.about-body',
      '.side > p',
      () => {
        // First p in #about or .about section under 600 chars
        const candidates = $$('#about p, .about p, section.about p');
        return candidates.find(p => p.textContent.length < 600);
      },
    ]);
    if (aboutEl && aboutEl.textContent.length < 600) aboutEl.textContent = about;
  }

  /* ── 8. Phone ───────────────────────────────────────────────────────── */
  if (phone) {
    // tel: links — most reliable
    $$('a[href^="tel:"]').forEach(a => {
      a.href = 'tel:' + phone;
      if (a.textContent.match(/^[\d\s+\-()\[\]]{7,}$/)) a.textContent = phone;
    });

    // Strategy: scan all text nodes for phone-like patterns and replace
    // Only in footer/contact sections to avoid false positives
    $$('footer, #contact, .contact, .footer').forEach(section => {
      scanText(/(\+254|0)[0-9][\d\s\-]{7,11}/, phone, section);
    });

    // Specific: .side .contact spans (me-resume)
    $$('.side .contact span').forEach(el => {
      if (el.textContent.match(/^[\+\d\s\-]{7,15}$/) && el.children.length === 0) {
        el.textContent = phone;
      }
    });
  }

  /* ── 9. Email ───────────────────────────────────────────────────────── */
  if (email) {
    // mailto: links
    $$('a[href^="mailto:"]').forEach(a => {
      a.href = 'mailto:' + email;
      if (a.textContent.includes('@') && a.textContent.length < 60) a.textContent = email;
    });

    // Scan text nodes for @-containing strings in footer/contact
    const emailPattern = /[\w.+-]+@[\w-]+\.[a-z]{2,}/gi;
    $$('footer, #contact, .contact, .footer, .soc').forEach(section => {
      scanText(emailPattern, email, section);
    });

    // Make plain text emails into mailto links
    $$('footer span, .ft-in span, .contact span, .soc a').forEach(el => {
      const t = el.textContent.trim();
      if (t.includes('@') && !t.includes(' ') && t.length < 80) {
        el.textContent = email;
        if (el.tagName === 'A') el.href = 'mailto:' + email;
      }
    });
  }

  /* ── 10. WhatsApp ───────────────────────────────────────────────────── */
  if (waPhone) {
    const waMsg = encodeURIComponent('Hello ' + name + ', I found you on SiteSawa.');
    const waUrl = 'https://wa.me/' + waPhone + '?text=' + waMsg;

    $$('a[href*="wa.me"], a[href*="whatsapp"]').forEach(a => a.href = waUrl);

    // Icon-based WA links (Font Awesome)
    $$('a').forEach(a => {
      if (a.querySelector('.fa-whatsapp, i[class*="whatsapp"]')) a.href = waUrl;
    });

    // me-linkbio: contact/whatsapp text links
    $$('.lnk').forEach(a => {
      const t = a.textContent.toLowerCase();
      if (t.includes('whatsapp') || t.includes('contact') || t.includes('message')) {
        a.href = waUrl;
      }
    });

    // BIZ CTA buttons — wire to WhatsApp
    $$('.cta a, .hero-cta a, nav a[href="#contact"], nav a[href="#book"], a[href="#contact"], a[href="#book"]').forEach(a => {
      const t = a.textContent.toLowerCase();
      if (t.includes('contact') || t.includes('book') || t.includes('start') ||
          t.includes('quote') || t.includes('get') || t.includes('enquire') ||
          a.getAttribute('href') === '#' || a.getAttribute('href') === '#contact' ||
          a.getAttribute('href') === '#book') {
        a.href = waUrl;
      }
    });
  }

  /* ── 11. Location ───────────────────────────────────────────────────── */
  if (loc) {
    // Known location selectors
    findAll([
      '.place', '.location', '.address', '.loc', '.hero-tag',
      '.c-com',   // me-developer comment line
      '.mast-date', // me-writer masthead
    ]).forEach(el => {
      if (el.textContent.length < 100 && el.children.length === 0) {
        el.textContent = el.textContent.replace(/Nairobi[^·\n,]*/i, loc) || loc;
      }
    });

    // me-travel: .pill "Currently in:"
    const pill = $('.pill');
    if (pill && pill.textContent.includes('in')) {
      pill.innerHTML = '<span class="d"></span>Based in: ' + esc(loc);
    }

    // me-wedding: .place
    const placeEl = $('.place');
    if (placeEl) placeEl.textContent = loc;

    // Scan footer text nodes for city/location patterns
    $$('footer span, .ft-in span').forEach(el => {
      if (el.children.length === 0 && !el.textContent.includes('@') &&
          !el.textContent.match(/^[\d\s+\-]{7,}$/) &&
          (el.textContent.includes('Nairobi') || el.textContent.includes('Road') ||
           el.textContent.includes('Karen') || el.textContent.includes('Kilimani'))) {
        el.textContent = el.textContent.replace(/[A-Za-z][^·,\n]{3,}(Nairobi|Road|Karen|Estate)[^·,\n]*/i, loc);
      }
    });
  }

  /* ── 12. Social links ───────────────────────────────────────────────── */
  const socialMap = {
    instagram:  soc.instagram,
    facebook:   soc.facebook,
    twitter:    soc.twitter || soc.x,
    linkedin:   soc.linkedin,
    tiktok:     soc.tiktok,
    youtube:    soc.youtube,
    soundcloud: soc.soundcloud,
    spotify:    soc.spotify,
  };

  Object.entries(socialMap).forEach(([platform, url]) => {
    if (url) {
      // Customer HAS this account → point existing icons/links to it
      // href-based
      $$(`a[href*="${platform}"]`).forEach(a => a.href = url);
      // Font Awesome icon parent links
      $$(`a .fa-${platform}, a i[class*="${platform}"]`).forEach(icon => {
        const a = icon.closest('a');
        if (a) a.href = url;
      });
      // Text label links
      $$('.soc a, footer a, .socials a, .social-links a').forEach(a => {
        if (a.textContent.toLowerCase().trim() === platform) a.href = url;
      });
    } else {
      // Customer does NOT have this account → hide the icon so it never
      // shows as an empty/dead link. Only their real accounts appear.
      // Icon-based links (Font Awesome etc.)
      $$(`a .fa-${platform}, a i[class*="${platform}"]`).forEach(icon => {
        const a = icon.closest('a');
        if (a) a.style.display = 'none';
      });
      // href-based links pointing at the platform's domain
      $$(`a[href*="${platform}.com"], a[href*="${platform}"]`).forEach(a => {
        // only hide if it's clearly a social link (icon inside or matching label)
        const t = a.textContent.toLowerCase().trim();
        if (a.querySelector('i,svg,img') || t === platform) a.style.display = 'none';
      });
      // Text label links in known social containers
      $$('.soc a, .socials a, .social-links a, .ft-soc a').forEach(a => {
        if (a.textContent.toLowerCase().trim() === platform) a.style.display = 'none';
      });
    }
  });

  // me-linkbio: icon button order instagram/youtube/spotify/twitter
  const linkSocials = $$('.socials a');
  if (linkSocials.length) {
    const order = [soc.instagram, soc.youtube || soc.tiktok, soc.spotify || soc.soundcloud, soc.twitter];
    linkSocials.forEach((a, i) => { if (order[i]) a.href = order[i]; });
  }

  /* ── 13. Footer copyright ────────────────────────────────────────────── */
  $$('footer, footer span, .ft-c, footer p, .footer-copy').forEach(el => {
    if (el.children.length === 0 && name) {
      const t = el.textContent.trim();
      if (t.includes('©') || t.match(/^20\d\d/)) {
        el.textContent = '© ' + year + ' ' + name + (loc ? ' · ' + loc : '');
      }
    }
  });


  /* ── 14b. New BIZ template overrides ────────────────────────────────── */

  // biz-politician: name in logo badge + text
  const polLogo = $('div.logo');
  if (polLogo && name && polLogo.querySelector('.m')) {
    const parts = name.trim().split(' ');
    const first = parts[0] || name;
    const rest  = parts.slice(1).join(' ');
    const badge = polLogo.querySelector('.m');
    if (badge && badge.textContent.match(/^[A-Z]{1,3}$/)) {
      badge.textContent = (first[0] + (rest[0] || '')).toUpperCase();
    }
    const nameSpan = polLogo.querySelector('span:not(.m)');
    const textNode = Array.from(polLogo.childNodes).find(n => n.nodeType === 3 && n.textContent.trim());
    if (textNode) textNode.textContent = first + ' ';
    if (nameSpan) nameSpan.textContent = rest;
    // Footer logo
    $$('footer .logo').forEach(el => {
      const b = el.querySelector('.m');
      if (b) b.textContent = name.split(' ').map(w => w[0]).slice(0,2).join('').toUpperCase();
      const ns = el.querySelector('span:not(.m)');
      const tn = Array.from(el.childNodes).find(n => n.nodeType === 3 && n.textContent.trim());
      if (tn) tn.textContent = first + ' ';
      if (ns) ns.textContent = rest;
    });
  }

  // biz-salon: .pre tagline + .ft-c footer text
  const preEl = $('.pre');
  if (preEl && loc) preEl.textContent = preEl.textContent.replace(/Nairobi/i, loc);
  const ftc = $('.ft-c');
  if (ftc) {
    if (loc)   ftc.textContent = ftc.textContent.replace(/Westlands,?\s*Nairobi/i, loc);
    if (phone) ftc.textContent = ftc.textContent.replace(/\+254[\d\s]{9,12}/, phone);
  }

  // biz-logistics: footer .mono span
  $$('footer .mono, footer span.mono').forEach(el => {
    let t = el.textContent;
    if (email && t.includes('@'))   t = t.replace(/[\w.-]+@[\w.-]+\.\w{2,}/g, email);
    if (phone && t.match(/[\d]/))  t = t.replace(/0\d{3}\s?\d{3}\s?\d{3}/, phone);
    el.textContent = t;
  });

  // .ft-soc social text links (politician, salon)
  $$('.ft-soc a').forEach(a => {
    const t = a.textContent.toLowerCase().trim();
    if (t === 'facebook'               && soc.facebook)          a.href = soc.facebook;
    if ((t === 'x' || t === 'twitter') && (soc.twitter||soc.x)) a.href = soc.twitter || soc.x;
    if (t === 'instagram'              && soc.instagram)         a.href = soc.instagram;
    if (t === 'tiktok'                 && soc.tiktok)            a.href = soc.tiktok;
    if (t === 'whatsapp' && waPhone) {
      a.href = 'https://wa.me/' + waPhone + '?text=' + encodeURIComponent('Hello ' + name);
    }
  });

  // Wire .cta-contact links to WhatsApp
  if (waPhone) {
    const waMsg = encodeURIComponent('Hello ' + name + ', I found you on SiteSawa.');
    $$('.cta-contact').forEach(a => { a.href = 'https://wa.me/' + waPhone + '?text=' + waMsg; });
  }

  /* ── 14. Remove demo ribbon ──────────────────────────────────────────── */
  $$('.ribbon, .brand-ribbon').forEach(el => el.remove());

  /* ── 15. Analytics ──────────────────────────────────────────────────── */
  if (C.googleAnalyticsId) injectGA(C.googleAnalyticsId);
  if (C.tiktokPixelId)     injectTT(C.tiktokPixelId);

  /* ── 16. ECOMMERCE: products ─────────────────────────────────────────── */
  if (isShop && products.length) hydrateProducts();

  /* ── 17. BUSINESS: services ──────────────────────────────────────────── */
  if (isBiz && services.length) hydrateServices();

  /* ════════════════════════════════════════════════════════════════════════
     PRODUCT HYDRATION + CART
  ════════════════════════════════════════════════════════════════════════ */
  let cartItems = [];

  function hydrateProducts() {
    const grid = document.getElementById('grid')
      || $('section#shop .grid, #shop .grid, .prod-grid, #products .grid, .grid');
    if (!grid) return;

    const hasDish    = !!grid.querySelector('.dish');
    const hasFashion = !!grid.querySelector('.prod-name, .prod-add');
    const hasBook    = !!grid.querySelector('.book, .book-cover');

    grid.innerHTML = products.map((p, i) => {
      if (hasDish)    return foodCard(p, i);
      if (hasBook)    return bookCard(p, i);
      if (hasFashion) return fashionCard(p, i);
      return genericCard(p, i);
    }).join('');

    wireAddToCart(grid);
    buildCheckoutPanel();
  }

  function fashionCard(p, i) {
    const img = p.image || 'https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=700&q=80';
    const pid = String(p.id || i); const price = parsePrice(p.price); const oos = p.stock === 0;
    return `<div class="prod"><div class="prod-img"><img src="${esc(img)}" alt="${esc(p.name)}" loading="lazy">
      ${!oos ? `<div class="add prod-add" data-id="${esc(pid)}" data-name="${esc(p.name)}" data-price="${price}">+ Add to bag</div>`
             : `<div class="prod-add" style="opacity:.5;pointer-events:none">Out of stock</div>`}
      </div><div class="prod-name">${esc(p.name)}</div>
      ${p.description ? `<div class="prod-cat">${esc(p.description)}</div>` : ''}
      <div class="prod-price">${fmtKES(p.price)}</div></div>`;
  }

  function foodCard(p, i) {
    const img = p.image || 'https://images.unsplash.com/photo-1565958011703-44f9829ba187?w=700&q=80';
    const pid = String(p.id || i); const price = parsePrice(p.price); const oos = p.stock === 0;
    return `<div class="dish reveal"><div class="dish-img"><img src="${esc(img)}" alt="${esc(p.name)}" loading="lazy"></div>
      <div class="dish-b"><h3>${esc(p.name)}</h3>
      ${p.description ? `<div class="rest">${esc(p.description)}</div>` : ''}
      <div class="dish-foot"><span class="price">${fmtKES(p.price)}</span>
      ${!oos ? `<button class="add" data-id="${esc(pid)}" data-name="${esc(p.name)}" data-price="${price}">+</button>`
             : `<button disabled style="opacity:.4">Sold out</button>`}
      </div></div></div>`;
  }

  function bookCard(p, i) {
    const COLORS = ['linear-gradient(160deg,#a4502f,#7c3a20)','linear-gradient(160deg,#3c5743,#2a3f31)',
                    'linear-gradient(160deg,#2b3a55,#1e2b40)','linear-gradient(160deg,#6b2f44,#4d2030)',
                    'linear-gradient(160deg,#7a5a2e,#5c4220)','linear-gradient(160deg,#34504f,#243a39)'];
    const bg = COLORS[i % COLORS.length];
    const pid = String(p.id || i); const price = parsePrice(p.price); const oos = p.stock === 0;
    return `<div class="book reveal"><div class="book-cover" style="background:${bg}">
      <div><div class="bt sp">${esc(p.name)}</div>${p.description ? `<div class="ba">${esc(p.description)}</div>` : ''}</div>
      ${!oos ? `<button class="add" data-id="${esc(pid)}" data-name="${esc(p.name)}" data-price="${price}">Add to cart</button>`
             : `<button disabled style="opacity:.4">Out of stock</button>`}
      </div><div class="meta"><div><h3 class="sp">${esc(p.name)}</h3>
      ${p.description ? `<div class="auth">${esc(p.description)}</div>` : ''}</div>
      <span class="price">${price.toLocaleString()}</span></div></div>`;
  }

  function genericCard(p, i) {
    const img = p.image || 'https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=600&q=80';
    const pid = String(p.id || i); const price = parsePrice(p.price); const oos = p.stock === 0;
    return `<div class="prod reveal"><div class="prod-img">
      ${oos ? '<span class="badge" style="background:#ff4d4d">Sold out</span>' : ''}
      <img src="${esc(img)}" alt="${esc(p.name)}" loading="lazy">
      ${!oos ? `<button class="add" data-id="${esc(pid)}" data-name="${esc(p.name)}" data-price="${price}">Add to bag</button>` : ''}
      </div><div class="prod-b"><h3>${esc(p.name)}</h3>
      ${p.description ? `<p style="font-size:13px;color:var(--mut,#888);margin-bottom:8px">${esc(p.description)}</p>` : ''}
      <div class="prod-foot"><div class="price">${fmtKES(p.price)}</div>
      ${!oos ? `<button class="add" data-id="${esc(pid)}" data-name="${esc(p.name)}" data-price="${price}">Add</button>`
             : `<button disabled style="opacity:.4">Sold out</button>`}
      </div></div></div>`;
  }

  function wireAddToCart(grid) {
    if (grid._ssWired) return;
    grid._ssWired = true;
    grid.addEventListener('click', e => {
      const btn = e.target.closest('.add, .prod-add, [data-price]');
      if (!btn || btn.disabled || btn.style.pointerEvents === 'none') return;
      e.stopPropagation();
      const id    = btn.dataset.id   || btn.dataset.n || String(Math.random());
      const pname = btn.dataset.name || btn.dataset.n || btn.textContent.trim() || 'Item';
      const price = parsePrice(btn.dataset.price);
      const existing = cartItems.find(i => i.id === id);
      if (existing) existing.qty++;
      else cartItems.push({ id, name: pname, price, qty: 1 });
      updateCartBadge();
      showCheckoutPanel();
      toast(pname + ' added to cart');
    });
  }

  function updateCartBadge() {
    const count = cartItems.reduce((s, i) => s + i.qty, 0);
    $$('#cc, .cart-count, [id*="cc"]').forEach(el => {
      if (/^\d+$/.test(el.textContent.trim())) el.textContent = count;
    });
  }

  function buildCheckoutPanel() {
    if (document.getElementById('ss-checkout')) return;
    const panel = document.createElement('div');
    panel.id = 'ss-checkout';
    panel.innerHTML = `<style>
      #ss-checkout{position:fixed;bottom:0;right:0;width:340px;max-height:90vh;overflow-y:auto;
        background:#fff;border-radius:18px 18px 0 0;box-shadow:0 -8px 40px rgba(0,0,0,.18);
        z-index:99999;padding:20px;font-family:inherit;display:none;border-top:3px solid #16a34a}
      #ss-checkout h4{font-size:15px;font-weight:700;margin-bottom:14px;display:flex;justify-content:space-between;align-items:center}
      #ss-cart-items{margin-bottom:12px;max-height:180px;overflow-y:auto}
      .ss-item{display:flex;justify-content:space-between;font-size:13px;padding:6px 0;border-bottom:1px solid #f0f0f0}
      .ss-item button{background:none;border:none;cursor:pointer;color:#aaa;font-size:15px;padding:0 4px}
      #ss-cart-total-row{font-weight:700;font-size:14px;display:flex;justify-content:space-between;padding:10px 0;border-top:1px solid #eee;margin-bottom:12px}
      #ss-checkout input{width:100%;padding:10px 12px;border:1px solid #ddd;border-radius:8px;margin-bottom:8px;font-size:14px;font-family:inherit;box-sizing:border-box}
      #ss-checkout input:focus{outline:none;border-color:#16a34a}
      #ss-pay{width:100%;padding:13px;border-radius:10px;border:none;background:#16a34a;color:#fff;font-weight:700;font-size:15px;cursor:pointer;font-family:inherit}
      #ss-pay:disabled{opacity:.5;cursor:not-allowed}
      #ss-msg{font-size:12px;text-align:center;margin-top:8px;min-height:16px}
      #ss-checkout-close{background:none;border:none;cursor:pointer;color:#aaa;font-size:20px;position:absolute;top:10px;right:12px}
    </style>
    <h4>🛒 Your cart <button id="ss-checkout-close">×</button></h4>
    <div id="ss-cart-items"></div>
    <div id="ss-cart-total-row"><span>Total</span><span id="ss-cart-total">KES 0</span></div>
    <input id="ss-buyer-name"  placeholder="Your name" autocomplete="name">
    <input id="ss-buyer-phone" placeholder="M-Pesa number (07XX XXX XXX)" autocomplete="tel">
    <button id="ss-pay">Pay with M-Pesa →</button>
    <div id="ss-msg"></div>`;
    document.body.appendChild(panel);
    document.getElementById('ss-checkout-close').onclick = hideCheckoutPanel;
    document.getElementById('ss-pay').onclick = doCheckout;
  }

  function showCheckoutPanel() { buildCheckoutPanel(); renderCartItems(); document.getElementById('ss-checkout').style.display = 'block'; }
  function hideCheckoutPanel() { const p = document.getElementById('ss-checkout'); if (p) p.style.display = 'none'; }

  function renderCartItems() {
    const itemsEl = document.getElementById('ss-cart-items');
    const totalEl = document.getElementById('ss-cart-total');
    if (!itemsEl) return;
    if (!cartItems.length) {
      itemsEl.innerHTML = '<p style="color:#aaa;font-size:13px;text-align:center;padding:10px 0">Cart is empty</p>';
      if (totalEl) totalEl.textContent = 'KES 0'; return;
    }
    itemsEl.innerHTML = cartItems.map(i =>
      `<div class="ss-item"><span>${esc(i.name)} × ${i.qty}</span>
       <span>KES ${(i.price * i.qty).toLocaleString()} <button onclick="ssRemoveItem('${esc(i.id)}')">×</button></span></div>`
    ).join('');
    const total = cartItems.reduce((s, i) => s + i.price * i.qty, 0);
    if (totalEl) totalEl.textContent = 'KES ' + total.toLocaleString();
  }

  window.SiteSawa = window.SiteSawa || {};
  window.SiteSawa.removeItem = window.ssRemoveItem = function(id) {
    cartItems = cartItems.filter(i => i.id !== id);
    updateCartBadge(); renderCartItems();
    if (!cartItems.length) hideCheckoutPanel();
  };

  async function doCheckout() {
    const nameVal  = document.getElementById('ss-buyer-name')?.value.trim();
    const phoneVal = document.getElementById('ss-buyer-phone')?.value.trim();
    const msgEl    = document.getElementById('ss-msg');
    const btn      = document.getElementById('ss-pay');
    if (!nameVal)  { setMsg(msgEl, 'Please enter your name', 'red'); return; }
    if (!phoneVal) { setMsg(msgEl, 'Please enter your M-Pesa number', 'red'); return; }
    if (!cartItems.length) { setMsg(msgEl, 'Your cart is empty', 'red'); return; }
    btn.disabled = true; btn.textContent = 'Processing…'; setMsg(msgEl, '', '');
    try {
      const res = await fetch('/api/create-order', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customerId:    C._id,
          customerPhone: phoneVal.startsWith('0') ? '254' + phoneVal.slice(1) : phoneVal,
          customerName:  nameVal,
          items: cartItems.map(i => ({ id: i.id, name: i.name, price: i.price, quantity: i.qty })),
          shipping: 'pickup', paymentMethod: 'mpesa_simple',
        }),
      });
      const data = await res.json().catch(() => ({ error: 'Server error — please try again' }));
      if (res.ok && data.orderId) {
        const total = cartItems.reduce((s, i) => s + i.price * i.qty, 0);
        btn.textContent = '✅ Order placed!';
        setMsg(msgEl, 'Pay KES ' + total.toLocaleString() + ' via M-Pesa to ' + (phone || 'the number on this page') +
          '. Ref: ' + String(data.orderId).slice(-6).toUpperCase(), '#16a34a');
        cartItems = []; updateCartBadge(); renderCartItems();
      } else {
        setMsg(msgEl, data.error || 'Something went wrong. Try again.', 'red');
        btn.disabled = false; btn.textContent = 'Pay with M-Pesa →';
      }
    } catch (err) {
      setMsg(msgEl, 'Network error. Check your connection.', 'red');
      btn.disabled = false; btn.textContent = 'Pay with M-Pesa →';
    }
  }

  /* ── Services (BIZ) ────────────────────────────────────────────────── */
  function hydrateServices() {
    $$('.svc, .services, #services .svc, .svc-list').forEach(grid => {
      const cards = grid.querySelectorAll('.s, .scard, .service-card');
      if (!cards.length) return;
      const tpl = cards[0].cloneNode(true);
      Array.from(cards).forEach(c => c.remove());
      services.forEach(svc => {
        const card = tpl.cloneNode(true);
        const h = card.querySelector('h3, b, .title, strong');
        const p = card.querySelector('p, .desc, .description');
        const ic = card.querySelector('.ic, .icon, .e');
        if (h) h.textContent = svc.name || svc.title || '';
        if (p) p.textContent = svc.description || svc.desc || '';
        if (ic && svc.icon) ic.textContent = svc.icon;
        grid.appendChild(card);
      });
    });
  }

  /* ── Analytics ─────────────────────────────────────────────────────── */
  function injectGA(id) {
    if (!id || id.length < 4) return;
    const s1 = document.createElement('script');
    s1.async = true; s1.src = 'https://www.googletagmanager.com/gtag/js?id=' + id;
    document.head.appendChild(s1);
    const s2 = document.createElement('script');
    s2.textContent = 'window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag("js",new Date());gtag("config","' + id + '");';
    document.head.appendChild(s2);
  }
  function injectTT(id) {
    if (!id || id.length < 4) return;
    const s = document.createElement('script');
    s.textContent = `!function(w,d,t){w.TiktokAnalyticsObject=t;var ttq=w[t]=w[t]||[];ttq.methods=["page","track","identify","instances","debug","on","off","once","ready","alias","group","enableCookie","disableCookie"],ttq.setAndDefer=function(t,e){t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}};for(var i=0;i<ttq.methods.length;i++)ttq.setAndDefer(ttq,ttq.methods[i]);ttq.instance=function(t){for(var e=ttq._i[t]||[],n=0;n<ttq.methods.length;n++)ttq.setAndDefer(e,ttq.methods[n]);return e},ttq.load=function(e,n){var i="https://analytics.tiktok.com/i18n/pixel/events.js";ttq._i=ttq._i||{},ttq._i[e]=[],ttq._i[e]._u=i,ttq._t=ttq._t||{},ttq._t[e]=+new Date,ttq._o=ttq._o||{},ttq._o[e]=n||{};var o=document.createElement("script");o.type="text/javascript",o.async=!0,o.src=i+"?sdkid="+e+"&lib="+t;var a=document.getElementsByTagName("script")[0];a.parentNode.insertBefore(o,a)};ttq.load("${id}");ttq.page();}(window,document,"ttq");`;
    document.head.appendChild(s);
  }

  /* ── Utils ──────────────────────────────────────────────────────────── */
  function toast(msg) {
    let t = document.getElementById('ss-toast');
    if (!t) {
      t = document.createElement('div'); t.id = 'ss-toast';
      t.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:#111;color:#fff;padding:10px 22px;border-radius:99px;font-size:13px;z-index:99998;opacity:0;transition:opacity .3s;pointer-events:none;white-space:nowrap';
      document.body.appendChild(t);
    }
    t.textContent = msg; t.style.opacity = '1';
    clearTimeout(t._t); t._t = setTimeout(() => { t.style.opacity = '0'; }, 2200);
  }
  function setMsg(el, msg, color) {
    if (!el) return; el.textContent = msg; el.style.color = color || '#888';
  }

})();
