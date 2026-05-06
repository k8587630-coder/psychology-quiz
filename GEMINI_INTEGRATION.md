# Інтеграція Gemini — Генерація квізу з уроків

## Мета
Учень читає урок → натискає "Перевірити знання" → Gemini генерує 5 питань на основі тексту уроку → учень відповідає і бачить результат.

---

## Крок 1 — Встановити пакет

```bash
npm install @google/genai
```

---

## Крок 2 — Додати ключ в `.env`

```env
GEMINI_API_KEY=AIzaSyDZtg7PzJT8_zhl0ZGcm9Q_OexTySO5pYE
```

---

## Крок 3 — Новий endpoint в `server.js`

```js
const { GoogleGenAI } = require('@google/genai');
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// POST /api/generate-quiz
// body: { lessonTitle, lessonText }
// response: { questions: [{q, opts, ans, info}] }
app.post('/api/generate-quiz', async (req, res) => {
  const { lessonTitle, lessonText } = req.body;

  const prompt = `
Ти — вчитель психології. На основі цього уроку створи 5 тестових питань українською мовою.

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
- питання мають бути різноманітними
- варіанти відповідей — правдоподібні, не очевидні
`;

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.0-flash-lite-preview-02-05',
      contents: prompt,
    });

    const text = response.text.trim().replace(/```json|```/g, '');
    const questions = JSON.parse(text);
    res.json({ questions });
  } catch (e) {
    console.error('Gemini error:', e);
    res.status(500).json({ error: 'Не вдалось згенерувати питання' });
  }
});
```

---

## Крок 4 — Зміни в `index.html`

### 4.1 — Кнопка "Перевірити знання" в екрані уроку

Після тексту уроку додати:
```html
<button id="genQuizBtn" class="btn-primary" onclick="generateLessonQuiz()">
  🤖 Перевірити знання з Gemini
</button>
<div id="genQuizLoading" style="display:none; color:#8888b0; margin-top:12px;">
  ✨ Gemini генерує питання...
</div>
```

### 4.2 — JS функція `generateLessonQuiz()`

```js
async function generateLessonQuiz() {
  const lessonTitle = document.getElementById('lessonTitle').textContent;
  const lessonText  = document.getElementById('lessonBody').textContent;

  document.getElementById('genQuizLoading').style.display = 'block';
  document.getElementById('genQuizBtn').disabled = true;

  try {
    const res = await fetch('/api/generate-quiz', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lessonTitle, lessonText })
    });
    const data = await res.json();

    // Запустити квіз з цими питаннями
    startGeneratedQuiz(lessonTitle, data.questions);
  } catch (e) {
    alert('Помилка генерації. Спробуй ще раз.');
  } finally {
    document.getElementById('genQuizLoading').style.display = 'none';
    document.getElementById('genQuizBtn').disabled = false;
  }
}
```

---

## Порядок впровадження

- [ ] 1. `npm install @google/genai`
- [ ] 2. Додати `GEMINI_API_KEY` в `.env`
- [ ] 3. Додати endpoint `/api/generate-quiz` в `server.js`
- [ ] 4. Додати кнопку в екран уроку (`index.html`)
- [ ] 5. Написати функцію `generateLessonQuiz()` в `index.html`
- [ ] 6. Підключити `startGeneratedQuiz()` для показу квізу
- [ ] 7. Протестувати — відкрити урок → натиснути кнопку → пройти квіз
- [ ] 8. `git commit`

---

## Модель

`gemini-2.0-flash-lite-preview-02-05` — швидка і безкоштовна в preview-режимі.
