const express = require('express');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Database ----------
const db = new Database(path.join(__dirname, 'dairy.db'));
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  username TEXT UNIQUE NOT NULL,
  phone TEXT,
  address TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS products(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  unit TEXT,
  emoji TEXT DEFAULT '🥛',
  available INTEGER DEFAULT 1
);
CREATE TABLE IF NOT EXISTS orders(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  note TEXT,
  status TEXT DEFAULT 'Pending',
  seen INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS order_items(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  quantity INTEGER NOT NULL
);
`);

// Seed owner account (passwords are stored hashed, never in plain text)
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin123';
if (!db.prepare("SELECT 1 FROM users WHERE role='admin'").get()) {
  db.prepare("INSERT INTO users(name,username,password_hash,role) VALUES('Owner',?,?,'admin')")
    .run(ADMIN_USER, bcrypt.hashSync(ADMIN_PASS, 10));
  console.log(`Owner account created -> username: ${ADMIN_USER}  password: ${ADMIN_PASS}`);
}

// Seed core dairy products (no prices)
if (!db.prepare('SELECT 1 FROM products').get()) {
  const ins = db.prepare('INSERT INTO products(name,unit,emoji) VALUES(?,?,?)');
  [
    ['Fresh Milk', 'Litre', '🥛'],
    ['Curd', 'Kg', '🥣'],
    ['Paneer', 'Kg', '🧀'],
    ['Butter', 'Kg', '🧈'],
    ['Ghee', 'Kg', '🫙'],
    ['Cheese', 'Kg', '🧀'],
    ['Buttermilk', 'Litre', '🥛'],
    ['Cream', 'Litre', '🍦'],
    ['Lassi', 'Litre', '🥤'],
  ].forEach(p => ins.run(...p));
}

// ---------- Auth (simple in-memory sessions) ----------
const sessions = new Map();

function auth(role) {
  return (req, res, next) => {
    const token = (req.headers.authorization || '').replace('Bearer ', '') || req.query.token;
    const s = sessions.get(token);
    if (!s) return res.status(401).json({ error: 'Please log in' });
    if (role && s.role !== role) return res.status(403).json({ error: 'Not allowed' });
    req.user = s;
    next();
  };
}

app.post('/api/register', (req, res) => {
  const { name, username, phone, address, password } = req.body || {};
  if (!name || !username || !password) return res.status(400).json({ error: 'Name, username and password are required' });
  if (username.trim().length < 3) return res.status(400).json({ error: 'Username must be at least 3 characters' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  if (db.prepare('SELECT 1 FROM users WHERE username=?').get(username.trim().toLowerCase()))
    return res.status(400).json({ error: 'Username already taken' });
  db.prepare("INSERT INTO users(name,username,phone,address,password_hash,role) VALUES(?,?,?,?,?,'user')")
    .run(name.trim(), username.trim().toLowerCase(), (phone || '').trim(), (address || '').trim(), bcrypt.hashSync(password, 10));
  res.json({ ok: true });
});

app.post('/api/login', (req, res) => {
  const { username, password, role } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE username=?').get((username || '').trim().toLowerCase());
  if (!u || !bcrypt.compareSync(password || '', u.password_hash) || (role && u.role !== role))
    return res.status(400).json({ error: 'Invalid username or password' });
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, { id: u.id, role: u.role, name: u.name });
  res.json({ token, role: u.role, name: u.name });
});

app.post('/api/logout', auth(), (req, res) => {
  sessions.delete((req.headers.authorization || '').replace('Bearer ', ''));
  res.json({ ok: true });
});


// ---------- Customer profile ----------
app.get('/api/profile', auth('user'), (req, res) => {
  const user = db.prepare(
    'SELECT name, username, phone, address, created_at FROM users WHERE id=?'
  ).get(req.user.id);
  if (!user) return res.status(404).json({ error: 'Profile not found' });
  res.json(user);
});

// ---------- Products ----------
app.get('/api/products', auth(), (req, res) => {
  const where = req.user.role === 'admin' ? '' : 'WHERE available=1';
  res.json(db.prepare(`SELECT * FROM products ${where} ORDER BY id`).all());
});

app.post('/api/admin/products', auth('admin'), (req, res) => {
  const { name, unit, emoji } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Product name required' });
  try {
    db.prepare('INSERT INTO products(name,unit,emoji) VALUES(?,?,?)')
      .run(name.trim(), (unit || 'Kg').trim(), (emoji || '🥛').trim());
    res.json({ ok: true });
  } catch {
    res.status(400).json({ error: 'Product already exists' });
  }
});

app.patch('/api/admin/products/:id', auth('admin'), (req, res) => {
  db.prepare('UPDATE products SET available=? WHERE id=?').run(req.body.available ? 1 : 0, req.params.id);
  res.json({ ok: true });
});

app.delete('/api/admin/products/:id', auth('admin'), (req, res) => {
  if (db.prepare('SELECT 1 FROM order_items WHERE product_id=?').get(req.params.id)) {
    db.prepare('UPDATE products SET available=0 WHERE id=?').run(req.params.id);
    return res.json({ ok: true, note: 'Has past orders, so it was hidden instead of deleted' });
  }
  db.prepare('DELETE FROM products WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- Orders ----------
function orderList(where, params) {
  const orders = db.prepare(`
    SELECT o.*, u.name AS customer, u.phone, u.address
    FROM orders o JOIN users u ON u.id=o.user_id ${where} ORDER BY o.id DESC`).all(...params);
  const itemStmt = db.prepare(`
    SELECT p.name, p.unit, p.emoji, i.quantity
    FROM order_items i JOIN products p ON p.id=i.product_id WHERE i.order_id=?`);
  orders.forEach(o => (o.items = itemStmt.all(o.id)));
  return orders;
}

// Admin live notifications (Server-Sent Events)
const adminClients = new Set();
app.get('/api/admin/stream', auth('admin'), (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  res.write('retry: 3000\n\n');
  adminClients.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => { clearInterval(ping); adminClients.delete(res); });
});

app.post('/api/orders', auth('user'), (req, res) => {
  const { items, note } = req.body || {};
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'Select at least one product' });
  const find = db.prepare('SELECT id FROM products WHERE id=? AND available=1');
  const clean = [];
  for (const it of items) {
    const qty = Number(it.quantity);
    if (!find.get(it.product_id) || !Number.isInteger(qty) || qty < 1 || qty > 100)
      return res.status(400).json({ error: 'Invalid product or quantity' });
    clean.push({ product_id: it.product_id, quantity: qty });
  }
  const create = db.transaction(() => {
    const { lastInsertRowid } = db.prepare('INSERT INTO orders(user_id,note) VALUES(?,?)')
      .run(req.user.id, (note || '').slice(0, 500));
    const ins = db.prepare('INSERT INTO order_items(order_id,product_id,quantity) VALUES(?,?,?)');
    clean.forEach(c => ins.run(lastInsertRowid, c.product_id, c.quantity));
    return lastInsertRowid;
  });
  const id = create();
  const order = orderList('WHERE o.id=?', [id])[0];
  adminClients.forEach(c => c.write(`event: order\ndata: ${JSON.stringify(order)}\n\n`));
  res.json({ ok: true, id });
});

app.get('/api/orders/mine', auth('user'), (req, res) => {
  res.json(orderList('WHERE o.user_id=?', [req.user.id]));
});

app.get('/api/admin/orders', auth('admin'), (req, res) => {
  res.json(orderList('', []));
});

const STATUSES = ['Pending', 'Accepted', 'Delivered', 'Cancelled'];
app.patch('/api/admin/orders/:id', auth('admin'), (req, res) => {
  if (!STATUSES.includes(req.body.status)) return res.status(400).json({ error: 'Invalid status' });
  db.prepare('UPDATE orders SET status=?, seen=1 WHERE id=?').run(req.body.status, req.params.id);
  res.json({ ok: true });
});

app.post('/api/admin/orders/seen', auth('admin'), (req, res) => {
  db.prepare('UPDATE orders SET seen=1').run();
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Dairy app running at http://localhost:${PORT}`));
