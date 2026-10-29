/* ===============================================================
   Quiz NetSuite - GitHub Pages (sin backend)

   HORARIO: TODOS LOS DÍAS DE 16:00 A 16:59:59 UTC-6
            equivalente a 22:00 - 22:59:59 UTC.

   La hora proviene del encabezado HTTP "Date" del propio GitHub
   Pages, con un HEAD a index.html y una URL distinta por petición.
   Después, el tiempo transcurrido se calcula con performance.now(),
   NO con el reloj del dispositivo (Date.now()).

   IMPORTANTE: el bloqueo se ejecuta en el navegador. Es adecuado
   para una restricción funcional, no para seguridad antifraude.
   Un usuario avanzado puede manipular JS o leer questions.json.
   =============================================================== */

// -------- Configuración --------
const OPEN_HOUR_UTC = 22;        // 4:00 PM UTC-6
const CLOSE_HOUR_UTC = 23;       // 5:00 PM UTC-6
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const SYNC_INTERVAL_MS = 10000;  // Sincronizar con el servidor cada 10 s
const CLOCK_MAX_AGE_MS = 30000;  // Bloquear si la hora tiene más de 30 s
const REQUEST_TIMEOUT_MS = 7000;
const UI_TICK_MS = 250;          // Detectar los límites del horario

// -------- Estado del cuestionario --------
let questions = [];
let currentQuestion = 0;
let correctCount = 0;
let incorrectCount = 0;
let totalQuestions = 0;
let answerSubmitted = false;
let quizReady = false;
let quizCompleted = false;
let loadingQuestions = false;
let nextLoadRetryAt = 0;
let busy = false;
let activeQuizDay = null;

// -------- Estado de la hora confiable --------
let serverClock = null;
let pendingSync = null;
let clockError = '';
let lastScreenState = '';
let lastCountdown = '';

const $ = id => document.getElementById(id);

document.addEventListener('DOMContentLoaded', () => {
  showAccessPanel(
    '⌛',
    'Verificando horario...',
    'Consultando la hora del servidor para validar el acceso.',
    ''
  );

  // Inicialmente NO se carga questions.json.
  void refreshServerTime();

  // El reloj local no se utiliza ni para calcular el tiempo transcurrido.
  window.setInterval(() => {
    void refreshServerTime();
  }, SYNC_INTERVAL_MS);

  window.setInterval(updateAccessState, UI_TICK_MS);

  // Si la pestaña estuvo suspendida, revalidar en cuanto se reactive.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void refreshServerTime();
  });
  window.addEventListener('pageshow', () => { void refreshServerTime(); });
  window.addEventListener('online', () => { void refreshServerTime(); });
  window.addEventListener('focus', () => { void refreshServerTime(); });
});

/**
 * Consulta a GitHub Pages por HEAD para leer Date y Age.
 * Una nueva query string + no-store reduce el riesgo de cachés viejas.
 * Age se suma si un intermediario responde desde una caché.
 *
 * Date en HTTP tiene resolución de segundos; se estima la fracción
 * de segundo usando 500 ms y parte del tiempo de ida y vuelta.
 */
async function syncServerClock() {
  if (pendingSync) return pendingSync;

  pendingSync = (async () => {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const start = performance.now();

    try {
      const url = new URL('./index.html', document.baseURI);
      url.searchParams.set('_clock_check', `${Math.random()}`);

      const response = await fetch(url, {
        method: 'HEAD',
        cache: 'no-store',
        signal: controller.signal
      });

      if (!response.ok) {
        throw new Error(`El servidor devolvió HTTP ${response.status}`);
      }

      const dateHeader = response.headers.get('Date');
      if (!dateHeader) {
        throw new Error('GitHub Pages no devolvió el encabezado HTTP Date');
      }

      const dateMs = Date.parse(dateHeader); // Analiza un dato externo; NO lee la hora local.
      if (!Number.isFinite(dateMs)) {
        throw new Error('El servidor devolvió una fecha inválida');
      }

      const ageHeader = response.headers.get('Age');
      const ageSeconds = ageHeader === null ? 0 : Number(ageHeader);
      if (!Number.isFinite(ageSeconds) || ageSeconds < 0) {
        throw new Error('Encabezado Age inválido');
      }

      const end = performance.now();
      const roundTripMs = Math.max(0, end - start);

      // Ancla de tiempo: momento aproximado de recepción, en UTC.
      serverClock = {
        utcMs: dateMs + ageSeconds * 1000 + 500 + roundTripMs / 2,
        monotonicMs: end
      };
      clockError = '';
      return true;
    } catch (error) {
      // Falla cerrada: si no es posible comprobar la hora, se bloquea.
      serverClock = null;
      clockError = error.message || 'Error al consultar la hora del servidor';
      console.error('[Quiz] No se pudo validar el horario:', error);
      return false;
    } finally {
      window.clearTimeout(timeoutId);
    }
  })();

  try {
    return await pendingSync;
  } finally {
    pendingSync = null;
  }
}

function getTrustedUtcMs() {
  if (!serverClock) return null;
  const elapsed = performance.now() - serverClock.monotonicMs;
  if (elapsed < 0 || elapsed > CLOCK_MAX_AGE_MS) return null;
  return serverClock.utcMs + elapsed;
}

/** Calcula el intervalo diario 22:00 <= UTC < 23:00. */
function getWindowInfo(utcMs) {
  const startOfUtcDay = Math.floor(utcMs / DAY_MS) * DAY_MS;
  const opensAt = startOfUtcDay + OPEN_HOUR_UTC * HOUR_MS;
  const closesAt = startOfUtcDay + CLOSE_HOUR_UTC * HOUR_MS;

  if (utcMs < opensAt) {
    return { open: false, nextChangeAt: opensAt, day: startOfUtcDay };
  }
  if (utcMs < closesAt) {
    return { open: true, nextChangeAt: closesAt, day: startOfUtcDay };
  }
  return { open: false, nextChangeAt: opensAt + DAY_MS, day: startOfUtcDay };
}

function formatDuration(ms) {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  const hh = Math.floor(seconds / 3600);
  const mm = Math.floor((seconds % 3600) / 60);
  const ss = seconds % 60;
  return [hh, mm, ss].map(value => String(value).padStart(2, '0')).join(':');
}

async function refreshServerTime() {
  await syncServerClock();
  updateAccessState();

  // Si ya entró el horario y aún no hay preguntas, cargarlas.
  const now = getTrustedUtcMs();
  if (now !== null && getWindowInfo(now).open && !quizReady && !loadingQuestions) {
    void loadQuestions();
  }
}

/**
 * Revisa el estado frecuentemente y abre/cierra automáticamente.
 * No hace solicitudes de red en cada tick.
 */
function updateAccessState() {
  const now = getTrustedUtcMs();

  if (now === null) {
    $('quizPanel').hidden = true;
    const message = clockError
      ? 'No se pudo verificar la hora del servidor. Comprueba tu conexión y que la página esté publicada en GitHub Pages.'
      : 'Comprobando nuevamente la hora del servidor...';
    showAccessPanel('⌛', 'Horario no disponible', message, '');
    return;
  }

  const windowInfo = getWindowInfo(now);

  if (windowInfo.open) {
    if (activeQuizDay !== null && activeQuizDay !== windowInfo.day) {
      resetQuiz();
    }

    $('accessPanel').hidden = true;

    if (quizReady) {
      $('quizPanel').hidden = false;
    } else {
      // Abrir automáticamente justo al cruzar las 4 PM, sin esperar
      // la siguiente comprobación de red de 10 segundos.
      if (!loadingQuestions && performance.now() >= nextLoadRetryAt) {
        void loadQuestions();
      }
      showAccessPanel('⌛', 'Preparando cuestionario...', 'El horario está habilitado. Cargando preguntas.', '');
    }

    const remaining = `Cierra en ${formatDuration(windowInfo.nextChangeAt - now)}`;
    if (lastCountdown !== remaining) {
      $('timeRemaining').textContent = remaining;
      lastCountdown = remaining;
    }
    lastScreenState = 'open';
    return;
  }

  // Si terminó una ventana que estaba activa, cancelar y reiniciar.
  if (lastScreenState === 'open' ||
      (activeQuizDay !== null && activeQuizDay <= windowInfo.day)) {
    resetQuiz();
  }

  $('quizPanel').hidden = true;
  const countdown = `Se habilitará en ${formatDuration(windowInfo.nextChangeAt - now)}`;
  showAccessPanel(
    '🔒',
    'Cuestionario fuera de horario',
    'El cuestionario está disponible todos los días de 4:00 PM a 5:00 PM (UTC-6).',
    countdown
  );
  lastScreenState = 'closed';
}

function showAccessPanel(icon, title, message, countdown) {
  $('accessPanel').hidden = false;
  if ($('accessIcon').textContent !== icon) $('accessIcon').textContent = icon;
  if ($('accessTitle').textContent !== title) $('accessTitle').textContent = title;
  if ($('accessMessage').textContent !== message) $('accessMessage').textContent = message;
  if ($('accessCountdown').textContent !== countdown) $('accessCountdown').textContent = countdown;
  $('accessCountdown').hidden = !countdown;
}

/** Consulta fresca antes de enviar una respuesta o pasar a la siguiente pregunta. */
async function confirmAccess() {
  const verified = await syncServerClock();
  updateAccessState();
  const now = getTrustedUtcMs();
  return verified && now !== null && getWindowInfo(now).open;
}

async function loadQuestions() {
  if (loadingQuestions || quizReady) return;
  loadingQuestions = true;
  nextLoadRetryAt = performance.now() + SYNC_INTERVAL_MS;
  try {
    const response = await fetch('questions.json', { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status} al cargar preguntas`);
    const data = await response.json();
    if (!Array.isArray(data) || !data.length) throw new Error('No hay preguntas disponibles');

    const now = getTrustedUtcMs();
    if (now === null || !getWindowInfo(now).open) return;

    questions = data;
    shuffleArray(questions);
    questions.forEach(shuffleQuestionOptions);
    totalQuestions = questions.length;
    activeQuizDay = getWindowInfo(now).day;
    quizReady = true;
    quizCompleted = false;
    currentQuestion = 0;
    correctCount = 0;
    incorrectCount = 0;
    updateScore();
    loadQuestion();
    updateAccessState();
  } catch (error) {
    console.error('[Quiz] Falló la carga de preguntas:', error);
    showAccessPanel('⚠️', 'No se pudieron cargar las preguntas',
      'Revisa que questions.json esté publicado junto con index.html.', '');
  } finally {
    loadingQuestions = false;
  }
}

function resetQuiz() {
  questions = [];
  currentQuestion = 0;
  correctCount = 0;
  incorrectCount = 0;
  totalQuestions = 0;
  answerSubmitted = false;
  quizReady = false;
  quizCompleted = false;
  busy = false;
  activeQuizDay = null;
  nextLoadRetryAt = 0;
  lastCountdown = '';
  $('quizContent').hidden = false;
  $('finishedPanel').hidden = true;
  $('options').replaceChildren();
  $('question').textContent = 'Loading question...';
  $('progress').textContent = 'Question 1 of X';
  $('submitBtn').disabled = true;
  $('nextBtn').disabled = true;
  updateScore();
}

// -------- Lógica original del cuestionario --------
function shuffleArray(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
}

function shuffleQuestionOptions(question) {
  const options = question.options.map((option, index) => ({
    text: option,
    originalIndex: index
  }));

  shuffleArray(options);
  question.options = options.map(option => option.text);
  question.correctIndex = Array.isArray(question.correctIndex)
    ? question.correctIndex.map(idx => options.findIndex(opt => opt.originalIndex === idx))
    : options.findIndex(opt => opt.originalIndex === question.correctIndex);
}

function loadQuestion() {
  if (!quizReady || quizCompleted || currentQuestion >= questions.length) return;
  const q = questions[currentQuestion];
  answerSubmitted = false;

  $('question').textContent = q.question;
  $('progress').textContent = `Question ${currentQuestion + 1} of ${totalQuestions}`;
  const optionsDiv = $('options');
  optionsDiv.replaceChildren();

  $('submitBtn').disabled = true;
  $('nextBtn').disabled = true;

  const maxSelections = Array.isArray(q.correctIndex) ? q.correctIndex.length : 1;
  q.options.forEach((option, index) => {
    const label = document.createElement('label');
    label.className = 'option';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.name = 'option';
    input.value = index;
    input.addEventListener('click', () => limitSelection(maxSelections));
    label.appendChild(input);
    const textSpan = document.createElement('span');
    textSpan.textContent = option;
    label.appendChild(textSpan);
    optionsDiv.appendChild(label);
  });
}

function limitSelection(maxSelections) {
  if (!quizReady || busy || answerSubmitted || getTrustedUtcMs() === null) return;
  const checked = document.querySelectorAll('input[name="option"]:checked');

  if (checked.length > maxSelections) {
    checked[checked.length - 1].checked = false;
  }
  const count = document.querySelectorAll('input[name="option"]:checked').length;
  $('submitBtn').disabled = count === 0;
}

async function submitAnswer() {
  if (busy || !quizReady || quizCompleted || answerSubmitted) return;
  const selectedInputs = [...document.querySelectorAll('input[name="option"]:checked')];
  if (!selectedInputs.length) return;

  busy = true;
  $('submitBtn').disabled = true;
  const allInputs = [...document.querySelectorAll('input[name="option"]')];
  allInputs.forEach(input => { input.disabled = true; });

  try {
    if (!await confirmAccess()) return;
    if (!quizReady || quizCompleted) return;

    const q = questions[currentQuestion];
    const selectedIndexes = selectedInputs.map(input => Number(input.value));
    const correctIndexes = Array.isArray(q.correctIndex) ? q.correctIndex : [q.correctIndex];
    const optionElements = [...document.querySelectorAll('.option')];

    optionElements.forEach((option, index) => {
      if (correctIndexes.includes(index)) option.classList.add('correct');
    });

    const isCorrect = selectedIndexes.length === correctIndexes.length &&
      selectedIndexes.every(index => correctIndexes.includes(index));

    if (isCorrect) {
      correctCount++;
    } else {
      incorrectCount++;
      selectedIndexes.forEach(index => {
        if (!correctIndexes.includes(index)) optionElements[index].classList.add('incorrect');
      });
    }

    answerSubmitted = true;
    updateScore();
    $('nextBtn').disabled = false;
  } finally {
    busy = false;
    if (!answerSubmitted && quizReady && !$('quizPanel').hidden) {
      allInputs.forEach(input => { input.disabled = false; });
      $('submitBtn').disabled = !document.querySelector('input[name="option"]:checked');
    }
  }
}

function updateScore() {
  $('correctCount').textContent = correctCount;
  $('incorrectCount').textContent = incorrectCount;
}

async function nextQuestion() {
  if (busy || !quizReady || quizCompleted || !answerSubmitted) return;
  busy = true;
  $('nextBtn').disabled = true;

  try {
    if (!await confirmAccess()) return;
    if (!quizReady || quizCompleted) return;

    if (currentQuestion < questions.length - 1) {
      currentQuestion++;
      loadQuestion();
    } else {
      quizCompleted = true;
      $('quizContent').hidden = true;
      $('finishedPanel').hidden = false;
      $('finalCorrect').textContent = correctCount;
      $('finalIncorrect').textContent = incorrectCount;
      $('finalTotal').textContent = totalQuestions;
    }
  } finally {
    busy = false;
    if (quizReady && !$('quizPanel').hidden && answerSubmitted && !quizCompleted) {
      $('nextBtn').disabled = false;
    }
  }
}
