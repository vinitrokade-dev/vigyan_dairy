const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');

const app = express();
app.use(express.json());

// Prevent browsers/proxies from serving stale API data after product changes.
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// ---------- Database (PostgreSQL) ----------
// Set DATABASE_URL to your Postgres connection string (Neon, Supabase, Render Postgres, local...).
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL is not set. Add your Postgres connection string as the DATABASE_URL environment variable.');
  process.exit(1);
}

const isLocalDb = /@(localhost|127\.0\.0\.1)(:|\/|$)/.test(DATABASE_URL);
const pool = new Pool({
  connectionString: DATABASE_URL,
  // Hosted databases (Neon etc.) need SSL; a local one usually does not.
  ssl: isLocalDb || /sslmode=/.test(DATABASE_URL) ? undefined : { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 20000 // allows a sleeping serverless database to wake up
});
// Idle connections can be closed by the database host; without this handler the process would crash.
pool.on('error', error => console.error('Idle database connection error:', error.message));

const query = (text, params) => pool.query(text, params);

async function transaction(work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

// Same text format the pages already expect: "YYYY-MM-DD HH:MM:SS" in UTC.
const NOW_TEXT = "to_char(timezone('utc', now()), 'YYYY-MM-DD HH24:MI:SS')";

// ---------- Product catalog (shown on the home page in this order) ----------
// Photos: put a file named <slug>.jpg in public/images/ (see public/images/README.txt).
const CATALOG = [
  ['Fresh Milk', 'Litre', '🥛'],
  ['Tea', 'Cup', '🍵'],
  ['Coffee', 'Cup', '☕'],
  ['Paneer', '100 gm', '🧀'],
  ['Masala Doodh', 'Cup', '🥛'],
  ['Lassi', 'Cup', '🥤'],
  ['Cold Coffee', 'Cup', '🧋'],
  ['Curd', '100 gm', '🥣'],
  ['Buttermilk', 'Litre', '🥛'],
  ['Candy', 'Cup', '🍬'],
  ['Ice Cream', 'Cup', '🍨'],
  ['Cupcake', 'Cup', '🧁'],
  ['Gulab Jamun', 'Piece', '🍡'],
  ['Peda', '100 gm', '🍮'],
  ['Kalakand', '100 gm', '🍰'],
  ['Basundi', 'Litre', '🍮'],
  ['Chenna', '100 gm', '🥣'],
  ['Kulfi', 'Piece', '🍦'],
  ['Milkshake', 'Cup', '🥤']
];
const slugify = name => String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

const ADMIN_USER = (process.env.ADMIN_USER || 'admin').trim().toLowerCase();
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin123';

async function initDatabase() {
  await query(`
    CREATE TABLE IF NOT EXISTS users(
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      username TEXT UNIQUE NOT NULL,
      phone TEXT,
      address TEXT,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      created_at TEXT DEFAULT (${NOW_TEXT})
    );
    CREATE TABLE IF NOT EXISTS products(
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      unit TEXT,
      emoji TEXT DEFAULT '🥛',
      available INTEGER DEFAULT 1,
      sort_order INTEGER DEFAULT 9999,
      image TEXT
    );
    CREATE TABLE IF NOT EXISTS orders(
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      note TEXT,
      status TEXT DEFAULT 'Pending',
      seen INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (${NOW_TEXT})
    );
    CREATE TABLE IF NOT EXISTS order_items(
      id SERIAL PRIMARY KEY,
      order_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      quantity INTEGER NOT NULL,
      product_name TEXT,
      product_unit TEXT,
      product_emoji TEXT
    );
    CREATE TABLE IF NOT EXISTS sessions(
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      role TEXT NOT NULL,
      name TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS meta(
      key TEXT PRIMARY KEY,
      value TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);
    CREATE INDEX IF NOT EXISTS idx_items_order ON order_items(order_id);
  `);

  // Owner account (passwords are stored hashed). Created only if no admin exists yet.
  const admin = await query("SELECT 1 FROM users WHERE role='admin' LIMIT 1");
  if (!admin.rowCount) {
    await query("INSERT INTO users(name,username,password_hash,role) VALUES('Owner',$1,$2,'admin')",
      [ADMIN_USER, bcrypt.hashSync(ADMIN_PASS, 10)]);
    console.log(`Owner account created for username: ${ADMIN_USER}.`);
  }

  // Seed the catalog once per database, so products you delete later stay deleted.
  await transaction(async client => {
    const marker = await client.query(
      "INSERT INTO meta(key,value) VALUES('catalog_v1','done') ON CONFLICT (key) DO NOTHING RETURNING key");
    if (!marker.rowCount) return;
    for (let i = 0; i < CATALOG.length; i++) {
      const [name, unit, emoji] = CATALOG[i];
      await client.query(
        `INSERT INTO products(name,unit,emoji,image,sort_order) VALUES($1,$2,$3,$4,$5)
         ON CONFLICT (name) DO UPDATE SET unit=EXCLUDED.unit, emoji=EXCLUDED.emoji,
           image=EXCLUDED.image, sort_order=EXCLUDED.sort_order`,
        [name, unit, emoji, `/images/${slugify(name)}.jpg`, i + 1]);
    }
    console.log(`Product catalog seeded (${CATALOG.length} products).`);
  });

  // Remove expired login sessions (older than 30 days).
  await query("DELETE FROM sessions WHERE created_at < now() - interval '30 days'");
}

// Wrap async route handlers so a database error returns a clean 500 instead of hanging.
const wrap = handler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

// ---------- Authentication (sessions are stored in the database, so restarts do not log people out) ----------
function auth(role) {
  return wrap(async (req, res, next) => {
    const token = (req.headers.authorization || '').replace('Bearer ', '') || req.query.token;
    const found = token ? await query('SELECT user_id, role, name FROM sessions WHERE token=$1', [token]) : { rowCount: 0 };

    if (!found.rowCount) return res.status(401).json({ error: 'Please log in' });
    const session = found.rows[0];
    if (role && session.role !== role) return res.status(403).json({ error: 'Not allowed' });

    req.user = { id: session.user_id, role: session.role, name: session.name };
    next();
  });
}

app.post('/api/register', wrap(async (req, res) => {
  const { name, username, phone, address, password } = req.body || {};

  if (!name || !username || !password) {
    return res.status(400).json({ error: 'Name, username and password are required' });
  }
  if (username.trim().length < 3) {
    return res.status(400).json({ error: 'Username must be at least 3 characters' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }

  const clean = username.trim().toLowerCase();
  const taken = await query('SELECT 1 FROM users WHERE username=$1', [clean]);
  if (taken.rowCount) return res.status(400).json({ error: 'Username already taken' });

  try {
    await query("INSERT INTO users(name,username,phone,address,password_hash,role) VALUES($1,$2,$3,$4,$5,'user')",
      [name.trim(), clean, (phone || '').trim(), (address || '').trim(), bcrypt.hashSync(password, 10)]);
  } catch (error) {
    if (error.code === '23505') return res.status(400).json({ error: 'Username already taken' });
    throw error;
  }
  res.json({ ok: true });
}));

app.post('/api/login', wrap(async (req, res) => {
  const { username, password, role } = req.body || {};
  const found = await query('SELECT * FROM users WHERE username=$1', [(username || '').trim().toLowerCase()]);
  const user = found.rows[0];

  if (!user || !bcrypt.compareSync(password || '', user.password_hash) || (role && user.role !== role)) {
    return res.status(400).json({ error: 'Invalid username or password' });
  }

  const token = crypto.randomBytes(24).toString('hex');
  await query('INSERT INTO sessions(token,user_id,role,name) VALUES($1,$2,$3,$4)', [token, user.id, user.role, user.name]);

  res.json({ token, role: user.role, name: user.name });
}));

app.post('/api/logout', auth(), wrap(async (req, res) => {
  await query('DELETE FROM sessions WHERE token=$1', [(req.headers.authorization || '').replace('Bearer ', '')]);
  res.json({ ok: true });
}));

// ---------- Customer profile ----------
app.get('/api/profile', auth('user'), wrap(async (req, res) => {
  const found = await query('SELECT name, username, phone, address, created_at FROM users WHERE id=$1', [req.user.id]);
  if (!found.rowCount) return res.status(404).json({ error: 'Profile not found' });
  res.json(found.rows[0]);
}));

// ---------- Products ----------
app.get('/api/health', wrap(async (req, res) => {
  await query('SELECT 1');
  res.json({ ok: true, database: 'postgres', build: 'postgres-v1-2026-11-21' });
}));

app.get('/api/products', auth(), wrap(async (req, res) => {
  const where = req.user.role === 'admin' ? '' : 'WHERE available=1';
  const found = await query(`SELECT * FROM products ${where} ORDER BY sort_order, id`);
  res.json(found.rows);
}));

app.post('/api/admin/products', auth('admin'), wrap(async (req, res) => {
  const { name, unit, emoji } = req.body || {};

  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Product name required' });
  }

  try {
    await query(
      `INSERT INTO products(name,unit,emoji,image,sort_order)
       VALUES($1,$2,$3,$4,(SELECT COALESCE(MAX(sort_order),0)+1 FROM products WHERE sort_order < 1000))`,
      [name.trim(), (unit || 'Kg').trim(), (emoji || '🥛').trim(), `/images/${slugify(name)}.jpg`]);
    res.json({ ok: true });
  } catch (error) {
    if (error.code === '23505') return res.status(400).json({ error: 'Product already exists' });
    throw error;
  }
}));

app.patch('/api/admin/products/:id', auth('admin'), wrap(async (req, res) => {
  const productId = Number(req.params.id);
  if (!Number.isInteger(productId) || productId < 1) {
    return res.status(400).json({ error: 'Invalid product ID' });
  }
  await query('UPDATE products SET available=$1 WHERE id=$2', [req.body.available ? 1 : 0, productId]);
  res.json({ ok: true });
}));

// Permanently delete a product while preserving historical order details.
app.delete('/api/admin/products/:id', auth('admin'), wrap(async (req, res) => {
  const productId = Number(req.params.id);

  if (!Number.isInteger(productId) || productId < 1) {
    return res.status(400).json({ error: 'Invalid product ID' });
  }

  const deleted = await transaction(async client => {
    const found = await client.query('SELECT name, unit, emoji FROM products WHERE id=$1', [productId]);
    if (!found.rowCount) return false;
    const product = found.rows[0];

    // Make sure every past order line keeps the product's name, unit and emoji.
    await client.query(
      `UPDATE order_items
       SET product_name = COALESCE(product_name, $1),
           product_unit = COALESCE(product_unit, $2),
           product_emoji = COALESCE(product_emoji, $3)
       WHERE product_id=$4`,
      [product.name, product.unit || '', product.emoji || '🥛', productId]);

    await client.query('DELETE FROM products WHERE id=$1', [productId]);
    return true;
  });

  if (!deleted) return res.status(404).json({ error: 'Product not found' });

  res.json({
    ok: true,
    message: 'Product permanently deleted. Past orders are preserved.'
  });
}));

// ---------- Orders ----------
async function orderList(where, params) {
  const orders = (await query(`
    SELECT o.*, u.name AS customer, u.phone, u.address
    FROM orders o
    JOIN users u ON u.id=o.user_id
    ${where}
    ORDER BY o.id DESC
  `, params)).rows;

  if (!orders.length) return orders;

  const items = (await query(`
    SELECT i.order_id,
           COALESCE(i.product_name, p.name, 'Deleted product') AS name,
           COALESCE(i.product_unit, p.unit, '') AS unit,
           COALESCE(i.product_emoji, p.emoji, '🥛') AS emoji,
           i.quantity
    FROM order_items i
    LEFT JOIN products p ON p.id=i.product_id
    WHERE i.order_id = ANY($1::int[])
    ORDER BY i.id
  `, [orders.map(order => order.id)])).rows;

  orders.forEach(order => {
    order.items = items
      .filter(item => item.order_id === order.id)
      .map(({ order_id, ...item }) => item);
  });

  return orders;
}

// ---------- Admin live notifications ----------
const adminClients = new Set();

app.get('/api/admin/stream', auth('admin'), (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });

  res.flushHeaders();
  res.write('retry: 3000\n\n');
  adminClients.add(res);

  const ping = setInterval(() => res.write(': ping\n\n'), 25000);

  req.on('close', () => {
    clearInterval(ping);
    adminClients.delete(res);
  });
});

// ---------- Create order ----------
app.post('/api/orders', auth('user'), wrap(async (req, res) => {
  const { items, note } = req.body || {};

  if (!Array.isArray(items) || !items.length) {
    return res.status(400).json({ error: 'Select at least one product' });
  }

  const clean = [];
  for (const item of items) {
    const productId = Number(item.product_id);
    const quantity = Number(item.quantity);

    if (!Number.isInteger(productId) || productId < 1 || !Number.isInteger(quantity) || quantity < 1 || quantity > 100) {
      return res.status(400).json({ error: 'Invalid product or quantity' });
    }
    clean.push({ product_id: productId, quantity });
  }

  const id = await transaction(async client => {
    // Every product must exist and be available.
    const ids = [...new Set(clean.map(item => item.product_id))];
    const ok = await client.query('SELECT id FROM products WHERE id = ANY($1::int[]) AND available=1', [ids]);
    if (ok.rowCount !== ids.length) return null;

    const created = await client.query(
      'INSERT INTO orders(user_id,note) VALUES($1,$2) RETURNING id',
      [req.user.id, (note || '').slice(0, 500)]);
    const orderId = created.rows[0].id;

    for (const item of clean) {
      await client.query(
        `INSERT INTO order_items(order_id, product_id, quantity, product_name, product_unit, product_emoji)
         SELECT $1, id, $2, name, unit, emoji FROM products WHERE id=$3`,
        [orderId, item.quantity, item.product_id]);
    }
    return orderId;
  });

  if (!id) return res.status(400).json({ error: 'Invalid product or quantity' });

  const order = (await orderList('WHERE o.id=$1', [id]))[0];

  adminClients.forEach(client => {
    client.write(`event: order\ndata: ${JSON.stringify(order)}\n\n`);
  });

  res.json({ ok: true, id });
}));

app.get('/api/orders/mine', auth('user'), wrap(async (req, res) => {
  res.json(await orderList('WHERE o.user_id=$1', [req.user.id]));
}));

app.get('/api/admin/orders', auth('admin'), wrap(async (req, res) => {
  res.json(await orderList('', []));
}));

const STATUSES = ['Pending', 'Accepted', 'Delivered', 'Cancelled'];

app.patch('/api/admin/orders/:id', auth('admin'), wrap(async (req, res) => {
  if (!STATUSES.includes(req.body.status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }

  const orderId = Number(req.params.id);
  if (!Number.isInteger(orderId) || orderId < 1) {
    return res.status(400).json({ error: 'Invalid order ID' });
  }

  await query('UPDATE orders SET status=$1, seen=1 WHERE id=$2', [req.body.status, orderId]);
  res.json({ ok: true });
}));

app.post('/api/admin/orders/seen', auth('admin'), wrap(async (req, res) => {
  await query('UPDATE orders SET seen=1');
  res.json({ ok: true });
}));

// ---------- Errors ----------
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

app.use((error, req, res, next) => {
  console.error('Request failed:', req.method, req.originalUrl, error);
  if (res.headersSent) return next(error);
  res.status(500).json({ error: 'Something went wrong on the server. Please try again.' });
});

// ---------- Start server ----------
const PORT = process.env.PORT || 3000;

initDatabase()
  .then(() => {
    app.listen(PORT, () => console.log(`Dairy app running on port ${PORT} (PostgreSQL).`));
  })
  .catch(error => {
    console.error('Could not start: database setup failed:', error.message);
    process.exit(1);
  });