let questions = [];
let currentQuestion = 0;
let correctCount = 0;
let incorrectCount = 0;

document.addEventListener('DOMContentLoaded', async () => {
  const res = await fetch('questions.json');
  questions = await res.json();
  loadQuestion();
});

function loadQuestion() {
  const q = questions[currentQuestion];
  document.getElementById('question').innerText = q.question;
  const optionsDiv = document.getElementById('options');
  optionsDiv.innerHTML = '';

  document.getElementById('submitBtn').disabled = true;
  document.getElementById('nextBtn').disabled = true;

  q.options.forEach((option, index) => {
    const label = document.createElement('label');
    label.className = 'option';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.name = 'option';
    input.value = index;
    input.onclick = () => toggleSubmitButton();
    label.appendChild(input);
    const textSpan = document.createElement('span');
    textSpan.textContent = option;
    label.appendChild(textSpan);
    optionsDiv.appendChild(label);
  });
}

function toggleSubmitButton() {
  const selected = document.querySelectorAll('input[name="option"]:checked');
  document.getElementById('submitBtn').disabled = selected.length === 0;
}

function submitAnswer() {
  const q = questions[currentQuestion];
  const selectedInputs = document.querySelectorAll('input[name="option"]:checked');
  const selectedIndexes = Array.from(selectedInputs).map(input => parseInt(input.value));
  const correctIndexes = Array.isArray(q.correctIndex) ? q.correctIndex : [q.correctIndex];

  const options = document.querySelectorAll('.option');
  options.forEach((option, index) => {
    const checkbox = option.querySelector('input');
    checkbox.disabled = true;
    if (correctIndexes.includes(index)) {
      option.classList.add('correct');
    }
  });

  const isCorrect = selectedIndexes.length === correctIndexes.length &&
    selectedIndexes.every(idx => correctIndexes.includes(idx));

  if (isCorrect) {
    correctCount++;
  } else {
    incorrectCount++;
    selectedIndexes.forEach(i => {
      if (!correctIndexes.includes(i)) {
        options[i].classList.add('incorrect');
      }
    });
  }

  updateScore();
  document.getElementById('submitBtn').disabled = true;
  document.getElementById('nextBtn').disabled = false;
}

function updateScore() {
  document.getElementById('correctCount').innerText = correctCount;
  document.getElementById('incorrectCount').innerText = incorrectCount;
}

function nextQuestion() {
  if (currentQuestion < questions.length - 1) {
    currentQuestion++;
    loadQuestion();
  } else {
    document.querySelector('.quiz-container').innerHTML = `
      <h2>Quiz completed! 🎉</h2>
      <p>✅ Correct answers: ${correctCount}</p>
      <p>❌ Incorrect answers: ${incorrectCount}</p>
    `;
  }
}

