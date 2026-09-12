require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Path to the frontend folder (one level up from backend/)
const FRONTEND_DIR = path.join(__dirname, '..', 'frontend');

// ─── PostgreSQL ──────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// ─── Cloudinary ──────────────────────────────────────────────────────────
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// ─── Multer (memory buffer → Cloudinary) ─────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files are allowed'));
  }
});

// ─── Middleware ──────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Serve the frontend folder as static
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
      status TEXT DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  console.log('✅ Database tables ready');
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
    if (data.exp < Date.now()) return res.status(401).json({ error: 'Session expired' });
  } catch {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  next();
}

// ─── Admin Access Gate (URL-only, no login form) ─────────────────────────
// Visit: https://your-site.onrender.com/admin/access?key=YOUR_ADMIN_ACCESS_KEY
app.get('/admin/access', (req, res) => {
  const { key } = req.query;
  if (!key || key !== process.env.ADMIN_ACCESS_KEY) {
    return res.status(404).send('Not found'); // pretend it doesn't exist
  }

  const payload = Buffer.from(JSON.stringify({
    role: 'admin',
    exp: Date.now() + 2 * 60 * 60 * 1000 // 2 hours
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

  res.redirect('/admin.html');
});

// ─── PUBLIC API ──────────────────────────────────────────────────────────

// Gallery photos
app.get('/api/photos', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, title, description, cloudinary_url FROM photos ORDER BY created_at DESC'
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch photos' });
  }
});

// Submit booking
app.post('/api/bookings', async (req, res) => {
  const { name, email, phone, preferred_date, description } = req.body;

  if (!name || !email) {
    return res.status(400).json({ error: 'Name and email are required' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO bookings (name, email, phone, preferred_date, description)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [name, email, phone || null, preferred_date || null, description || null]
    );
    res.status(201).json({ success: true, bookingId: result.rows[0].id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to submit booking' });
  }
});

// ─── PROTECTED ADMIN API ─────────────────────────────────────────────────

// Upload photo
app.post('/api/admin/photos', requireAdmin, upload.single('photo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  try {
    const result = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { folder: 'tattoo-parlor', resource_type: 'image' },
        (error, result) => (error ? reject(error) : resolve(result))
      );
      stream.end(req.file.buffer);
    });

    const { title, description } = req.body;

    const dbResult = await pool.query(
      `INSERT INTO photos (title, description, cloudinary_url, cloudinary_public_id)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [title || 'Untitled', description || '', result.secure_url, result.public_id]
    );

    res.status(201).json(dbResult.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// Delete photo
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

// List bookings
app.get('/api/admin/bookings', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM bookings ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch bookings' });
  }
});

// Update booking status
app.patch('/api/admin/bookings/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  const allowed = ['pending', 'confirmed', 'completed', 'cancelled'];

  if (!allowed.includes(status)) return res.status(400).json({ error: 'Invalid status' });

  try {
    await pool.query('UPDATE bookings SET status = $1 WHERE id = $2', [status, id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Update failed' });
  }
});

// Protect the admin.html page itself
app.get('/admin.html', requireAdmin, (req, res) => {
  res.sendFile(path.join(FRONTEND_DIR, 'admin.html'));
});

// ─── Start ───────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  initDB().catch(err => {
    console.error('❌ Database init failed:', err);
    process.exit(1);
  });
});
