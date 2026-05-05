require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const PDFDocument = require('pdfkit');
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

// ── Quick login (nickname only) ───────────────────────────────────────────────
app.post('/api/quick-login', async (req, res) => {
  const { name } = req.body;
  if (!name || name.trim().length < 2)
    return res.status(400).json({ error: 'Імʼя мінімум 2 символи' });
  try {
    let user = await prisma.user.findFirst({ where: { name: name.trim(), email: null } });
    if (!user) user = await prisma.user.create({ data: { name: name.trim() } });
    const token = jwt.sign({ id: user.id, name: user.name, role: user.role }, SECRET);
    res.json({ token, user: { id: user.id, name: user.name, role: user.role } });
  } catch {
    res.status(500).json({ error: 'Помилка сервера' });
  }
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

// ── Certificate PDF ──────────────────────────────────────────────────────────
app.post('/api/certificate', (req, res) => {
  const { name, quizName, pct, date } = req.body;
  if (!name || !quizName || pct == null) return res.status(400).json({ error: 'Відсутні дані' });

  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 0 });
  const W = 841.89, H = 595.28;

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="psyquiz-certificate.pdf"`);
  doc.pipe(res);

  // Dark background
  doc.rect(0, 0, W, H).fill('#07071a');

  // Purple glow top-left
  const glowTL = doc.radialGradient(160, 130, 10, 160, 130, 260);
  glowTL.stop(0, '#7f5af0', 0.35).stop(1, '#07071a', 0);
  doc.circle(160, 130, 260).fill(glowTL);

  // Cyan glow bottom-right
  const glowBR = doc.radialGradient(680, 460, 10, 680, 460, 220);
  glowBR.stop(0, '#06b6d4', 0.25).stop(1, '#07071a', 0);
  doc.circle(680, 460, 220).fill(glowBR);

  // Outer border
  doc.roundedRect(24, 24, W - 48, H - 48, 20)
     .lineWidth(1.5).strokeColor('#7f5af0', 0.5).stroke();

  // Inner border
  doc.roundedRect(34, 34, W - 68, H - 68, 16)
     .lineWidth(0.5).strokeColor('#a78bfa', 0.2).stroke();

  // Header label
  doc.fontSize(11).fillColor('#a78bfa')
     .font('Helvetica-Bold')
     .text('СЕРТИФІКАТ ПРО ПРОХОДЖЕННЯ', 0, 72, { align: 'center', characterSpacing: 3 });

  // Decorative line
  doc.moveTo(300, 100).lineTo(540, 100).lineWidth(1).strokeColor('#7f5af0', 0.5).stroke();

  // Main title
  doc.fontSize(48).fillColor('#f0f0ff')
     .font('Helvetica-Bold')
     .text('PsyQuiz', 0, 116, { align: 'center' });

  // "Підтверджує що" text
  doc.fontSize(14).fillColor('#8888b0')
     .font('Helvetica')
     .text('цей сертифікат підтверджує, що', 0, 182, { align: 'center' });

  // User name
  doc.fontSize(36).fillColor('#f0f0ff')
     .font('Helvetica-Bold')
     .text(name, 0, 208, { align: 'center' });

  // Name underline
  const nameWidth = Math.min(doc.widthOfString(name, { fontSize: 36 }) + 40, 500);
  const nameX = (W - nameWidth) / 2;
  doc.moveTo(nameX, 254).lineTo(nameX + nameWidth, 254)
     .lineWidth(1).strokeColor('#a78bfa', 0.4).stroke();

  // "успішно пройшов(ла)"
  doc.fontSize(14).fillColor('#8888b0')
     .font('Helvetica')
     .text('успішно пройшов(ла) квіз', 0, 268, { align: 'center' });

  // Quiz name
  doc.fontSize(22).fillColor('#a78bfa')
     .font('Helvetica-Bold')
     .text(`«${quizName}»`, 0, 296, { align: 'center' });

  // Score badge background
  const badgeX = W / 2 - 70, badgeY = 340;
  doc.roundedRect(badgeX, badgeY, 140, 52, 26)
     .fill('#7f5af0', 0.2);
  doc.roundedRect(badgeX, badgeY, 140, 52, 26)
     .lineWidth(1).strokeColor('#7f5af0', 0.6).stroke();

  // Score text
  doc.fontSize(28).fillColor('#a78bfa')
     .font('Helvetica-Bold')
     .text(`${pct}%`, badgeX, badgeY + 12, { width: 140, align: 'center' });

  // Result label
  const resultLabel = pct >= 90 ? 'Відмінно' : pct >= 70 ? 'Добре' : 'Зараховано';
  doc.fontSize(11).fillColor('#8888b0')
     .font('Helvetica')
     .text(resultLabel, badgeX, badgeY + 56, { width: 140, align: 'center' });

  // Date and footer
  const certDate = date ? new Date(date).toLocaleDateString('uk-UA', { year:'numeric', month:'long', day:'numeric' }) : new Date().toLocaleDateString('uk-UA', { year:'numeric', month:'long', day:'numeric' });
  doc.fontSize(10).fillColor('#8888b0')
     .font('Helvetica')
     .text(`Дата видачі: ${certDate}`, 60, H - 60)
     .text('psyquiz.com.ua', W - 200, H - 60, { width: 140, align: 'right' });

  // Stars decoration
  ['★', '★', '★'].forEach((s, i) => {
    doc.fontSize(14).fillColor('#7f5af0', 0.6)
       .text(s, W / 2 - 22 + i * 22, H - 65, { continued: false });
  });

  doc.end();
});

// ── Serve pages ──────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'landing.html')));
app.get('/app', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/{*path}', (req, res) => res.sendFile(path.join(__dirname, 'landing.html')));

const PORT = process.env.PORT || 4056;
app.listen(PORT, '::', () => console.log(`Server running on port ${PORT}`));
