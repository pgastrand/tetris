'use strict';

// ---------- Constants ----------
const COLS = 10;
const ROWS = 22;          // 20 visible + 2 hidden spawn rows
const HIDDEN = 2;
const CELL = 30;
const DAS = 170;          // ms before auto-repeat starts
const ARR = 50;           // ms between auto-repeat moves
const SOFT_DROP_INTERVAL = 30;
const LOCK_DELAY = 500;
const MAX_LOCK_RESETS = 15;
const NEXT_COUNT = 3;

const COLORS = {
  I: '#00e5ff', O: '#ffd400', T: '#b04dff', S: '#3ddc5a',
  Z: '#ff4d4d', J: '#3d7bff', L: '#ff9a1f',
};

const SHAPES = {
  I: [[0,0,0,0],[1,1,1,1],[0,0,0,0],[0,0,0,0]],
  O: [[1,1],[1,1]],
  T: [[0,1,0],[1,1,1],[0,0,0]],
  S: [[0,1,1],[1,1,0],[0,0,0]],
  Z: [[1,1,0],[0,1,1],[0,0,0]],
  J: [[1,0,0],[1,1,1],[0,0,0]],
  L: [[0,0,1],[1,1,1],[0,0,0]],
};

// SRS wall kick data, (x, y) with y pointing UP (converted when applied).
const KICKS_JLSTZ = {
  '0>1': [[0,0],[-1,0],[-1,1],[0,-2],[-1,-2]],
  '1>0': [[0,0],[1,0],[1,-1],[0,2],[1,2]],
  '1>2': [[0,0],[1,0],[1,-1],[0,2],[1,2]],
  '2>1': [[0,0],[-1,0],[-1,1],[0,-2],[-1,-2]],
  '2>3': [[0,0],[1,0],[1,1],[0,-2],[1,-2]],
  '3>2': [[0,0],[-1,0],[-1,-1],[0,2],[-1,2]],
  '3>0': [[0,0],[-1,0],[-1,-1],[0,2],[-1,2]],
  '0>3': [[0,0],[1,0],[1,1],[0,-2],[1,-2]],
};
const KICKS_I = {
  '0>1': [[0,0],[-2,0],[1,0],[-2,-1],[1,2]],
  '1>0': [[0,0],[2,0],[-1,0],[2,1],[-1,-2]],
  '1>2': [[0,0],[-1,0],[2,0],[-1,2],[2,-1]],
  '2>1': [[0,0],[1,0],[-2,0],[1,-2],[-2,1]],
  '2>3': [[0,0],[2,0],[-1,0],[2,1],[-1,-2]],
  '3>2': [[0,0],[-2,0],[1,0],[-2,-1],[1,2]],
  '3>0': [[0,0],[1,0],[-2,0],[1,-2],[-2,1]],
  '0>3': [[0,0],[-1,0],[2,0],[-1,2],[2,-1]],
};

const LINE_SCORES = [0, 100, 300, 500, 800];

// ---------- DOM ----------
const boardCtx = document.getElementById('board').getContext('2d');
const holdCtx = document.getElementById('hold').getContext('2d');
const nextCtx = document.getElementById('next').getContext('2d');
const overlay = document.getElementById('overlay');
const overlayMsg = document.getElementById('overlay-msg');
const startBtn = document.getElementById('start-btn');
const ui = {
  score: document.getElementById('score'),
  best: document.getElementById('best'),
  level: document.getElementById('level'),
  lines: document.getElementById('lines'),
};

// ---------- State ----------
let board, piece, queue, bag, holdType, holdUsed;
let score, lines, level, best = Number(localStorage.getItem('tetris-best') || 0);
let state = 'idle'; // 'idle' | 'playing' | 'paused' | 'over'
let dropTimer = 0, lockTimer = 0, lockResets = 0, lastTime = 0;
let clearingRows = [], clearAnim = 0;

ui.best.textContent = best;

// ---------- Helpers ----------
const emptyBoard = () => Array.from({ length: ROWS }, () => Array(COLS).fill(null));

function rotateMatrix(m, dir) {
  const n = m.length;
  const r = Array.from({ length: n }, () => Array(n).fill(0));
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++)
      if (dir > 0) r[x][n - 1 - y] = m[y][x];
      else r[n - 1 - x][y] = m[y][x];
  return r;
}

function nextFromBag() {
  if (bag.length === 0) {
    bag = Object.keys(SHAPES);
    for (let i = bag.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [bag[i], bag[j]] = [bag[j], bag[i]];
    }
  }
  return bag.pop();
}

function createPiece(type) {
  const matrix = SHAPES[type].map(row => row.slice());
  return {
    type,
    matrix,
    rot: 0,
    x: Math.floor((COLS - matrix.length) / 2),
    y: HIDDEN - 1,
  };
}

function collides(p, dx = 0, dy = 0, matrix = p.matrix) {
  for (let y = 0; y < matrix.length; y++) {
    for (let x = 0; x < matrix[y].length; x++) {
      if (!matrix[y][x]) continue;
      const nx = p.x + x + dx;
      const ny = p.y + y + dy;
      if (nx < 0 || nx >= COLS || ny >= ROWS) return true;
      if (ny >= 0 && board[ny][nx]) return true;
    }
  }
  return false;
}

function gravityInterval() {
  // Tetris guideline gravity curve (seconds per row)
  return Math.pow(0.8 - (level - 1) * 0.007, level - 1) * 1000;
}

function isGrounded() {
  return collides(piece, 0, 1);
}

function onSuccessfulMove() {
  if (isGrounded() && lockResets < MAX_LOCK_RESETS) {
    lockTimer = 0;
    lockResets++;
  }
}

// ---------- Actions ----------
function spawn(type = queue.shift()) {
  while (queue.length < NEXT_COUNT) queue.push(nextFromBag());
  piece = createPiece(type);
  dropTimer = 0;
  lockTimer = 0;
  lockResets = 0;
  if (collides(piece)) gameOver();
}

function move(dx) {
  if (!collides(piece, dx, 0)) {
    piece.x += dx;
    onSuccessfulMove();
    return true;
  }
  return false;
}

function rotate(dir) {
  if (piece.type === 'O') return;
  const from = piece.rot;
  const to = (from + (dir > 0 ? 1 : 3)) % 4;
  const rotated = rotateMatrix(piece.matrix, dir);
  const kicks = (piece.type === 'I' ? KICKS_I : KICKS_JLSTZ)[`${from}>${to}`];
  for (const [kx, ky] of kicks) {
    if (!collides(piece, kx, -ky, rotated)) {
      piece.x += kx;
      piece.y -= ky;
      piece.matrix = rotated;
      piece.rot = to;
      onSuccessfulMove();
      return;
    }
  }
}

function softDrop() {
  if (!collides(piece, 0, 1)) {
    piece.y++;
    score += 1;
    dropTimer = 0;
    updateUI();
  }
}

function hardDrop() {
  let dist = 0;
  while (!collides(piece, 0, 1)) { piece.y++; dist++; }
  score += dist * 2;
  lock();
}

function hold() {
  if (holdUsed) return;
  const current = piece.type;
  if (holdType) spawn(holdType);
  else spawn();
  holdType = current;
  holdUsed = true;
}

function lock() {
  let aboveVisible = true;
  for (let y = 0; y < piece.matrix.length; y++) {
    for (let x = 0; x < piece.matrix[y].length; x++) {
      if (!piece.matrix[y][x]) continue;
      const by = piece.y + y;
      if (by >= 0) board[by][piece.x + x] = piece.type;
      if (by >= HIDDEN) aboveVisible = false;
    }
  }
  holdUsed = false;
  if (aboveVisible) return gameOver(); // lock out

  const full = [];
  for (let y = 0; y < ROWS; y++) if (board[y].every(Boolean)) full.push(y);

  if (full.length) {
    clearingRows = full;
    clearAnim = 0;
    piece = null;
  } else {
    spawn();
  }
  updateUI();
}

function finishClear() {
  for (const y of clearingRows) {
    board.splice(y, 1);
    board.unshift(Array(COLS).fill(null));
  }
  const n = clearingRows.length;
  score += LINE_SCORES[n] * level;
  lines += n;
  level = Math.floor(lines / 10) + 1;
  clearingRows = [];
  updateUI();
  spawn();
}

function updateUI() {
  ui.score.textContent = score;
  ui.level.textContent = level;
  ui.lines.textContent = lines;
  if (score > best) {
    best = score;
    ui.best.textContent = best;
    localStorage.setItem('tetris-best', best);
  }
}

// ---------- Game flow ----------
function start() {
  board = emptyBoard();
  bag = [];
  queue = [];
  holdType = null;
  holdUsed = false;
  score = 0; lines = 0; level = 1;
  clearingRows = [];
  while (queue.length < NEXT_COUNT) queue.push(nextFromBag());
  updateUI();
  state = 'playing';
  overlay.classList.add('hidden');
  spawn();
  lastTime = performance.now();
}

function togglePause() {
  if (state === 'playing') {
    state = 'paused';
    showOverlay('Paused', 'Press <kbd>P</kbd> to resume', 'Resume');
  } else if (state === 'paused') {
    state = 'playing';
    overlay.classList.add('hidden');
    lastTime = performance.now();
  }
}

function gameOver() {
  state = 'over';
  piece = null;
  showOverlay('Game Over', `Score: <strong>${score}</strong><br>Press <kbd>Enter</kbd> to play again`, 'Play again');
}

function showOverlay(title, msg, btn) {
  overlay.querySelector('h1').textContent = title;
  overlayMsg.innerHTML = msg;
  startBtn.textContent = btn;
  overlay.classList.remove('hidden');
}

// ---------- Loop ----------
function update(dt) {
  if (clearingRows.length) {
    clearAnim += dt;
    if (clearAnim >= 200) finishClear();
    return;
  }
  if (!piece) return;

  handleRepeat(dt);
  if (!piece) return;

  if (isGrounded()) {
    lockTimer += dt;
    if (lockTimer >= LOCK_DELAY) lock();
  } else {
    lockTimer = 0;
    dropTimer += dt;
    const interval = gravityInterval();
    while (dropTimer >= interval && !isGrounded()) {
      piece.y++;
      dropTimer -= interval;
    }
  }
}

function loop(now) {
  const dt = Math.min(now - lastTime, 100);
  lastTime = now;
  if (state === 'playing') update(dt);
  draw();
  requestAnimationFrame(loop);
}

// ---------- Rendering ----------
function drawCell(ctx, x, y, size, color, alpha = 1) {
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  ctx.fillRect(x, y, size, size);
  // bevel
  ctx.fillStyle = 'rgba(255,255,255,0.25)';
  ctx.fillRect(x, y, size, size * 0.15);
  ctx.fillRect(x, y, size * 0.15, size);
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.fillRect(x, y + size * 0.85, size, size * 0.15);
  ctx.fillRect(x + size * 0.85, y, size * 0.15, size);
  ctx.strokeStyle = 'rgba(0,0,0,0.4)';
  ctx.strokeRect(x + 0.5, y + 0.5, size - 1, size - 1);
  ctx.globalAlpha = 1;
}

function drawGrid() {
  boardCtx.strokeStyle = 'rgba(255,255,255,0.04)';
  boardCtx.lineWidth = 1;
  for (let x = 1; x < COLS; x++) {
    boardCtx.beginPath();
    boardCtx.moveTo(x * CELL + 0.5, 0);
    boardCtx.lineTo(x * CELL + 0.5, (ROWS - HIDDEN) * CELL);
    boardCtx.stroke();
  }
  for (let y = 1; y < ROWS - HIDDEN; y++) {
    boardCtx.beginPath();
    boardCtx.moveTo(0, y * CELL + 0.5);
    boardCtx.lineTo(COLS * CELL, y * CELL + 0.5);
    boardCtx.stroke();
  }
}

function drawBoard() {
  const ctx = boardCtx;
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  drawGrid();
  if (!board) return;

  for (let y = HIDDEN; y < ROWS; y++) {
    const flashing = clearingRows.includes(y);
    for (let x = 0; x < COLS; x++) {
      const t = board[y][x];
      if (!t) continue;
      const color = flashing && Math.floor(clearAnim / 50) % 2 === 0 ? '#ffffff' : COLORS[t];
      drawCell(ctx, x * CELL, (y - HIDDEN) * CELL, CELL, color);
    }
  }

  if (!piece) return;

  // ghost
  let gy = 0;
  while (!collides(piece, 0, gy + 1)) gy++;
  forEachBlock(piece, (x, y) => {
    if (y + gy >= HIDDEN) {
      const px = x * CELL, py = (y + gy - HIDDEN) * CELL;
      ctx.strokeStyle = COLORS[piece.type];
      ctx.globalAlpha = 0.5;
      ctx.lineWidth = 2;
      ctx.strokeRect(px + 2, py + 2, CELL - 4, CELL - 4);
      ctx.globalAlpha = 1;
      ctx.lineWidth = 1;
    }
  });

  // active piece
  forEachBlock(piece, (x, y) => {
    if (y >= HIDDEN) drawCell(ctx, x * CELL, (y - HIDDEN) * CELL, CELL, COLORS[piece.type]);
  });
}

function forEachBlock(p, fn) {
  for (let y = 0; y < p.matrix.length; y++)
    for (let x = 0; x < p.matrix[y].length; x++)
      if (p.matrix[y][x]) fn(p.x + x, p.y + y);
}

function drawMini(ctx, type, cx, cy, size, alpha = 1) {
  const m = SHAPES[type];
  // compute bounding box of filled cells
  let minX = 9, maxX = -1, minY = 9, maxY = -1;
  m.forEach((row, y) => row.forEach((v, x) => {
    if (v) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  }));
  const w = (maxX - minX + 1) * size;
  const h = (maxY - minY + 1) * size;
  const ox = cx - w / 2, oy = cy - h / 2;
  m.forEach((row, y) => row.forEach((v, x) => {
    if (v) drawCell(ctx, ox + (x - minX) * size, oy + (y - minY) * size, size, COLORS[type], alpha);
  }));
}

function drawSide() {
  holdCtx.clearRect(0, 0, holdCtx.canvas.width, holdCtx.canvas.height);
  if (holdType) drawMini(holdCtx, holdType, 60, 60, 24, holdUsed ? 0.35 : 1);

  nextCtx.clearRect(0, 0, nextCtx.canvas.width, nextCtx.canvas.height);
  if (queue) queue.slice(0, NEXT_COUNT).forEach((t, i) => drawMini(nextCtx, t, 60, 60 + i * 120, i === 0 ? 26 : 20));
}

function draw() {
  drawBoard();
  drawSide();
}

// ---------- Input ----------
const held = { left: false, right: false, down: false };
let dasDir = 0, dasTimer = 0, arrTimer = 0, softTimer = 0;

function handleRepeat(dt) {
  if (dasDir !== 0) {
    dasTimer += dt;
    if (dasTimer >= DAS) {
      arrTimer += dt;
      while (arrTimer >= ARR) {
        arrTimer -= ARR;
        if (!move(dasDir)) { arrTimer = 0; break; }
      }
    }
  }
  if (held.down) {
    softTimer += dt;
    while (softTimer >= SOFT_DROP_INTERVAL) {
      softTimer -= SOFT_DROP_INTERVAL;
      softDrop();
    }
  }
}

function pressDir(dir) {
  dasDir = dir;
  dasTimer = 0;
  arrTimer = 0;
  move(dir);
}

function releaseDir(name) {
  held[name] = false;
  if (held.left) dasDir = -1;
  else if (held.right) dasDir = 1;
  else dasDir = 0;
  dasTimer = 0;
  arrTimer = 0;
}

const canAct = () => state === 'playing' && piece && !clearingRows.length;

document.addEventListener('keydown', (e) => {
  const key = e.key;
  if (['ArrowLeft', 'ArrowRight', 'ArrowDown', 'ArrowUp', ' '].includes(key)) e.preventDefault();

  if (key === 'Enter' && (state === 'idle' || state === 'over')) return start();
  if (key === 'p' || key === 'P' || key === 'Escape') return togglePause();
  if (e.repeat) return;

  switch (key) {
    case 'ArrowLeft':
      held.left = true;
      if (canAct()) pressDir(-1); else dasDir = -1;
      break;
    case 'ArrowRight':
      held.right = true;
      if (canAct()) pressDir(1); else dasDir = 1;
      break;
    case 'ArrowDown':
      held.down = true;
      softTimer = 0;
      if (canAct()) softDrop();
      break;
    case 'ArrowUp': case 'x': case 'X':
      if (canAct()) rotate(1);
      break;
    case 'z': case 'Z': case 'Control':
      if (canAct()) rotate(-1);
      break;
    case ' ':
      if (canAct()) hardDrop();
      break;
    case 'c': case 'C': case 'Shift':
      if (canAct()) hold();
      break;
  }
});

document.addEventListener('keyup', (e) => {
  switch (e.key) {
    case 'ArrowLeft': releaseDir('left'); break;
    case 'ArrowRight': releaseDir('right'); break;
    case 'ArrowDown': held.down = false; break;
  }
});

window.addEventListener('blur', () => {
  held.left = held.right = held.down = false;
  dasDir = 0;
  if (state === 'playing') togglePause();
});

startBtn.addEventListener('click', () => {
  if (state === 'paused') togglePause();
  else start();
  startBtn.blur();
});

// Touch buttons
document.querySelectorAll('.touch-controls button').forEach((btn) => {
  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (!canAct()) return;
    switch (btn.dataset.action) {
      case 'left': move(-1); break;
      case 'right': move(1); break;
      case 'rotate': rotate(1); break;
      case 'down': softDrop(); break;
      case 'drop': hardDrop(); break;
      case 'hold': hold(); break;
    }
  });
});

requestAnimationFrame((t) => { lastTime = t; loop(t); });
