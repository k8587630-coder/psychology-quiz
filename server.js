require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const crypto = require('crypto');
const PDFDocument = require('pdfkit');
const { PrismaClient } = require('@prisma/client');
const { GoogleGenAI } = require('@google/genai');

const app = express();
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const prisma = new PrismaClient();
const SECRET = process.env.JWT_SECRET;
const LIQPAY_PUBLIC  = process.env.LIQPAY_PUBLIC_KEY;
const LIQPAY_PRIVATE = process.env.LIQPAY_PRIVATE_KEY;
const APP_URL = process.env.APP_URL || 'http://localhost:4056';

function liqpayEncode(params) {
  return Buffer.from(JSON.stringify(params)).toString('base64');
}
function liqpaySign(data) {
  return crypto.createHash('sha1').update(LIQPAY_PRIVATE + data + LIQPAY_PRIVATE).digest('base64');
}

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
  if (!name || !password)
    return res.status(400).json({ error: 'Введи імʼя і пароль' });
  if (name.trim().length < 2)
    return res.status(400).json({ error: 'Імʼя занадто коротке (мінімум 2 символи)' });
  if (name.trim().length > 30)
    return res.status(400).json({ error: 'Імʼя занадто довге (максимум 30 символів)' });
  if (!/\p{L}/u.test(name.trim()))
    return res.status(400).json({ error: 'Введи справжнє імʼя або нікнейм' });
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return res.status(400).json({ error: 'Невірний формат email' });
  if (password.length < 4)
    return res.status(400).json({ error: 'Пароль мінімум 4 символи' });
  if (password.length > 64)
    return res.status(400).json({ error: 'Пароль занадто довгий' });
  try {
    const hash = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: { name, email: email ? email.toLowerCase() : null, password: hash }
    });
    const token = jwt.sign({ id: user.id, name: user.name, role: user.role, isPremium: false }, SECRET);
    res.json({ token, user: { id: user.id, name: user.name, role: user.role, isPremium: false } });
  } catch (e) {
    if (e.code === 'P2002') return res.status(400).json({ error: 'Цей email вже зареєстровано' });
    res.status(500).json({ error: 'Помилка сервера' });
  }
});

// ── Login ────────────────────────────────────────────────────────────────────
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Заповни всі поля' });
  // Try by email first, then by name (case-insensitive)
  const isEmail = email.includes('@');
  const user = isEmail
    ? await prisma.user.findUnique({ where: { email: email.toLowerCase() } })
    : await prisma.user.findFirst({ where: { name: { equals: email.trim(), mode: 'insensitive' } } });
  if (!user) return res.status(400).json({ error: 'Користувача не знайдено' });
  if (!user.password) return res.status(400).json({ error: 'Цей акаунт створено без пароля. Використай «Грати без реєстрації»' });
  const ok = await bcrypt.compare(password, user.password);
  if (!ok) return res.status(400).json({ error: 'Невірний пароль' });
  const premium = user.isPremium && (!user.premiumUntil || user.premiumUntil > new Date());
  const token = jwt.sign({ id: user.id, name: user.name, role: user.role, isPremium: premium }, SECRET);
  res.json({ token, user: { id: user.id, name: user.name, role: user.role, isPremium: premium } });
});

// ── Quick login (nickname only) ───────────────────────────────────────────────
app.post('/api/quick-login', async (req, res) => {
  const { name } = req.body;
  if (!name || name.trim().length < 2)
    return res.status(400).json({ error: 'Імʼя мінімум 2 символи' });
  try {
    let user = await prisma.user.findFirst({ where: { name: name.trim(), email: null } });
    if (!user) user = await prisma.user.create({ data: { name: name.trim() } });
    const token = jwt.sign({ id: user.id, name: user.name, role: user.role, isPremium: false }, SECRET);
    res.json({ token, user: { id: user.id, name: user.name, role: user.role, isPremium: false } });
  } catch {
    res.status(500).json({ error: 'Помилка сервера' });
  }
});

// ── Premium status check ──────────────────────────────────────────────────────
app.get('/api/me', auth, async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.user.id } });
  if (!user) return res.status(404).json({ error: 'Не знайдено' });
  const premium = user.isPremium && (!user.premiumUntil || user.premiumUntil > new Date());
  res.json({ id: user.id, name: user.name, role: user.role, isPremium: premium, premiumUntil: user.premiumUntil });
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

// ── Diag results ─────────────────────────────────────────────────────────────
app.post('/api/diag-results', auth, async (req, res) => {
  const { testId, testName, emoji, resultKey, resultName, scores } = req.body;
  const result = await prisma.diagResult.create({
    data: { userId: req.user.id, testId, testName, emoji, resultKey: resultKey || null, resultName, scores: scores || null }
  });
  res.json(result);
});

app.get('/api/diag-results/my', auth, async (req, res) => {
  const results = await prisma.diagResult.findMany({
    where: { userId: req.user.id },
    orderBy: { createdAt: 'desc' }
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
function generateCertificate(res, { name, quizName, pct, date }) {

  const FONT     = path.join(__dirname, 'fonts', 'Regular.ttf');
  const FONT_B   = path.join(__dirname, 'fonts', 'Bold.ttf');

  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 0 });
  doc.registerFont('R',  FONT);
  doc.registerFont('RB', FONT_B);
  const W = 841.89, H = 595.28;
  const CX = W / 2;

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="psyquiz-certificate.pdf"`);
  doc.pipe(res);

  // ── Background ──────────────────────────────────────────────────────────────
  const bgGrad = doc.linearGradient(0, 0, W, H);
  bgGrad.stop(0, '#0a0820').stop(0.5, '#07071a').stop(1, '#080e1f');
  doc.rect(0, 0, W, H).fill(bgGrad);

  // Glow top-left (purple)
  const g1 = doc.radialGradient(140, 110, 0, 140, 110, 300);
  g1.stop(0, '#6d28d9', 0.45).stop(1, '#07071a', 0);
  doc.circle(140, 110, 300).fill(g1);

  // Glow bottom-right (cyan)
  const g2 = doc.radialGradient(700, 480, 0, 700, 480, 260);
  g2.stop(0, '#0891b2', 0.35).stop(1, '#07071a', 0);
  doc.circle(700, 480, 260).fill(g2);

  // Glow center (pink, subtle)
  const g3 = doc.radialGradient(CX, H / 2, 0, CX, H / 2, 180);
  g3.stop(0, '#9333ea', 0.08).stop(1, '#07071a', 0);
  doc.circle(CX, H / 2, 180).fill(g3);

  // ── Decorative dot grid (subtle) ─────────────────────────────────────────
  doc.fillColor('#ffffff', 0.025);
  for (let x = 40; x < W; x += 28) {
    for (let y = 40; y < H; y += 28) {
      doc.circle(x, y, 1).fill();
    }
  }

  // ── Outer border (double) ────────────────────────────────────────────────
  doc.roundedRect(18, 18, W - 36, H - 36, 22)
     .lineWidth(2).strokeColor('#7c3aed', 0.7).stroke();
  doc.roundedRect(26, 26, W - 52, H - 52, 18)
     .lineWidth(0.8).strokeColor('#a78bfa', 0.3).stroke();

  // ── Corner ornaments ──────────────────────────────────────────────────────
  function cornerOrnament(cx, cy, rot) {
    doc.save();
    doc.translate(cx, cy).rotate(rot);
    // L-shape lines
    doc.moveTo(0, 0).lineTo(36, 0).lineWidth(2).strokeColor('#7c3aed', 0.9).stroke();
    doc.moveTo(0, 0).lineTo(0, 36).lineWidth(2).strokeColor('#7c3aed', 0.9).stroke();
    // small diamond
    doc.save().translate(0, 0).rotate(45)
       .rect(-5, -5, 10, 10).fillColor('#a78bfa', 0.8).fill()
       .restore();
    doc.restore();
  }
  cornerOrnament(32, 32, 0);
  cornerOrnament(W - 32, 32, 90);
  cornerOrnament(W - 32, H - 32, 180);
  cornerOrnament(32, H - 32, 270);

  // ── Left stripe accent ───────────────────────────────────────────────────
  const stripeGrad = doc.linearGradient(0, 80, 0, H - 80);
  stripeGrad.stop(0, '#6d28d9', 0).stop(0.5, '#7c3aed', 0.9).stop(1, '#6d28d9', 0);
  doc.rect(0, 80, 6, H - 160).fill(stripeGrad);

  // Right stripe
  const stripeGrad2 = doc.linearGradient(0, 80, 0, H - 80);
  stripeGrad2.stop(0, '#0891b2', 0).stop(0.5, '#06b6d4', 0.7).stop(1, '#0891b2', 0);
  doc.rect(W - 6, 80, 6, H - 160).fill(stripeGrad2);

  // ── Header section ────────────────────────────────────────────────────────
  // "PsyQuiz" logo
  doc.fontSize(13).font('RB').fillColor('#a78bfa', 0.9)
     .text('PSY', 0, 52, { align: 'center', continued: true, characterSpacing: 4 });
  doc.fillColor('#06b6d4', 0.9)
     .text('QUIZ', { characterSpacing: 4 });

  // Divider with diamonds
  const dY = 82;
  doc.moveTo(160, dY).lineTo(CX - 60, dY).lineWidth(0.8).strokeColor('#7c3aed', 0.5).stroke();
  doc.moveTo(CX + 60, dY).lineTo(W - 160, dY).lineWidth(0.8).strokeColor('#7c3aed', 0.5).stroke();
  // center diamond
  doc.save().translate(CX, dY).rotate(45).rect(-5, -5, 10, 10).fillColor('#a78bfa').fill().restore();
  // side diamonds
  [-48, 48].forEach(dx => {
    doc.save().translate(CX + dx, dY).rotate(45).rect(-3, -3, 6, 6).fillColor('#7c3aed', 0.6).fill().restore();
  });

  // Subtitle
  doc.fontSize(9).font('R').fillColor('#8888b0', 0.8)
     .text('С Е Р Т И Ф І К А Т   П Р О   П Р О Х О Д Ж Е Н Н Я', 0, 94, { align: 'center', characterSpacing: 2 });

  // ── Main content ─────────────────────────────────────────────────────────
  doc.fontSize(13).font('R').fillColor('#8888b0')
     .text('Цим підтверджується, що', 0, 122, { align: 'center' });

  // Name with glow effect (fake — layered text)
  doc.fontSize(38).font('RB').fillColor('#a78bfa', 0.15)
     .text(name, 2, 146, { align: 'center' });
  doc.fontSize(38).font('RB').fillColor('#e2d9fa')
     .text(name, 0, 144, { align: 'center' });

  // Name underline (gradient-like with two lines)
  const nw = Math.min(doc.widthOfString(name, { fontSize: 38 }) + 60, 520);
  const nx = CX - nw / 2;
  doc.moveTo(nx, 193).lineTo(CX, 193).lineWidth(1.5).strokeColor('#7c3aed', 0.7).stroke();
  doc.moveTo(CX, 193).lineTo(nx + nw, 193).lineWidth(1.5).strokeColor('#06b6d4', 0.7).stroke();

  doc.fontSize(13).font('R').fillColor('#8888b0')
     .text('успішно пройшов(ла) квіз з психології', 0, 204, { align: 'center' });

  // Quiz name box
  const qnW = Math.min(doc.widthOfString(quizName, { fontSize: 20 }) + 60, 500);
  const qnX = CX - qnW / 2;
  const qnY = 228;
  doc.roundedRect(qnX, qnY, qnW, 38, 8)
     .fillColor('#7c3aed', 0.12).fill();
  doc.roundedRect(qnX, qnY, qnW, 38, 8)
     .lineWidth(0.8).strokeColor('#7c3aed', 0.5).stroke();
  doc.fontSize(18).font('RB').fillColor('#c4b5fd')
     .text(`«${quizName}»`, qnX, qnY + 10, { width: qnW, align: 'center' });

  // ── Score seal (right side) ────────────────────────────────────────────
  const sealX = W - 160, sealY = H / 2 - 10;
  const sealR = 68;

  // Outer glow ring
  const sealGlow = doc.radialGradient(sealX, sealY, sealR - 10, sealX, sealY, sealR + 20);
  sealGlow.stop(0, '#7c3aed', 0.3).stop(1, '#07071a', 0);
  doc.circle(sealX, sealY, sealR + 20).fill(sealGlow);

  // Dashed outer ring (simulated with segments)
  for (let i = 0; i < 36; i++) {
    const a1 = (i / 36) * Math.PI * 2;
    const a2 = ((i + 0.6) / 36) * Math.PI * 2;
    const r = sealR + 8;
    doc.moveTo(sealX + Math.cos(a1) * r, sealY + Math.sin(a1) * r)
       .lineTo(sealX + Math.cos(a2) * r, sealY + Math.sin(a2) * r)
       .lineWidth(1.5).strokeColor('#7c3aed', 0.5).stroke();
  }

  // Main circle background
  const sealFill = doc.radialGradient(sealX - 20, sealY - 20, 5, sealX, sealY, sealR);
  sealFill.stop(0, '#4c1d95').stop(1, '#1e1b4b');
  doc.circle(sealX, sealY, sealR).fill(sealFill);
  doc.circle(sealX, sealY, sealR).lineWidth(2).strokeColor('#7c3aed', 0.8).stroke();

  // Inner ring
  doc.circle(sealX, sealY, sealR - 8).lineWidth(0.8).strokeColor('#a78bfa', 0.3).stroke();

  // Score number
  const scoreColor = pct >= 90 ? '#fbbf24' : pct >= 70 ? '#a78bfa' : '#06b6d4';
  doc.fontSize(34).font('RB').fillColor(scoreColor)
     .text(`${pct}%`, sealX - sealR, sealY - 20, { width: sealR * 2, align: 'center' });

  // Result label inside seal
  const resultLabel = pct >= 90 ? 'ВІДМІННО' : pct >= 70 ? 'ЧУДОВО' : 'ЗАРАХОВАНО';
  doc.fontSize(8).font('RB').fillColor('#8888b0', 0.9)
     .text(resultLabel, sealX - sealR, sealY + 20, { width: sealR * 2, align: 'center', characterSpacing: 1.5 });

  // Stars in seal
  const starY = sealY - 36;
  [-12, 0, 12].forEach((dx, i) => {
    const starCol = i === 1 ? scoreColor : '#6d28d9';
    doc.fontSize(10).fillColor(starCol).text('★', sealX + dx - 5, starY, { lineBreak: false });
  });

  // ── Bottom divider ────────────────────────────────────────────────────────
  const bdY = H - 90;
  doc.moveTo(60, bdY).lineTo(W - 60, bdY).lineWidth(0.5).strokeColor('#ffffff', 0.07).stroke();

  // ── Footer ────────────────────────────────────────────────────────────────
  const certDate = date
    ? new Date(date).toLocaleDateString('uk-UA', { year: 'numeric', month: 'long', day: 'numeric' })
    : new Date().toLocaleDateString('uk-UA', { year: 'numeric', month: 'long', day: 'numeric' });

  const verifyCode = `PSQ-${String(pct).padStart(3,'0')}-${Date.now().toString(36).slice(-5).toUpperCase()}`;

  doc.fontSize(9).font('R').fillColor('#555580')
     .text(`Дата видачі: ${certDate}`, 60, H - 68)
     .text(`Код: ${verifyCode}`, 60, H - 54);

  doc.fontSize(9).font('R').fillColor('#555580')
     .text('katerynap.vibe.brobots.org.ua', W - 280, H - 68, { width: 220, align: 'right' })
     .text('Психологічні квізи · PsyQuiz', W - 280, H - 54, { width: 220, align: 'right' });

  // Center footer — star row
  ['✦', '★', '✦'].forEach((s, i) => {
    doc.fontSize(10).fillColor('#7c3aed', 0.5)
       .text(s, CX - 18 + i * 18, H - 62, { lineBreak: false });
  });

  doc.end();
}

// GET — відкривається прямо в браузері або завантажується як файл
app.get('/api/certificate', (req, res) => {
  const { name, quizName: q, pct, date } = req.query;
  if (!name || !q || !pct) return res.status(400).send('Відсутні дані');
  generateCertificate(res, { name, quizName: q, pct: parseInt(pct), date });
});

// POST — залишаємо для сумісності
app.post('/api/certificate', (req, res) => {
  const { name, quizName, pct, date } = req.body;
  if (!name || !quizName || pct == null) return res.status(400).json({ error: 'Відсутні дані' });
  generateCertificate(res, { name, quizName, pct, date });
});

// ── LiqPay: create payment ────────────────────────────────────────────────────
app.post('/api/payment/create', auth, (req, res) => {
  const { plan } = req.body; // 'monthly' | 'class'
  const amount = plan === 'class' ? 799 : 149;
  const description = plan === 'class' ? 'PsyQuiz — Для класу (1 місяць)' : 'PsyQuiz Преміум (1 місяць)';

  const params = {
    public_key:  LIQPAY_PUBLIC,
    version:     '3',
    action:      'pay',
    amount,
    currency:    'UAH',
    description,
    order_id:    `psyquiz_${req.user.id}_${Date.now()}`,
    result_url:  `${APP_URL}/app?payment=success`,
    server_url:  `${APP_URL}/api/payment/callback`,
  };

  const data = liqpayEncode(params);
  const signature = liqpaySign(data);
  res.json({ data, signature });
});

// ── LiqPay: payment callback (webhook) ───────────────────────────────────────
app.post('/api/payment/callback', express.urlencoded({ extended: true }), async (req, res) => {
  const { data, signature } = req.body;
  if (!data || !signature) return res.sendStatus(400);

  const expectedSig = liqpaySign(data);
  if (expectedSig !== signature) return res.sendStatus(403);

  const payload = JSON.parse(Buffer.from(data, 'base64').toString('utf-8'));
  if (payload.status !== 'success' && payload.status !== 'sandbox') return res.sendStatus(200);

  // order_id format: psyquiz_{userId}_{timestamp}
  const userId = parseInt(payload.order_id?.split('_')[1]);
  if (!userId) return res.sendStatus(400);

  const premiumUntil = new Date();
  premiumUntil.setMonth(premiumUntil.getMonth() + 1);

  await prisma.user.update({
    where: { id: userId },
    data: { isPremium: true, premiumUntil }
  });

  res.sendStatus(200);
});

// ── Admin: grant premium manually ────────────────────────────────────────────
app.post('/api/admin/premium', auth, adminOnly, async (req, res) => {
  const { userId, months } = req.body;
  const until = new Date();
  until.setMonth(until.getMonth() + (months || 1));
  const user = await prisma.user.update({
    where: { id: userId },
    data: { isPremium: true, premiumUntil: until }
  });
  res.json({ ok: true, premiumUntil: user.premiumUntil });
});

// ── Add email to existing account ────────────────────────────────────────────
app.post('/api/user/add-email', auth, async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Введи email' });
  try {
    const user = await prisma.user.update({
      where: { id: req.user.id },
      data: { email: email.toLowerCase() }
    });
    res.json({ ok: true, email: user.email });
  } catch (e) {
    if (e.code === 'P2002') return res.status(400).json({ error: 'Цей email вже використовується' });
    res.status(500).json({ error: 'Помилка сервера' });
  }
});

// ── Serve pages ──────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'landing.html')));
app.get('/app', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/share', (req, res) => {
  const { n: name, q: quizName, p, d } = req.query;
  if (!name || !quizName || !p) {
    return res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>PsyQuiz</title></head>
      <body style="background:#07071a;color:#f0f0ff;font-family:sans-serif;text-align:center;padding:80px">
      <h2>❌ Посилання недійсне</h2></body></html>`);
  }

  const pct = parseInt(p);
  const scoreColor = pct >= 90 ? '#fbbf24' : pct >= 70 ? '#a78bfa' : '#06b6d4';
  const resultLabel = pct >= 90 ? 'ВІДМІННО' : pct >= 70 ? 'ЧУДОВО' : 'ЗАРАХОВАНО';
  const starsHtml = pct >= 90 ? '★★★' : pct >= 70 ? '★★☆' : '★☆☆';
  const certDate = d
    ? new Date(d).toLocaleDateString('uk-UA', { year: 'numeric', month: 'long', day: 'numeric' })
    : new Date().toLocaleDateString('uk-UA', { year: 'numeric', month: 'long', day: 'numeric' });

  const shareUrl = `${APP_URL}/share?n=${encodeURIComponent(name)}&q=${encodeURIComponent(quizName)}&p=${pct}&d=${d || ''}`;
  const shareText = encodeURIComponent(`Я набрав(ла) ${pct}% у квізі «${quizName}» на PsyQuiz! 🧠`);
  const shareUrlEnc = encodeURIComponent(shareUrl);

  const nameEsc = name.replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const quizEsc = quizName.replace(/</g,'&lt;').replace(/>/g,'&gt;');

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="uk">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${nameEsc} — Сертифікат PsyQuiz</title>
  <meta property="og:title" content="${nameEsc} — ${pct}% з «${quizEsc}» | PsyQuiz">
  <meta property="og:description" content="Перевір свої знання з психології на PsyQuiz!">
  <meta name="twitter:card" content="summary">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800;900&display=swap" rel="stylesheet">
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:'Inter',sans-serif;background:#07071a;color:#f0f0ff;min-height:100vh;display:flex;flex-direction:column;align-items:center;overflow-x:hidden}
    .aurora{position:fixed;inset:0;z-index:0;pointer-events:none;overflow:hidden}
    .orb{position:absolute;border-radius:50%;filter:blur(110px);animation:drift 28s ease-in-out infinite}
    .orb:nth-child(1){width:600px;height:600px;background:radial-gradient(circle,#7f5af0,transparent 70%);top:-200px;left:-200px;opacity:.3}
    .orb:nth-child(2){width:500px;height:500px;background:radial-gradient(circle,#06b6d4,transparent 70%);bottom:-100px;right:-100px;opacity:.2;animation-delay:-9s}
    @keyframes drift{0%,100%{transform:translate(0,0)}33%{transform:translate(70px,-90px)}66%{transform:translate(-50px,70px)}}
    .wrap{position:relative;z-index:1;width:100%;max-width:660px;padding:28px 20px 60px}
    .topnav{display:flex;justify-content:center;padding:16px 0 28px}
    .logo{font-size:1.4rem;font-weight:900;letter-spacing:-.04em;background:linear-gradient(135deg,#7f5af0,#06b6d4);-webkit-background-clip:text;-webkit-text-fill-color:transparent;text-decoration:none}
    .card{background:linear-gradient(135deg,rgba(127,90,240,.12),rgba(6,182,212,.06));border:1px solid rgba(127,90,240,.35);border-radius:28px;padding:44px 36px 36px;text-align:center;box-shadow:0 0 80px rgba(127,90,240,.15),0 24px 64px rgba(0,0,0,.4);position:relative}
    .card::before{content:'✦';position:absolute;top:18px;left:22px;font-size:1.1rem;color:rgba(127,90,240,.4)}
    .card::after{content:'✦';position:absolute;bottom:18px;right:22px;font-size:1.1rem;color:rgba(127,90,240,.4)}
    .badge{display:inline-flex;align-items:center;gap:6px;padding:6px 18px;border-radius:100px;margin-bottom:24px;background:linear-gradient(135deg,#7f5af0,#5b21b6);font-size:.8rem;font-weight:800;color:#fff;letter-spacing:.05em}
    .lbl{font-size:.85rem;color:#8888b0;margin-bottom:6px;letter-spacing:.05em;text-transform:uppercase}
    .uname{font-size:clamp(1.8rem,6vw,2.8rem);font-weight:900;letter-spacing:-.04em;line-height:1.1;margin-bottom:8px}
    .divider{display:flex;align-items:center;gap:12px;margin:18px 0}
    .divider hr{flex:1;border:none;border-top:1px solid rgba(127,90,240,.25)}
    .divider span{color:#a78bfa}
    .passed{font-size:1rem;color:#8888b0;margin-bottom:10px}
    .qname{display:inline-block;padding:10px 24px;border-radius:14px;background:rgba(127,90,240,.12);border:1px solid rgba(127,90,240,.3);font-size:1.1rem;font-weight:800;color:#a78bfa;margin-bottom:28px;max-width:100%}
    .seal-wrap{display:flex;justify-content:center;margin-bottom:24px}
    .seal{width:120px;height:120px;border-radius:50%;background:linear-gradient(135deg,#4c1d95,#1e1b4b);border:2px solid rgba(127,90,240,.7);display:flex;flex-direction:column;align-items:center;justify-content:center;box-shadow:0 0 40px rgba(127,90,240,.4);position:relative}
    .seal::before{content:'';position:absolute;inset:-10px;border-radius:50%;border:1.5px dashed rgba(127,90,240,.35)}
    .seal-stars{font-size:.75rem;margin-bottom:2px}
    .seal-pct{font-size:2.4rem;font-weight:900;letter-spacing:-.05em;line-height:1}
    .seal-lbl{font-size:.6rem;font-weight:700;letter-spacing:.12em;color:rgba(255,255,255,.5);margin-top:2px}
    .cdate{font-size:.82rem;color:#8888b0}
    .share-section{margin-top:32px}
    .share-title{font-size:.82rem;color:#8888b0;text-align:center;margin-bottom:12px;text-transform:uppercase;letter-spacing:.06em}
    .share-btns{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px}
    .sbtn{display:flex;align-items:center;justify-content:center;gap:8px;padding:13px;border-radius:14px;font-weight:800;font-size:.88rem;text-decoration:none;transition:opacity .2s}
    .sbtn:hover{opacity:.8}
    .tg{background:rgba(0,136,204,.18);border:1px solid rgba(0,136,204,.35);color:#38bdf8}
    .tw{background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.14);color:#f0f0ff}
    .fb{background:rgba(24,119,242,.18);border:1px solid rgba(24,119,242,.35);color:#60a5fa}
    .vb{background:rgba(127,90,240,.18);border:1px solid rgba(127,90,240,.35);color:#a78bfa}
    .copy-row{display:flex;gap:8px}
    .copy-inp{flex:1;padding:10px 14px;border-radius:12px;font-size:.8rem;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);color:#f0f0ff;outline:none}
    .copy-btn{padding:10px 18px;border-radius:12px;border:none;cursor:pointer;background:rgba(127,90,240,.3);color:#a78bfa;font-weight:700;font-size:.8rem;white-space:nowrap}
    .cta{margin-top:28px;padding:24px;border-radius:20px;text-align:center;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07)}
    .cta p{color:#8888b0;font-size:.9rem;margin-bottom:14px}
    .cta-btn{display:inline-block;padding:13px 32px;border-radius:14px;background:linear-gradient(135deg,#7f5af0,#5b21b6);color:#fff;font-weight:800;font-size:.95rem;text-decoration:none;box-shadow:0 4px 20px rgba(127,90,240,.4)}
    @media(max-width:480px){.card{padding:32px 20px 28px}}
  </style>
</head>
<body>
<div class="aurora"><div class="orb"></div><div class="orb"></div></div>
<div class="wrap">
  <div class="topnav"><a href="/" class="logo">PsyQuiz</a></div>

  <div class="card">
    <div class="badge">🎓 СЕРТИФІКАТ</div>
    <div class="lbl">Цей сертифікат підтверджує, що</div>
    <div class="uname">${nameEsc}</div>
    <div class="divider"><hr><span>✦</span><hr></div>
    <div class="passed">успішно пройшов(ла) квіз</div>
    <div class="qname">«${quizEsc}»</div>
    <div class="seal-wrap">
      <div class="seal">
        <div class="seal-stars" style="color:${scoreColor}">${starsHtml}</div>
        <div class="seal-pct" style="color:${scoreColor}">${pct}%</div>
        <div class="seal-lbl">${resultLabel}</div>
      </div>
    </div>
    <div class="cdate">📅 ${certDate}</div>
  </div>

  <div class="share-section">
    <div class="share-title">Поділитись результатом</div>
    <div class="share-btns">
      <a class="sbtn tg" href="https://t.me/share/url?url=${shareUrlEnc}&text=${shareText}" target="_blank">✈️ Telegram</a>
      <a class="sbtn tw" href="https://twitter.com/intent/tweet?text=${shareText}&url=${shareUrlEnc}" target="_blank">𝕏 Twitter</a>
      <a class="sbtn fb" href="https://www.facebook.com/sharer/sharer.php?u=${shareUrlEnc}" target="_blank">👤 Facebook</a>
      <a class="sbtn vb" href="viber://forward?text=${shareText}%20${shareUrlEnc}" target="_blank">💬 Viber</a>
    </div>
    <div class="copy-row">
      <input class="copy-inp" id="ci" readonly value="${shareUrl.replace(/"/g,'&quot;')}">
      <button class="copy-btn" onclick="navigator.clipboard.writeText(document.getElementById('ci').value).then(()=>{this.textContent='✅ OK';setTimeout(()=>this.textContent='Копіювати',2000)})">Копіювати</button>
    </div>
  </div>

  <div class="cta">
    <p>Хочеш перевірити свої знання з психології? 🧠</p>
    <a href="/app" class="cta-btn">Спробувати квіз безкоштовно →</a>
  </div>
</div>
</body>
</html>`);
});
app.get('/{*path}', (req, res) => res.sendFile(path.join(__dirname, 'landing.html')));

// ── Gemini: generate quiz from lesson ────────────────────────────────────────
app.post('/api/generate-quiz', async (req, res) => {
  const { lessonTitle, lessonText } = req.body;
  if (!lessonTitle || !lessonText)
    return res.status(400).json({ error: 'Потрібні lessonTitle і lessonText' });

  const prompt = `Ти — вчитель психології. На основі цього уроку створи 5 тестових питань українською мовою.

Урок: "${lessonTitle}"
Текст: ${lessonText}

Поверни ТІЛЬКИ JSON масив без зайвого тексту:
[
  {
    "q": "Текст питання",
    "opts": ["Варіант А", "Варіант Б", "Варіант В", "Варіант Г"],
    "ans": 0,
    "info": "Коротке пояснення правильної відповіді"
  }
]

Правила:
- ans — індекс правильної відповіді (0-3)
- питання мають бути різноманітними і цікавими
- варіанти відповідей — правдоподібні, не очевидні`;

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-3.1-flash-lite-preview',
      contents: prompt,
    });
    // strip markdown code fences and extract JSON array
    let text = response.text.trim().replace(/```json\n?|```/g, '').trim();
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    if (start === -1 || end === -1) throw new Error('No JSON array in response');
    text = text.slice(start, end + 1);
    const questions = JSON.parse(text);
    res.json({ questions });
  } catch (e) {
    console.error('Gemini error:', e.message);
    res.status(500).json({ error: 'Не вдалось згенерувати питання: ' + e.message });
  }
});

const PORT = process.env.PORT || 4056;
app.listen(PORT, '::', () => console.log(`Server running on port ${PORT}`));
