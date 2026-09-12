require('dotenv').config();

const express      = require('express');
const { Pool }     = require('pg');
const multer       = require('multer');
const cloudinary   = require('cloudinary').v2;
const cookieParser = require('cookie-parser');
const crypto       = require('crypto');
const path         = require('path');
const nodemailer   = require('nodemailer');
const PDFDocument  = require('pdfkit');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Paths ───────────────────────────────────────────────────────────────
const FRONTEND_DIR = path.join(__dirname, '..', 'frontend');
const BACKEND_DIR  = __dirname;

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

// ─── Multer (memory → Cloudinary) ────────────────────────────────────────
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

// ─── Email Helpers ───────────────────────────────────────────────────────
function emailWrapper(title, bodyHtml) {
  return `
    <div style="font-family:Georgia,serif;max-width:600px;margin:0 auto;background:#0a0a0a;color:#f0ede8;padding:2rem;border-radius:8px;">
      <h1 style="color:#c9a227;font-size:1.5rem;letter-spacing:2px;text-transform:uppercase;margin:0 0 1.5rem;">Ink &amp; Iron</h1>
      <h2 style="color:#f0ede8;font-size:1.3rem;margin:0 0 1rem;">${title}</h2>
      ${bodyHtml}
      <hr style="border:none;border-top:1px solid #242424;margin:2rem 0;">
      <p style="color:#6a6a6a;font-size:0.8rem;margin:0;">
        Ink &amp; Iron Tattoo Parlor · hello@inkandiron.example<br>
        This is an automated message. Please do not reply directly.
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
    paypal: 'PayPal', venmo: 'Venmo',
    zelle: 'Zelle',  cashapp: 'Cash App'
  };
  return map[(m || '').toLowerCase()] || (m || 'Unknown');
}

// ─── Middleware ──────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// ─── Static Files — BEFORE routes ────────────────────────────────────────
app.use(express.static(FRONTEND_DIR));

// ─── Database Init ───────────────────────────────────────────────────────
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

    CREATE INDEX IF NOT EXISTS idx_bookings_reference
      ON bookings (reference_code);
    CREATE INDEX IF NOT EXISTS idx_bookings_email
      ON bookings (LOWER(email));

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TIMESTAMP DEFAULT NOW()
    );

    INSERT INTO settings (key, value) VALUES
      ('deposit_amount', '50'),
      ('payment_zelle_enabled', 'true'),
      ('payment_zelle_handle', 'yourstudio@email.com'),
      ('payment_venmo_enabled', 'true'),
      ('payment_venmo_handle', '@YourStudioHandle'),
      ('payment_paypal_enabled', 'true'),
      ('payment_paypal_handle', 'yourpaypal@email.com'),
      ('payment_cashapp_enabled', 'false'),
      ('payment_cashapp_handle', '$YourCashtag')
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

// ─── Admin Auth (HMAC-signed cookie) ─────────────────────────────────────
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

// ═════════════════════════════════════════════════════════════════════════
//  PUBLIC API
// ═════════════════════════════════════════════════════════════════════════

// ─── Public gallery photos ───────────────────────────────────────────────
app.get('/api/photos', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, title, description, cloudinary_url
       FROM photos ORDER BY created_at DESC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch photos' });
  }
});

// ─── Public payment methods ──────────────────────────────────────────────
app.get('/api/payment-methods', async (req, res) => {
  try {
    const result = await pool.query('SELECT key, value FROM settings');
    const s = {};
    result.rows.forEach(r => s[r.key] = r.value);

    const methods = [];

    if (s.payment_zelle_enabled === 'true' && s.payment_zelle_handle) {
      methods.push({
        id: 'zelle',
        label: 'Zelle',
        handle: s.payment_zelle_handle,
        note: "Send via your bank's Zelle feature to the email or phone above.",
        link: null
      });
    }

    if (s.payment_venmo_enabled === 'true' && s.payment_venmo_handle) {
      const handle = s.payment_venmo_handle.replace(/^@/, '');
      methods.push({
        id: 'venmo',
        label: 'Venmo',
        handle: s.payment_venmo_handle,
        note: 'Tap the button to open Venmo directly, or search the handle manually.',
        link: `https://venmo.com/u/${handle}`
      });
    }

    if (s.payment_paypal_enabled === 'true' && s.payment_paypal_handle) {
      const handle = s.payment_paypal_handle.replace(/^@/, '');
      methods.push({
        id: 'paypal',
        label: 'PayPal',
        handle: s.payment_paypal_handle,
        note: 'Tap the button to open PayPal.me, or send manually to the email above.',
        link: `https://paypal.me/${handle}`
      });
    }

    if (s.payment_cashapp_enabled === 'true' && s.payment_cashapp_handle) {
      const handle = s.payment_cashapp_handle.replace(/^\$/, '');
      methods.push({
        id: 'cashapp',
        label: 'Cash App',
        handle: s.payment_cashapp_handle,
        note: 'Tap the button to open Cash App, or send manually to the cashtag above.',
        link: `https://cash.app/$${handle}`
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

// ─── Create booking ──────────────────────────────────────────────────────
app.post('/api/bookings', async (req, res) => {
  const {
    name, email, phone, preferred_date, description,
    payment_method, payment_amount
  } = req.body;

  if (!name || !email) {
    return res.status(400).json({ error: 'Name and email are required' });
  }

  // Validate method against enabled ones
  const settingsResult = await pool.query('SELECT key, value FROM settings');
  const s = {};
  settingsResult.rows.forEach(r => s[r.key] = r.value);

  const enabledMethods = [];
  if (s.payment_zelle_enabled === 'true')  enabledMethods.push('zelle');
  if (s.payment_venmo_enabled === 'true')  enabledMethods.push('venmo');
  if (s.payment_paypal_enabled === 'true') enabledMethods.push('paypal');
  if (s.payment_cashapp_enabled === 'true') enabledMethods.push('cashapp');

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
      [
        name, email, phone || null, preferred_date || null,
        description || null, payment_method,
        payment_amount || null, referenceCode
      ]
    );

    const booking = result.rows[0];

    // Customer confirmation email
    transporter.sendMail({
      from: `"${process.env.EMAIL_FROM_NAME}" <${process.env.EMAIL_USER}>`,
      to: email,
      subject: `Booking received — reference ${booking.reference_code}`,
      html: emailWrapper('Booking Received', `
        <p>Hi ${escapeEmail(name)},</p>
        <p>We received your booking request. Your reference code is:</p>
        <p style="font-size:1.5rem;letter-spacing:3px;color:#c9a227;
                  background:#0a0a0a;padding:1rem;text-align:center;
                  border-radius:6px;font-family:monospace;">
          ${booking.reference_code}
        </p>
        <p><strong>Save this code.</strong> You'll use it to check status at any time:</p>
        <p><a href="${process.env.SITE_URL || ''}/status.html?code=${booking.reference_code}"
              style="color:#c9a227;">Check my appointment status →</a></p>
        <p style="margin-top:1.5rem;">
          Next step: send your deposit via ${methodLabel(payment_method)} and
          upload the receipt on the booking page.
        </p>
      `)
    }).catch(err => console.error('Customer booking email failed:', err.message));

    // Studio notification
    transporter.sendMail({
      from: `"${process.env.EMAIL_FROM_NAME}" <${process.env.EMAIL_USER}>`,
      to: process.env.STUDIO_EMAIL,
      subject: `New booking — ${name} (${methodLabel(payment_method)})`,
      html: emailWrapper('New Booking Request', `
        <p><strong>Reference:</strong>
          <span style="color:#c9a227;font-family:monospace;letter-spacing:2px;">
            ${booking.reference_code}
          </span>
        </p>
        <p><strong>Name:</strong> ${escapeEmail(name)}</p>
        <p><strong>Email:</strong>
          <a href="mailto:${escapeEmail(email)}" style="color:#c9a227;">${escapeEmail(email)}</a>
        </p>
        <p><strong>Phone:</strong> ${escapeEmail(phone) || '—'}</p>
        <p><strong>Preferred date:</strong> ${preferred_date || '—'}</p>
        <p><strong>Method:</strong> ${methodLabel(payment_method)}</p>
        <p><strong>Idea:</strong> ${escapeEmail(description) || '—'}</p>
        <p style="margin-top:1.5rem;">Awaiting receipt upload from customer.</p>
      `)
    }).catch(err => console.error('Studio notification failed:', err.message));

    res.status(201).json({
      success: true,
      bookingId: booking.id,
      referenceCode: booking.reference_code,
      message: 'Booking created. Please send your deposit and upload the receipt.'
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to submit booking' });
  }
});

// ─── Upload payment receipt ──────────────────────────────────────────────
app.post('/api/bookings/:id/receipt', (req, res, next) => {
  upload.single('receipt')(req, res, (err) => {
    if (err) return next(err);
    handleReceiptUpload(req, res, next);
  });
});

async function handleReceiptUpload(req, res, next) {
  const { id } = req.params;

  if (!/^\d+$/.test(id)) {
    return res.status(400).json({ error: 'Invalid booking ID.' });
  }

  if (!req.file) {
    return res.status(400).json({ error: 'No receipt file uploaded.' });
  }

  try {
    const bookingResult = await pool.query(
      'SELECT * FROM bookings WHERE id = $1', [id]);

    if (bookingResult.rows.length === 0) {
      return res.status(404).json({ error: 'Booking not found.' });
    }

    const b = bookingResult.rows[0];

    if (b.status === 'confirmed') {
      return res.status(400).json({ error: 'This booking is already confirmed.' });
    }

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

    // Customer receipt received email
    transporter.sendMail({
      from: `"${process.env.EMAIL_FROM_NAME}" <${process.env.EMAIL_USER}>`,
      to: b.email,
      subject: 'Receipt received — awaiting confirmation',
      html: emailWrapper('We received your receipt', `
        <p>Hi ${escapeEmail(b.name)},</p>
        <p>Thanks for uploading your deposit receipt. We're verifying it now
        and will confirm your appointment within 24 hours.</p>
        <p>Reference code:
          <span style="color:#c9a227;font-family:monospace;letter-spacing:2px;">
            ${b.reference_code}
          </span>
        </p>
        <p><a href="${process.env.SITE_URL}/status.html?code=${b.reference_code}"
              style="color:#c9a227;">Check status →</a></p>
      `)
    }).catch(err => console.error('Customer receipt email failed:', err.message));

    // Studio notification — with embedded receipt image + direct links
    transporter.sendMail({
      from: `"${process.env.EMAIL_FROM_NAME}" <${process.env.EMAIL_USER}>`,
      to: process.env.STUDIO_EMAIL,
      subject: `💳 Receipt uploaded — ${b.name} (${methodLabel(b.payment_method)})`,
      html: emailWrapper('New Payment Receipt', `
        <p><strong>${escapeEmail(b.name)}</strong> uploaded a payment receipt.</p>

        <table style="width:100%;border-collapse:collapse;margin:1.5rem 0;
                      background:#161616;border-radius:6px;padding:1rem;">
          <tr>
            <td style="padding:0.5rem 1rem;color:#999;font-size:0.85rem;">Reference</td>
            <td style="padding:0.5rem 1rem;text-align:right;font-family:monospace;
                       color:#c9a227;letter-spacing:2px;">${b.reference_code}</td>
          </tr>
          <tr>
            <td style="padding:0.5rem 1rem;color:#999;font-size:0.85rem;">Customer</td>
            <td style="padding:0.5rem 1rem;text-align:right;">${escapeEmail(b.name)}</td>
          </tr>
          <tr>
            <td style="padding:0.5rem 1rem;color:#999;font-size:0.85rem;">Email</td>
            <td style="padding:0.5rem 1rem;text-align:right;">
              <a href="mailto:${escapeEmail(b.email)}" style="color:#c9a227;">${escapeEmail(b.email)}</a>
            </td>
          </tr>
          <tr>
            <td style="padding:0.5rem 1rem;color:#999;font-size:0.85rem;">Method</td>
            <td style="padding:0.5rem 1rem;text-align:right;">${methodLabel(b.payment_method)}</td>
          </tr>
          <tr>
            <td style="padding:0.5rem 1rem;color:#999;font-size:0.85rem;">Amount</td>
            <td style="padding:0.5rem 1rem;text-align:right;">
              ${b.payment_amount ? '$' + parseFloat(b.payment_amount).toFixed(2) : '—'}
            </td>
          </tr>
        </table>

        <p style="margin:1.5rem 0 0.5rem;color:#999;font-size:0.85rem;
                  text-transform:uppercase;letter-spacing:1px;">Receipt Preview</p>
        <a href="${result.secure_url}" target="_blank" rel="noopener">
          <img src="${result.secure_url}" alt="Receipt"
               style="max-width:100%;border-radius:6px;border:1px solid #242424;">
        </a>

        <p style="margin-top:1.5rem;">
          <a href="${result.secure_url}" target="_blank" rel="noopener"
             style="display:inline-block;background:#c9a227;color:#0a0a0a;
                    padding:0.7rem 1.75rem;text-decoration:none;border-radius:4px;
                    font-weight:bold;font-size:0.9rem;">
            View Full Receipt
          </a>
          <a href="${process.env.SITE_URL}/admin-panel.html"
             style="display:inline-block;background:transparent;color:#c9a227;
                    padding:0.7rem 1.75rem;text-decoration:none;border-radius:4px;
                    font-weight:bold;font-size:0.9rem;border:1px solid #c9a227;
                    margin-left:0.5rem;">
            Open Admin Panel
          </a>
        </p>
      `)
    }).catch(err => console.error('Studio receipt email failed:', err.message));

    res.json({ success: true, message: 'Receipt uploaded. Awaiting approval.' });

  } catch (err) {
    console.error('Receipt upload error:', err);
    next(err);
  }
}

// ─── Public appointment lookup ───────────────────────────────────────────
app.post('/api/appointments/lookup', async (req, res) => {
  const { reference_code, email } = req.body;

  if (!reference_code || !email) {
    return res.status(400).json({
      error: 'Reference code and email are required.'
    });
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
      return res.status(404).json({
        error: 'No appointment found with those details.'
      });
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
    res.status(500).json({ error: 'Lookup failed. Please try again.' });
  }
});

// ─── Receipt PDF download ────────────────────────────────────────────────
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
  } catch {
    return res.status(400).send('Invalid token');
  }

  if (decoded.exp < Date.now()) return res.status(410).send('Token expired');

  try {
    const result = await pool.query(
      'SELECT * FROM bookings WHERE id = $1', [decoded.bookingId]);

    if (result.rows.length === 0) return res.status(404).send('Booking not found');

    const b = result.rows[0];
    if (b.status !== 'confirmed') {
      return res.status(403).send('Receipt available only after confirmation');
    }

    const doc = new PDFDocument({ size: 'A4', margin: 50 });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition',
      `attachment; filename="receipt-${b.reference_code}.pdf"`);

    doc.pipe(res);

    // Gold bar
    doc.rect(0, 0, doc.page.width, 6).fill('#c9a227');

    // Header
    doc.fillColor('#0a0a0a').fontSize(26).font('Helvetica-Bold')
       .text('INK & IRON', 50, 60, { characterSpacing: 2 });
    doc.fontSize(10).font('Helvetica').fillColor('#666')
       .text('TATTOO PARLOR', 50, 92, { characterSpacing: 3 });
    doc.fillColor('#666').fontSize(9)
       .text('hello@inkandiron.example', 50, 110);

    // Receipt label
    doc.fontSize(24).font('Helvetica-Bold').fillColor('#0a0a0a')
       .text('RECEIPT', 400, 60, { align: 'right', width: 145 });
    doc.fontSize(10).font('Helvetica').fillColor('#666')
       .text(`#${b.receipt_number || b.reference_code}`, 400, 92,
             { align: 'right', width: 145 });
    doc.fontSize(9)
       .text(new Date(b.approved_at || Date.now()).toLocaleDateString('en-US', {
         year: 'numeric', month: 'long', day: 'numeric'
       }), 400, 110, { align: 'right', width: 145 });

    // Divider
    doc.moveTo(50, 145).lineTo(545, 145).strokeColor('#e0e0e0').stroke();

    // Bill To
    doc.fontSize(9).fillColor('#999')
       .text('BILLED TO', 50, 165, { characterSpacing: 1 });
    doc.fontSize(12).font('Helvetica-Bold').fillColor('#0a0a0a')
       .text(b.name, 50, 180);
    doc.fontSize(10).font('Helvetica').fillColor('#444')
       .text(b.email, 50, 198);
    if (b.phone) doc.text(b.phone, 50, 213);

    // Appointment ref
    doc.fontSize(9).font('Helvetica').fillColor('#999')
       .text('APPOINTMENT REFERENCE', 350, 165, { characterSpacing: 1 });
    doc.fontSize(13).font('Helvetica-Bold').fillColor('#c9a227')
       .text(b.reference_code, 350, 180, { characterSpacing: 2 });

    // Payment details
    let y = 260;
    doc.fontSize(9).font('Helvetica').fillColor('#999')
       .text('PAYMENT DETAILS', 50, y, { characterSpacing: 1 });
    y += 20;

    doc.rect(50, y, 495, 1).fill('#e0e0e0');
    y += 12;

    doc.fontSize(10).font('Helvetica').fillColor('#0a0a0a')
       .text('Tattoo appointment deposit', 50, y)
       .text(`$${parseFloat(b.payment_amount || 0).toFixed(2)}`, 400, y,
             { align: 'right', width: 145 });
    y += 22;

    doc.fontSize(9).fillColor('#666')
       .text(`Method: ${methodLabel(b.payment_method).toUpperCase()}`, 50, y);
    y += 16;

    doc.text(`Preferred date: ${b.preferred_date
      ? new Date(b.preferred_date).toLocaleDateString('en-US', {
          year: 'numeric', month: 'long', day: 'numeric'
        })
      : 'To be confirmed'}`, 50, y);
    y += 16;

    doc.text(`Confirmed: ${new Date(b.approved_at).toLocaleString('en-US')}`,
             50, y);
    y += 30;

    doc.moveTo(50, y).lineTo(545, y).strokeColor('#e0e0e0').stroke();
    y += 15;

    doc.fontSize(10).font('Helvetica-Bold').fillColor('#666')
       .text('TOTAL PAID', 350, y, { characterSpacing: 1 });
    doc.fontSize(20).fillColor('#0a0a0a')
       .text(`$${parseFloat(b.payment_amount || 0).toFixed(2)}`, 350, y + 16,
             { align: 'right', width: 195 });

    if (b.description) {
      y += 80;
      doc.fontSize(9).font('Helvetica').fillColor('#999')
         .text('DESIGN NOTES', 50, y, { characterSpacing: 1 });
      doc.fontSize(10).fillColor('#333')
         .text(b.description, 50, y + 16, { width: 495, lineGap: 3 });
    }

    // Confirmed stamp
    const stampY = doc.page.height - 140;
    doc.save();
    doc.translate(430, stampY);
    doc.rotate(-12);
    doc.rect(-70, -22, 140, 44).lineWidth(2).strokeColor('#3a8a5a').stroke();
    doc.fontSize(14).font('Helvetica-Bold').fillColor('#3a8a5a')
       .text('CONFIRMED', -70, -8, { width: 140, align: 'center' });
    doc.restore();

    // Footer
    doc.fontSize(8).fillColor('#999')
       .text('Thank you for choosing Ink & Iron. This receipt confirms your deposit has been received.',
             50, doc.page.height - 80, { width: 495, align: 'center' })
       .text('For questions: hello@inkandiron.example',
             50, doc.page.height - 65, { width: 495, align: 'center' });

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

// ─── Protected admin pages (served from backend/) ────────────────────────
app.get('/admin-panel.html', requireAdmin, (req, res) => {
  res.sendFile(path.join(BACKEND_DIR, 'admin-panel.html'));
});

app.get('/admin-payment-settings.html', requireAdmin, (req, res) => {
  res.sendFile(path.join(BACKEND_DIR, 'admin-payment-settings.html'));
});

// ═════════════════════════════════════════════════════════════════════════
//  ADMIN API
// ═════════════════════════════════════════════════════════════════════════

// ─── Upload photo ────────────────────────────────────────────────────────
app.post('/api/admin/photos', requireAdmin, (req, res, next) => {
  upload.single('photo')(req, res, (err) => {
    if (err) return next(err);
    handlePhotoUpload(req, res, next);
  });
});

async function handlePhotoUpload(req, res, next) {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded.' });
  }

  const title = (req.body.title || '').trim();
  if (!title) {
    return res.status(400).json({ error: 'Title is required.' });
  }

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

// ─── Delete photo ────────────────────────────────────────────────────────
app.delete('/api/admin/photos/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const photo = await pool.query(
      'SELECT cloudinary_public_id FROM photos WHERE id = $1', [id]);

    if (photo.rows.length === 0) {
      return res.status(404).json({ error: 'Photo not found' });
    }

    await cloudinary.uploader.destroy(photo.rows[0].cloudinary_public_id);
    await pool.query('DELETE FROM photos WHERE id = $1', [id]);

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Delete failed' });
  }
});

// ─── List bookings ───────────────────────────────────────────────────────
app.get('/api/admin/bookings', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM bookings ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch bookings' });
  }
});

// ─── Approve booking ─────────────────────────────────────────────────────
app.post('/api/admin/bookings/:id/approve', requireAdmin, async (req, res, next) => {
  const { id } = req.params;
  if (!/^\d+$/.test(id)) {
    return res.status(400).json({ error: 'Invalid booking ID' });
  }

  try {
    const receiptNumber = `R-${new Date().getFullYear()}-${String(id).padStart(5, '0')}`;

    const result = await pool.query(
      `UPDATE bookings
       SET status = 'confirmed',
           approved_at = NOW(),
           rejection_reason = NULL,
           receipt_number = COALESCE(receipt_number, $1)
       WHERE id = $2 RETURNING *`,
      [receiptNumber, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Booking not found.' });
    }

    const b = result.rows[0];

    // Confirmation email
    transporter.sendMail({
      from: `"${process.env.EMAIL_FROM_NAME}" <${process.env.EMAIL_USER}>`,
      to: b.email,
      subject: '✅ Your appointment is confirmed',
      html: emailWrapper('Appointment Confirmed', `
        <p>Hi ${escapeEmail(b.name)},</p>
        <p>Your deposit has been verified. Your appointment is confirmed.</p>

        <p style="font-size:1.5rem;letter-spacing:3px;color:#c9a227;
                  background:#0a0a0a;padding:1rem;text-align:center;
                  border-radius:6px;font-family:monospace;margin:1.5rem 0;">
          ${b.reference_code}
        </p>

        <table style="width:100%;border-collapse:collapse;margin:1.5rem 0;">
          <tr>
            <td style="padding:6px 0;color:#999;">Receipt #</td>
            <td style="padding:6px 0;text-align:right;">${b.receipt_number}</td>
          </tr>
          <tr>
            <td style="padding:6px 0;color:#999;">Amount paid</td>
            <td style="padding:6px 0;text-align:right;">
              $${parseFloat(b.payment_amount || 0).toFixed(2)}
            </td>
          </tr>
          <tr>
            <td style="padding:6px 0;color:#999;">Method</td>
            <td style="padding:6px 0;text-align:right;">
              ${methodLabel(b.payment_method)}
            </td>
          </tr>
          <tr>
            <td style="padding:6px 0;color:#999;">Appointment date</td>
            <td style="padding:6px 0;text-align:right;">
              ${b.preferred_date
                ? new Date(b.preferred_date).toLocaleDateString('en-US')
                : 'To be confirmed'}
            </td>
          </tr>
        </table>

        <p style="margin-top:1.5rem;">
          <a href="${process.env.SITE_URL}/status.html?code=${b.reference_code}"
             style="display:inline-block;background:#c9a227;color:#0a0a0a;
                    padding:0.75rem 2rem;text-decoration:none;border-radius:4px;
                    font-weight:bold;">
            View Appointment &amp; Download Receipt
          </a>
        </p>
        <p style="font-size:0.85rem;color:#999;margin-top:1rem;">
          On the status page, enter your reference code and email to download the receipt.
        </p>
      `)
    }).catch(err => console.error('Approval email failed:', err.message));

    res.json({ success: true, booking: b });

  } catch (err) {
    console.error('Approval error:', err);
    next(err);
  }
});

// ─── Reject booking ──────────────────────────────────────────────────────
app.post('/api/admin/bookings/:id/reject', requireAdmin, async (req, res, next) => {
  const { id } = req.params;
  const { reason } = req.body;

  if (!/^\d+$/.test(id)) {
    return res.status(400).json({ error: 'Invalid booking ID' });
  }

  try {
    const result = await pool.query(
      `UPDATE bookings
       SET status = 'cancelled', rejection_reason = $1
       WHERE id = $2 RETURNING *`,
      [reason || 'Payment could not be verified', id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Booking not found.' });
    }

    const b = result.rows[0];

    transporter.sendMail({
      from: `"${process.env.EMAIL_FROM_NAME}" <${process.env.EMAIL_USER}>`,
      to: b.email,
      subject: 'Booking update — payment could not be verified',
      html: emailWrapper('Payment Not Verified', `
        <p>Hi ${escapeEmail(b.name)},</p>
        <p>Unfortunately we weren't able to verify your payment receipt.</p>
        <p><strong>Reason:</strong> ${escapeEmail(reason) || 'The receipt could not be matched to a received payment.'}</p>
        <p>If you believe this is a mistake, please reply to this email with
        additional details and we'll take another look.</p>
        <p>Reference: <span style="color:#c9a227;font-family:monospace;">${b.reference_code}</span></p>
      `)
    }).catch(err => console.error('Rejection email failed:', err.message));

    res.json({ success: true, booking: b });

  } catch (err) {
    console.error('Rejection error:', err);
    next(err);
  }
});

// ─── Get settings ────────────────────────────────────────────────────────
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

// ─── Update settings ─────────────────────────────────────────────────────
app.patch('/api/admin/settings', requireAdmin, async (req, res) => {
  const updates = req.body;

  if (!updates || typeof updates !== 'object'
      || Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'No settings provided' });
  }

  const ALLOWED_KEYS = [
    'deposit_amount',
    'payment_zelle_enabled',  'payment_zelle_handle',
    'payment_venmo_enabled',  'payment_venmo_handle',
    'payment_paypal_enabled', 'payment_paypal_handle',
    'payment_cashapp_enabled','payment_cashapp_handle'
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

// ═════════════════════════════════════════════════════════════════════════
//  GLOBAL ERROR HANDLER (LAST)
// ═════════════════════════════════════════════════════════════════════════
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);

  if (err && err.name === 'MulterError') {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({
        error: 'File is too large. Maximum size is 10 MB.'
      });
    }
    if (err.code === 'LIMIT_UNEXPECTED_FILE') {
      return res.status(400).json({
        error: 'Unexpected file field.'
      });
    }
    return res.status(400).json({ error: `Upload error: ${err.message}` });
  }

  if (err && err.message === 'Only image files are allowed') {
    return res.status(400).json({
      error: 'Only image files (JPG, PNG, GIF, WebP) are allowed.'
    });
  }

  res.status(500).json({
    error: err.message || 'Something went wrong on the server.'
  });
});

// ─── Start ───────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  initDB().catch(err => {
    console.error('❌ Database init failed:', err);
    process.exit(1);
  });
});
