require('dotenv').config();

const express      = require('express');
const { Pool }     = require('pg');
const multer       = require('multer');
const cloudinary   = require('cloudinary').v2;
const cookieParser = require('cookie-parser');
const crypto       = require('crypto');
const path         = require('path');
const fs           = require('fs');
const nodemailer   = require('nodemailer');
const PDFDocument  = require('pdfkit');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Paths ───────────────────────────────────────────────────────────────
const FRONTEND_DIR = path.join(__dirname, '..', 'frontend');
const BACKEND_DIR  = __dirname;

// ─── Resolve admin HTML files from either backend/ or frontend/ ─────────
function resolveAdminFile(filename) {
  const backendPath = path.join(BACKEND_DIR, filename);
  if (fs.existsSync(backendPath)) return backendPath;
  const frontendPath = path.join(FRONTEND_DIR, filename);
  if (fs.existsSync(frontendPath)) return frontendPath;
  return null;
}

// ─── PostgreSQL ──────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: false }
    : false
});

// ─── Cloudinary ──────────────────────────────────────────────────────────
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// ─── Multer ──────────────────────────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files are allowed'));
  }
});

// ─── Email Transport ─────────────────────────────────────────────────────
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_APP_PASSWORD
  }
});

transporter.verify((err) => {
  if (err) console.error('❌ Email transport failed:', err.message);
  else console.log('✅ Email transport ready');
});

// ─── Helpers ─────────────────────────────────────────────────────────────
function emailWrapper(title, bodyHtml) {
  return `
    <div style="font-family:Georgia,serif;max-width:600px;margin:0 auto;background:#0a0a0a;color:#f0ede8;padding:2rem;border-radius:8px;">
      <h1 style="color:#c9a227;font-size:1.5rem;letter-spacing:2px;text-transform:uppercase;margin:0 0 1.5rem;">Ink &amp; Iron</h1>
      <h2 style="color:#f0ede8;font-size:1.3rem;margin:0 0 1rem;">${title}</h2>
      ${bodyHtml}
      <hr style="border:none;border-top:1px solid #242424;margin:2rem 0;">
      <p style="color:#6a6a6a;font-size:0.8rem;margin:0;">
        Ink &amp; Iron Tattoo Parlor · hello@inkandiron.example
      </p>
    </div>
  `;
}

function escapeEmail(s) {
  return String(s || '').replace(/[<>&"]/g, c =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
}

function methodLabel(m) {
  const map = {
    paypal:  'PayPal',
    venmo:   'Venmo',
    zelle:   'Zelle',
    cashapp: 'Cash App',
    btc:     'Bitcoin',
    bank:    'Bank Transfer'
  };
  return map[(m || '').toLowerCase()] || (m || 'Unknown');
}

// ═════════════════════════════════════════════════════════════════════════
//  ADMIN AUTH — defined before any route that uses it
// ═════════════════════════════════════════════════════════════════════════
function requireAdmin(req, res, next) {
  const token = req.cookies.admin_session;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  const [sig, payload] = token.split('.');
  if (!sig || !payload) return res.status(401).json({ error: 'Unauthorized' });

  const expected = crypto
    .createHmac('sha256', process.env.COOKIE_SECRET)
    .update(payload)
    .digest('hex');

  if (sig !== expected) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const data = JSON.parse(Buffer.from(payload, 'base64').toString());
    if (data.exp < Date.now()) {
      return res.status(401).json({ error: 'Session expired' });
    }
  } catch {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  next();
}

// ─── Middleware ──────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// ═════════════════════════════════════════════════════════════════════════
//  ADMIN PAGE ROUTES — must be BEFORE express.static
// ═════════════════════════════════════════════════════════════════════════
app.get('/admin-panel.html', requireAdmin, (req, res) => {
  const filePath = resolveAdminFile('admin-panel.html');
  if (!filePath) {
    return res.status(500).json({
      error: 'admin-panel.html not found in backend/ or frontend/'
    });
  }
  res.sendFile(filePath);
});

app.get('/admin-payment-settings.html', requireAdmin, (req, res) => {
  const filePath = resolveAdminFile('admin-payment-settings.html');
  if (!filePath) {
    return res.status(500).json({
      error: 'admin-payment-settings.html not found in backend/ or frontend/'
    });
  }
  res.sendFile(filePath);
});

// ─── Static files (everything else) ──────────────────────────────────────
app.use(express.static(FRONTEND_DIR));

// ═════════════════════════════════════════════════════════════════════════
//  DATABASE INIT
// ═════════════════════════════════════════════════════════════════════════
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS photos (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      cloudinary_url TEXT NOT NULL,
      cloudinary_public_id TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS bookings (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT,
      preferred_date DATE,
      description TEXT,
      status TEXT DEFAULT 'pending_payment',
      payment_method TEXT,
      payment_amount NUMERIC(10,2),
      receipt_url TEXT,
      receipt_public_id TEXT,
      receipt_uploaded_at TIMESTAMP,
      approved_at TIMESTAMP,
      rejection_reason TEXT,
      reference_code TEXT UNIQUE,
      receipt_number TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );

    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS payment_method TEXT;
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS payment_amount NUMERIC(10,2);
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS receipt_url TEXT;
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS receipt_public_id TEXT;
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS receipt_uploaded_at TIMESTAMP;
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS approved_at TIMESTAMP;
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS rejection_reason TEXT;
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS reference_code TEXT;
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS receipt_number TEXT;

    CREATE INDEX IF NOT EXISTS idx_bookings_reference ON bookings (reference_code);
    CREATE INDEX IF NOT EXISTS idx_bookings_email ON bookings (LOWER(email));

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TIMESTAMP DEFAULT NOW()
    );

    INSERT INTO settings (key, value) VALUES
      ('deposit_amount', '50'),
      ('payment_paypal_enabled', 'true'),
      ('payment_paypal_handle', 'yourpaypal@email.com'),
      ('payment_paypal_note', 'Send via PayPal. Include your reference code in the note.'),
      ('payment_venmo_enabled', 'true'),
      ('payment_venmo_handle', '@YourVenmoHandle'),
      ('payment_venmo_note', 'Open Venmo, tap Pay, and send to the handle above.'),
      ('payment_zelle_enabled', 'true'),
      ('payment_zelle_handle', 'yourstudio@email.com'),
      ('payment_zelle_note', 'Send via your bank app''s Zelle feature.'),
      ('payment_cashapp_enabled', 'false'),
      ('payment_cashapp_handle', '$YourCashtag'),
      ('payment_cashapp_note', 'Send via Cash App to the cashtag above.'),
      ('payment_btc_enabled', 'false'),
      ('payment_btc_handle', 'bc1q...yourwalletaddress'),
      ('payment_btc_note', 'Send only BTC to this address.'),
      ('payment_bank_enabled', 'false'),
      ('payment_bank_handle', 'Bank: Your Bank Name\nAccount Name: Your Studio LLC\nAccount #: 0000000000\nRouting #: 000000000'),
      ('payment_bank_note', 'Include your reference code as the payment reference.')
    ON CONFLICT (key) DO NOTHING;
  `);
  console.log('✅ Database tables ready');
}

// ─── Reference Code Generator ────────────────────────────────────────────
function generateReferenceCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 5; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return `INK-${new Date().getFullYear()}-${code}`;
}

async function generateUniqueReference() {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateReferenceCode();
    const existing = await pool.query(
      'SELECT 1 FROM bookings WHERE reference_code = $1', [code]);
    if (existing.rows.length === 0) return code;
  }
  throw new Error('Could not generate unique reference code');
}

// ═════════════════════════════════════════════════════════════════════════
//  PUBLIC API
// ═════════════════════════════════════════════════════════════════════════
app.get('/api/photos', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, title, description, cloudinary_url
       FROM photos ORDER BY created_at DESC`);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch photos' });
  }
});

app.get('/api/payment-methods', async (req, res) => {
  try {
    const result = await pool.query('SELECT key, value FROM settings');
    const s = {};
    result.rows.forEach(r => s[r.key] = r.value);

    const methods = [];

    if (s.payment_paypal_enabled === 'true' && s.payment_paypal_handle) {
      const handle = s.payment_paypal_handle.replace(/^@/, '');
      methods.push({
        id: 'paypal', label: 'PayPal',
        handle: s.payment_paypal_handle,
        note: s.payment_paypal_note || '',
        link: `https://paypal.me/${handle}`
      });
    }
    if (s.payment_venmo_enabled === 'true' && s.payment_venmo_handle) {
      const handle = s.payment_venmo_handle.replace(/^@/, '');
      methods.push({
        id: 'venmo', label: 'Venmo',
        handle: s.payment_venmo_handle,
        note: s.payment_venmo_note || '',
        link: `https://venmo.com/u/${handle}`
      });
    }
    if (s.payment_zelle_enabled === 'true' && s.payment_zelle_handle) {
      methods.push({
        id: 'zelle', label: 'Zelle',
        handle: s.payment_zelle_handle,
        note: s.payment_zelle_note || '',
        link: null
      });
    }
    if (s.payment_cashapp_enabled === 'true' && s.payment_cashapp_handle) {
      const handle = s.payment_cashapp_handle.replace(/^\$/, '');
      methods.push({
        id: 'cashapp', label: 'Cash App',
        handle: s.payment_cashapp_handle,
        note: s.payment_cashapp_note || '',
        link: `https://cash.app/$${handle}`
      });
    }
    if (s.payment_btc_enabled === 'true' && s.payment_btc_handle) {
      methods.push({
        id: 'btc', label: 'Bitcoin',
        handle: s.payment_btc_handle,
        note: s.payment_btc_note || '',
        link: null
      });
    }
    if (s.payment_bank_enabled === 'true' && s.payment_bank_handle) {
      methods.push({
        id: 'bank', label: 'Bank Transfer',
        handle: s.payment_bank_handle,
        note: s.payment_bank_note || '',
        link: null,
        multiLine: true
      });
    }

    res.json({
      methods,
      depositAmount: parseFloat(s.deposit_amount || '0')
    });
  } catch (err) {
    console.error('Payment methods fetch failed:', err);
    res.status(500).json({ error: 'Failed to load payment methods' });
  }
});

app.post('/api/bookings', async (req, res) => {
  const { name, email, phone, preferred_date, description,
          payment_method, payment_amount } = req.body;

  if (!name || !email) {
    return res.status(400).json({ error: 'Name and email are required' });
  }

  const settingsResult = await pool.query('SELECT key, value FROM settings');
  const s = {};
  settingsResult.rows.forEach(r => s[r.key] = r.value);

  const enabledMethods = [];
  if (s.payment_zelle_enabled === 'true')   enabledMethods.push('zelle');
  if (s.payment_venmo_enabled === 'true')   enabledMethods.push('venmo');
  if (s.payment_paypal_enabled === 'true')  enabledMethods.push('paypal');
  if (s.payment_cashapp_enabled === 'true') enabledMethods.push('cashapp');
  if (s.payment_btc_enabled === 'true')     enabledMethods.push('btc');
  if (s.payment_bank_enabled === 'true')    enabledMethods.push('bank');

  if (!payment_method || !enabledMethods.includes(payment_method)) {
    return res.status(400).json({ error: 'Invalid or unavailable payment method.' });
  }

  try {
    const referenceCode = await generateUniqueReference();

    const result = await pool.query(
      `INSERT INTO bookings
        (name, email, phone, preferred_date, description, status,
         payment_method, payment_amount, reference_code)
       VALUES ($1, $2, $3, $4, $5, 'pending_payment', $6, $7, $8)
       RETURNING id, reference_code`,
      [name, email, phone || null, preferred_date || null,
       description || null, payment_method,
       payment_amount || null, referenceCode]
    );

    const booking = result.rows[0];

    transporter.sendMail({
      from: `"${process.env.EMAIL_FROM_NAME}" <${process.env.EMAIL_USER}>`,
      to: email,
      subject: `Booking received — reference ${booking.reference_code}`,
      html: emailWrapper('Booking Received', `
        <p>Hi ${escapeEmail(name)},</p>
        <p>Your reference code is:</p>
        <p style="font-size:1.5rem;letter-spacing:3px;color:#c9a227;
                  background:#0a0a0a;padding:1rem;text-align:center;
                  border-radius:6px;font-family:monospace;">
          ${booking.reference_code}
        </p>
        <p><a href="${process.env.SITE_URL || ''}/status.html?code=${booking.reference_code}"
              style="color:#c9a227;">Check status →</a></p>
      `)
    }).catch(err => console.error('Customer booking email failed:', err.message));

    transporter.sendMail({
      from: `"${process.env.EMAIL_FROM_NAME}" <${process.env.EMAIL_USER}>`,
      to: process.env.STUDIO_EMAIL,
      subject: `New booking — ${name} (${methodLabel(payment_method)})`,
      html: emailWrapper('New Booking Request', `
        <p><strong>Reference:</strong> ${booking.reference_code}</p>
        <p><strong>Name:</strong> ${escapeEmail(name)}</p>
        <p><strong>Email:</strong> ${escapeEmail(email)}</p>
        <p><strong>Phone:</strong> ${escapeEmail(phone) || '—'}</p>
        <p><strong>Date:</strong> ${preferred_date || '—'}</p>
        <p><strong>Method:</strong> ${methodLabel(payment_method)}</p>
        <p><strong>Idea:</strong> ${escapeEmail(description) || '—'}</p>
      `)
    }).catch(err => console.error('Studio notification failed:', err.message));

    res.status(201).json({
      success: true,
      bookingId: booking.id,
      referenceCode: booking.reference_code,
      message: 'Booking created.'
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to submit booking' });
  }
});

app.post('/api/bookings/:id/receipt', (req, res, next) => {
  upload.single('receipt')(req, res, (err) => {
    if (err) return next(err);
    handleReceiptUpload(req, res, next);
  });
});

async function handleReceiptUpload(req, res, next) {
  const { id } = req.params;
  if (!/^\d+$/.test(id)) return res.status(400).json({ error: 'Invalid booking ID.' });
  if (!req.file) return res.status(400).json({ error: 'No receipt file uploaded.' });

  try {
    const bookingResult = await pool.query('SELECT * FROM bookings WHERE id = $1', [id]);
    if (bookingResult.rows.length === 0) return res.status(404).json({ error: 'Booking not found.' });

    const b = bookingResult.rows[0];
    if (b.status === 'confirmed') return res.status(400).json({ error: 'Booking already confirmed.' });

    const result = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { folder: 'tattoo-parlor/receipts', resource_type: 'image' },
        (error, result) => error ? reject(error) : resolve(result));
      stream.end(req.file.buffer);
    });

    await pool.query(
      `UPDATE bookings
       SET receipt_url = $1, receipt_public_id = $2,
           receipt_uploaded_at = NOW(), status = 'pending_approval'
       WHERE id = $3`,
      [result.secure_url, result.public_id, id]
    );

    transporter.sendMail({
      from: `"${process.env.EMAIL_FROM_NAME}" <${process.env.EMAIL_USER}>`,
      to: b.email,
      subject: 'Receipt received — awaiting confirmation',
      html: emailWrapper('Receipt Received', `
        <p>Hi ${escapeEmail(b.name)},</p>
        <p>Thanks for uploading your receipt. We'll confirm within 24 hours.</p>
        <p>Reference: <span style="color:#c9a227;font-family:monospace;">${b.reference_code}</span></p>
      `)
    }).catch(err => console.error('Customer receipt email failed:', err.message));

    transporter.sendMail({
      from: `"${process.env.EMAIL_FROM_NAME}" <${process.env.EMAIL_USER}>`,
      to: process.env.STUDIO_EMAIL,
      subject: `💳 Receipt uploaded — ${b.name} (${methodLabel(b.payment_method)})`,
      html: emailWrapper('New Payment Receipt', `
        <p><strong>${escapeEmail(b.name)}</strong> uploaded a receipt.</p>
        <p><strong>Reference:</strong> ${b.reference_code}</p>
        <p><strong>Email:</strong> ${escapeEmail(b.email)}</p>
        <p><strong>Method:</strong> ${methodLabel(b.payment_method)}</p>
        <p><strong>Amount:</strong> ${b.payment_amount ? '$' + parseFloat(b.payment_amount).toFixed(2) : '—'}</p>
        <p><a href="${result.secure_url}" target="_blank" rel="noopener">
          <img src="${result.secure_url}" alt="Receipt"
               style="max-width:100%;border-radius:6px;border:1px solid #242424;margin-top:1rem;">
        </a></p>
        <p style="margin-top:1.5rem;">
          <a href="${process.env.SITE_URL}/admin-panel.html"
             style="display:inline-block;background:#c9a227;color:#0a0a0a;
                    padding:0.7rem 1.75rem;text-decoration:none;border-radius:4px;
                    font-weight:bold;font-size:0.9rem;">
            Open Admin Panel
          </a>
        </p>
      `)
    }).catch(err => console.error('Studio receipt email failed:', err.message));

    res.json({ success: true, message: 'Receipt uploaded.' });
  } catch (err) {
    console.error('Receipt upload error:', err);
    next(err);
  }
}

app.post('/api/appointments/lookup', async (req, res) => {
  const { reference_code, email } = req.body;
  if (!reference_code || !email) {
    return res.status(400).json({ error: 'Reference code and email are required.' });
  }

  try {
    const result = await pool.query(
      `SELECT id, name, email, phone, preferred_date, description,
              status, payment_method, payment_amount,
              reference_code, receipt_number, approved_at,
              rejection_reason, created_at
       FROM bookings
       WHERE reference_code = $1 AND LOWER(email) = LOWER($2)`,
      [reference_code.trim().toUpperCase(), email.trim()]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'No appointment found with those details.' });
    }

    const booking = result.rows[0];

    const payload = Buffer.from(JSON.stringify({
      bookingId: booking.id,
      code: booking.reference_code,
      exp: Date.now() + 60 * 60 * 1000
    })).toString('base64');

    const sig = crypto
      .createHmac('sha256', process.env.COOKIE_SECRET)
      .update(payload)
      .digest('hex');

    const accessToken = `${sig}.${payload}`;
    delete booking.id;

    res.json({
      appointment: booking,
      accessToken,
      canDownloadReceipt: booking.status === 'confirmed'
    });
  } catch (err) {
    console.error('Lookup failed:', err);
    res.status(500).json({ error: 'Lookup failed.' });
  }
});

app.get('/api/appointments/receipt.pdf', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).send('Missing token');

  const [sig, payload] = token.split('.');
  if (!sig || !payload) return res.status(400).send('Invalid token');

  const expected = crypto
    .createHmac('sha256', process.env.COOKIE_SECRET)
    .update(payload)
    .digest('hex');

  if (sig !== expected) return res.status(403).send('Invalid token');

  let decoded;
  try {
    decoded = JSON.parse(Buffer.from(payload, 'base64').toString());
  } catch { return res.status(400).send('Invalid token'); }

  if (decoded.exp < Date.now()) return res.status(410).send('Token expired');

  try {
    const result = await pool.query('SELECT * FROM bookings WHERE id = $1', [decoded.bookingId]);
    if (result.rows.length === 0) return res.status(404).send('Booking not found');

    const b = result.rows[0];
    if (b.status !== 'confirmed') return res.status(403).send('Receipt available only after confirmation');

    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="receipt-${b.reference_code}.pdf"`);
    doc.pipe(res);

    doc.rect(0, 0, doc.page.width, 6).fill('#c9a227');
    doc.fillColor('#0a0a0a').fontSize(26).font('Helvetica-Bold').text('INK & IRON', 50, 60, { characterSpacing: 2 });
    doc.fontSize(10).font('Helvetica').fillColor('#666').text('TATTOO PARLOR', 50, 92, { characterSpacing: 3 });
    doc.fontSize(24).font('Helvetica-Bold').fillColor('#0a0a0a').text('RECEIPT', 400, 60, { align: 'right', width: 145 });
    doc.fontSize(10).font('Helvetica').fillColor('#666').text(`#${b.receipt_number || b.reference_code}`, 400, 92, { align: 'right', width: 145 });
    doc.moveTo(50, 145).lineTo(545, 145).strokeColor('#e0e0e0').stroke();

    doc.fontSize(9).fillColor('#999').text('BILLED TO', 50, 165, { characterSpacing: 1 });
    doc.fontSize(12).font('Helvetica-Bold').fillColor('#0a0a0a').text(b.name, 50, 180);
    doc.fontSize(10).font('Helvetica').fillColor('#444').text(b.email, 50, 198);
    doc.fontSize(13).font('Helvetica-Bold').fillColor('#c9a227').text(b.reference_code, 350, 180, { characterSpacing: 2 });

    let y = 260;
    doc.rect(50, y, 495, 1).fill('#e0e0e0');
    y += 12;
    doc.fontSize(10).font('Helvetica').fillColor('#0a0a0a')
       .text('Tattoo appointment deposit', 50, y)
       .text(`$${parseFloat(b.payment_amount || 0).toFixed(2)}`, 400, y, { align: 'right', width: 145 });
    y += 22;
    doc.fontSize(9).fillColor('#666').text(`Method: ${methodLabel(b.payment_method).toUpperCase()}`, 50, y);
    y += 16;
    doc.text(`Preferred date: ${b.preferred_date ? new Date(b.preferred_date).toLocaleDateString('en-US') : 'TBC'}`, 50, y);
    y += 30;
    doc.moveTo(50, y).lineTo(545, y).strokeColor('#e0e0e0').stroke();
    y += 15;
    doc.fontSize(10).font('Helvetica-Bold').fillColor('#666').text('TOTAL PAID', 350, y);
    doc.fontSize(20).fillColor('#0a0a0a').text(`$${parseFloat(b.payment_amount || 0).toFixed(2)}`, 350, y + 16, { align: 'right', width: 195 });

    doc.save();
    doc.translate(430, doc.page.height - 140);
    doc.rotate(-12);
    doc.rect(-70, -22, 140, 44).lineWidth(2).strokeColor('#3a8a5a').stroke();
    doc.fontSize(14).font('Helvetica-Bold').fillColor('#3a8a5a').text('CONFIRMED', -70, -8, { width: 140, align: 'center' });
    doc.restore();

    doc.end();
  } catch (err) {
    console.error('PDF generation failed:', err);
    if (!res.headersSent) res.status(500).send('Failed to generate receipt');
  }
});

// ═════════════════════════════════════════════════════════════════════════
//  ADMIN ACCESS GATE
// ═════════════════════════════════════════════════════════════════════════
app.get('/admin/access', (req, res) => {
  const { key } = req.query;
  if (!key || key !== process.env.ADMIN_ACCESS_KEY) {
    return res.status(404).send('Not found');
  }

  const payload = Buffer.from(JSON.stringify({
    role: 'admin',
    exp: Date.now() + 2 * 60 * 60 * 1000
  })).toString('base64');

  const sig = crypto
    .createHmac('sha256', process.env.COOKIE_SECRET)
    .update(payload)
    .digest('hex');

  res.cookie('admin_session', `${sig}.${payload}`, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 2 * 60 * 60 * 1000,
    path: '/'
  });

  res.redirect('/admin-panel.html');
});

// ═════════════════════════════════════════════════════════════════════════
//  ADMIN API
// ═════════════════════════════════════════════════════════════════════════
app.post('/api/admin/photos', requireAdmin, (req, res, next) => {
  upload.single('photo')(req, res, (err) => {
    if (err) return next(err);
    handlePhotoUpload(req, res, next);
  });
});

async function handlePhotoUpload(req, res, next) {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
  const title = (req.body.title || '').trim();
  if (!title) return res.status(400).json({ error: 'Title is required.' });

  try {
    const result = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { folder: 'tattoo-parlor', resource_type: 'image' },
        (error, result) => error ? reject(error) : resolve(result));
      stream.end(req.file.buffer);
    });

    const dbResult = await pool.query(
      `INSERT INTO photos (title, description, cloudinary_url, cloudinary_public_id)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [title, req.body.description || '', result.secure_url, result.public_id]
    );

    res.status(201).json(dbResult.rows[0]);
  } catch (err) {
    console.error('Upload error:', err);
    if (err.http_code && err.message) {
      return res.status(500).json({ error: `Cloudinary: ${err.message}` });
    }
    next(err);
  }
}

app.delete('/api/admin/photos/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const photo = await pool.query('SELECT cloudinary_public_id FROM photos WHERE id = $1', [id]);
    if (photo.rows.length === 0) return res.status(404).json({ error: 'Photo not found' });

    await cloudinary.uploader.destroy(photo.rows[0].cloudinary_public_id);
    await pool.query('DELETE FROM photos WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Delete failed' });
  }
});

app.get('/api/admin/bookings', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM bookings ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch bookings' });
  }
});// ─── Test email configuration (admin only) ──────────────────────────────
app.get('/api/admin/test-email', requireAdmin, async (req, res) => {
  const target = req.query.to || process.env.STUDIO_EMAIL;
  if (!target) {
    return res.status(400).json({ error: 'No recipient — pass ?to=email@example.com' });
  }

  try {
    await transporter.verify();
    const info = await transporter.sendMail({
      from: `"${process.env.EMAIL_FROM_NAME}" <${process.env.EMAIL_USER}>`,
      to: target,
      subject: '✅ Ink & Iron email test',
      html: emailWrapper('Email Test', `
        <p>This is a test email from your Ink & Iron booking system.</p>
        <p>If you received this, your email configuration is working correctly.</p>
        <p>Sent at: ${new Date().toISOString()}</p>
        <p>From: ${process.env.EMAIL_USER}</p>
      `)
    });
    res.json({
      success: true,
      messageId: info.messageId,
      accepted: info.accepted,
      rejected: info.rejected,
      response: info.response
    });
  } catch (err) {
    console.error('Test email failed:', err);
    res.status(500).json({
      error: err.message,
      code: err.code,
      response: err.response,
      command: err.command
    });
  }
});

app.post('/api/admin/bookings/:id/approve', requireAdmin, async (req, res, next) => {
  const { id } = req.params;
  if (!/^\d+$/.test(id)) return res.status(400).json({ error: 'Invalid booking ID' });

  try {
    const receiptNumber = `R-${new Date().getFullYear()}-${String(id).padStart(5, '0')}`;
    const result = await pool.query(
      `UPDATE bookings
       SET status = 'confirmed', approved_at = NOW(),
           rejection_reason = NULL,
           receipt_number = COALESCE(receipt_number, $1)
       WHERE id = $2 RETURNING *`,
      [receiptNumber, id]
    );

    if (result.rows.length === 0) return res.status(404).json({ error: 'Booking not found.' });
    const b = result.rows[0];

    transporter.sendMail({
      from: `"${process.env.EMAIL_FROM_NAME}" <${process.env.EMAIL_USER}>`,
      to: b.email,
      subject: '✅ Your appointment is confirmed',
      html: emailWrapper('Appointment Confirmed', `
        <p>Hi ${escapeEmail(b.name)},</p>
        <p>Your deposit has been verified. Your appointment is confirmed.</p>
        <p style="font-size:1.5rem;letter-spacing:3px;color:#c9a227;
                  background:#0a0a0a;padding:1rem;text-align:center;
                  border-radius:6px;font-family:monospace;">
          ${b.reference_code}
        </p>
        <p>Receipt #: ${b.receipt_number}</p>
        <p>Amount: $${parseFloat(b.payment_amount || 0).toFixed(2)}</p>
        <p>Method: ${methodLabel(b.payment_method)}</p>
        <p style="margin-top:1.5rem;">
          <a href="${process.env.SITE_URL}/status.html?code=${b.reference_code}"
             style="display:inline-block;background:#c9a227;color:#0a0a0a;
                    padding:0.75rem 2rem;text-decoration:none;border-radius:4px;font-weight:bold;">
            View Appointment &amp; Download Receipt
          </a>
        </p>
      `)
    }).catch(err => console.error('Approval email failed:', err.message));

    res.json({ success: true, booking: b });
  } catch (err) {
    console.error('Approval error:', err);
    next(err);
  }
});

app.post('/api/admin/bookings/:id/reject', requireAdmin, async (req, res, next) => {
  const { id } = req.params;
  const { reason } = req.body;
  if (!/^\d+$/.test(id)) return res.status(400).json({ error: 'Invalid booking ID' });

  try {
    const result = await pool.query(
      `UPDATE bookings SET status = 'cancelled', rejection_reason = $1
       WHERE id = $2 RETURNING *`,
      [reason || 'Payment could not be verified', id]
    );

    if (result.rows.length === 0) return res.status(404).json({ error: 'Booking not found.' });
    const b = result.rows[0];

    transporter.sendMail({
      from: `"${process.env.EMAIL_FROM_NAME}" <${process.env.EMAIL_USER}>`,
      to: b.email,
      subject: 'Booking update — payment could not be verified',
      html: emailWrapper('Payment Not Verified', `
        <p>Hi ${escapeEmail(b.name)},</p>
        <p>We weren't able to verify your payment.</p>
        <p><strong>Reason:</strong> ${escapeEmail(reason) || 'Receipt could not be matched.'}</p>
      `)
    }).catch(err => console.error('Rejection email failed:', err.message));

    res.json({ success: true, booking: b });
  } catch (err) {
    console.error('Rejection error:', err);
    next(err);
  }
});

app.get('/api/admin/settings', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query('SELECT key, value FROM settings');
    const settings = {};
    result.rows.forEach(r => settings[r.key] = r.value);
    res.json(settings);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load settings' });
  }
});

app.patch('/api/admin/settings', requireAdmin, async (req, res) => {
  const updates = req.body;
  if (!updates || typeof updates !== 'object' || Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'No settings provided' });
  }

  const ALLOWED_KEYS = [
    'deposit_amount',
    'payment_zelle_enabled',  'payment_zelle_handle',  'payment_zelle_note',
    'payment_venmo_enabled',  'payment_venmo_handle',  'payment_venmo_note',
    'payment_paypal_enabled', 'payment_paypal_handle', 'payment_paypal_note',
    'payment_cashapp_enabled','payment_cashapp_handle','payment_cashapp_note',
    'payment_btc_enabled',    'payment_btc_handle',    'payment_btc_note',
    'payment_bank_enabled',   'payment_bank_handle',   'payment_bank_note'
  ];

  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const [key, value] of Object.entries(updates)) {
        if (!ALLOWED_KEYS.includes(key)) continue;
        await client.query(
          `INSERT INTO settings (key, value, updated_at)
           VALUES ($1, $2, NOW())
           ON CONFLICT (key) DO UPDATE
           SET value = EXCLUDED.value, updated_at = NOW()`,
          [key, String(value)]
        );
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Settings update failed:', err);
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

// ─── Error handler ───────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);

  if (err && err.name === 'MulterError') {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'File is too large. Maximum size is 10 MB.' });
    }
    if (err.code === 'LIMIT_UNEXPECTED_FILE') {
      return res.status(400).json({ error: 'Unexpected file field.' });
    }
    return res.status(400).json({ error: `Upload error: ${err.message}` });
  }
  if (err && err.message === 'Only image files are allowed') {
    return res.status(400).json({ error: 'Only image files are allowed.' });
  }
  res.status(500).json({ error: err.message || 'Something went wrong.' });
});

// ─── Start ───────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  initDB().catch(err => {
    console.error('❌ Database init failed:', err);
    process.exit(1);
  });
});
