require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

const app = express();
const prisma = new PrismaClient();
const SECRET = process.env.JWT_SECRET;

app.use(cors());
app.use(express.json());
app.use(express.static('.'));

// ── Auth middleware ──────────────────────────────────────────────────────────
function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Потрібно увійти' });
  try {
    req.user = jwt.verify(token, SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Невірний токен' });
  }
}

function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Тільки для адміна' });
  next();
}

// ── Register ─────────────────────────────────────────────────────────────────
app.post('/api/register', async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password)
    return res.status(400).json({ error: 'Заповни всі поля' });
  if (password.length < 4)
    return res.status(400).json({ error: 'Пароль мінімум 4 символи' });
  try {
    const hash = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: { name, email: email.toLowerCase(), password: hash }
    });
    const token = jwt.sign({ id: user.id, name: user.name, role: user.role }, SECRET);
    res.json({ token, user: { id: user.id, name: user.name, role: user.role } });
  } catch (e) {
    if (e.code === 'P2002') return res.status(400).json({ error: 'Цей email вже зареєстровано' });
    res.status(500).json({ error: 'Помилка сервера' });
  }
});

// ── Login ────────────────────────────────────────────────────────────────────
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  const user = await prisma.user.findUnique({ where: { email: email?.toLowerCase() } });
  if (!user) return res.status(400).json({ error: 'Користувача не знайдено' });
  const ok = await bcrypt.compare(password, user.password);
  if (!ok) return res.status(400).json({ error: 'Невірний пароль' });
  const token = jwt.sign({ id: user.id, name: user.name, role: user.role }, SECRET);
  res.json({ token, user: { id: user.id, name: user.name, role: user.role } });
});

// ── Save result ──────────────────────────────────────────────────────────────
app.post('/api/results', auth, async (req, res) => {
  const { quizId, quizName, score, total, pct, level } = req.body;
  const result = await prisma.result.create({
    data: { userId: req.user.id, quizId, quizName, score, total, pct, level: level || 'senior' }
  });
  res.json(result);
});

// ── My stats ─────────────────────────────────────────────────────────────────
app.get('/api/results/my', auth, async (req, res) => {
  const results = await prisma.result.findMany({
    where: { userId: req.user.id },
    orderBy: { createdAt: 'desc' },
    take: 50
  });
  res.json(results);
});

// ── Admin: all students ───────────────────────────────────────────────────────
app.get('/api/admin/students', auth, adminOnly, async (req, res) => {
  const students = await prisma.user.findMany({
    where: { role: 'student' },
    include: {
      results: { orderBy: { createdAt: 'desc' } }
    },
    orderBy: { createdAt: 'desc' }
  });
  res.json(students.map(s => ({
    id: s.id, name: s.name, email: s.email, createdAt: s.createdAt,
    totalQuizzes: s.results.length,
    avgPct: s.results.length ? Math.round(s.results.reduce((a, r) => a + r.pct, 0) / s.results.length) : 0,
    results: s.results
  })));
});

// ── Admin: create admin user ─────────────────────────────────────────────────
app.post('/api/admin/create', async (req, res) => {
  const { secret, name, email, password } = req.body;
  if (secret !== 'PSYADMIN2026') return res.status(403).json({ error: 'Невірний секрет' });
  const hash = await bcrypt.hash(password, 10);
  try {
    const user = await prisma.user.create({
      data: { name, email: email.toLowerCase(), password: hash, role: 'admin' }
    });
    res.json({ ok: true, id: user.id });
  } catch {
    res.status(400).json({ error: 'Email вже існує' });
  }
});

// ── Serve app ────────────────────────────────────────────────────────────────
app.get('/{*path}', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const PORT = process.env.PORT || 4056;
app.listen(PORT, '::', () => console.log(`Server running on port ${PORT}`));
