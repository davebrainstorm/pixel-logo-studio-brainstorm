(function () {
  'use strict';

  const STORAGE_KEY = 'pls_slots_v2';
  const MIN_RC = 2;
  const MAX_RC = 12;
  const MIN_CELL = 20;
  const MAX_CELL = 160;
  const MIN_RADIUS = 0.1;
  const MAX_RADIUS = 0.5;
  const DEFAULTS = {
    rows: 5,
    cols: 5,
    cellSize: 80,
    color: '#0f62fe',
    radiusFactor: 0.28,
    concaveDiagonal: true,
    blobT: true,
    framesPerStep: 10
  };
  const SLOT_COUNT = 5;
  const EPS = 0.0001;

  const state = {
    rows: DEFAULTS.rows,
    cols: DEFAULTS.cols,
    cellSize: DEFAULTS.cellSize,
    color: DEFAULTS.color,
    radiusFactor: DEFAULTS.radiusFactor,
    concaveDiagonal: DEFAULTS.concaveDiagonal,
    blobT: DEFAULTS.blobT,
    framesPerStep: DEFAULTS.framesPerStep,
    grid: createEmptyGrid(DEFAULTS.rows, DEFAULTS.cols),
    slots: Array.from({ length: SLOT_COUNT }, () => createEmptyGrid(DEFAULTS.rows, DEFAULTS.cols)),
    activeSlot: 0,
    morphSelection: new Set([0, 1])
  };
  let layerIdCounter = 1;

  const elements = {
    rows: document.getElementById('rows'),
    cols: document.getElementById('cols'),
    cellSize: document.getElementById('cellSize'),
    color: document.getElementById('color'),
    radiusFactor: document.getElementById('radiusFactor'),
    radiusValue: document.getElementById('radiusValue'),
    concaveDiagonal: document.getElementById('concaveDiagonal'),
    blobT: document.getElementById('blobT'),
    framesPerStep: document.getElementById('framesPerStep'),
    gridSvg: document.getElementById('gridSvg'),
    activeSlot: document.getElementById('activeSlot'),
    morphSources: document.getElementById('morphSources'),
    loadSlot: document.getElementById('loadSlot'),
    saveSlot: document.getElementById('saveSlot'),
    exportPng: document.getElementById('exportPng'),
    exportSvg: document.getElementById('exportSvg'),
    copySvg: document.getElementById('copySvg'),
    exportJson: document.getElementById('exportJson'),
    importJson: document.getElementById('importJson'),
    exportFrames: document.getElementById('exportFrames'),
    exportLottie: document.getElementById('exportLottie'),
    status: document.getElementById('status')
  };

  const hiddenFileInput = createHiddenFileInput();
  const offscreenCanvas = document.createElement('canvas');
  const offscreenCtx = offscreenCanvas.getContext('2d');
  const textEncoder = new TextEncoder();

  init();

  function init() {
    hydrateSlots();
    populateSlotControls();
    bindEvents();
    syncControls();
    renderGrid();
  }

  function bindEvents() {
    elements.rows.addEventListener('change', () => {
      const value = clampNumber(parseInt(elements.rows.value, 10), MIN_RC, MAX_RC, state.rows);
      if (value !== state.rows) {
        resizeGrid(value, state.cols);
      }
      elements.rows.value = state.rows;
      renderGrid();
      announce('Rows updated');
    });

    elements.cols.addEventListener('change', () => {
      const value = clampNumber(parseInt(elements.cols.value, 10), MIN_RC, MAX_RC, state.cols);
      if (value !== state.cols) {
        resizeGrid(state.rows, value);
      }
      elements.cols.value = state.cols;
      renderGrid();
      announce('Columns updated');
    });

    elements.cellSize.addEventListener('change', () => {
      const value = clampNumber(parseInt(elements.cellSize.value, 10), MIN_CELL, MAX_CELL, state.cellSize);
      state.cellSize = value;
      elements.cellSize.value = value;
      renderGrid();
      announce('Cell size updated');
    });

    elements.color.addEventListener('change', () => {
      const value = sanitizeColor(elements.color.value, state.color);
      state.color = value;
      elements.color.value = value;
      renderGrid();
    });

    elements.radiusFactor.addEventListener('input', () => {
      const value = parseFloat(elements.radiusFactor.value);
      const clamped = clampFloat(value, MIN_RADIUS, MAX_RADIUS, state.radiusFactor);
      state.radiusFactor = clamped;
      elements.radiusFactor.value = clamped.toFixed(2);
      elements.radiusValue.textContent = clamped.toFixed(2);
      renderGrid();
    });

    elements.concaveDiagonal.addEventListener('change', () => {
      state.concaveDiagonal = elements.concaveDiagonal.checked;
      renderGrid();
    });

    elements.blobT.addEventListener('change', () => {
      state.blobT = elements.blobT.checked;
      renderGrid();
    });

    elements.framesPerStep.addEventListener('change', () => {
      const value = clampNumber(parseInt(elements.framesPerStep.value, 10), 1, 60, state.framesPerStep);
      state.framesPerStep = value;
      elements.framesPerStep.value = value;
    });

    elements.activeSlot.addEventListener('change', () => {
      state.activeSlot = parseInt(elements.activeSlot.value, 10);
    });

    elements.loadSlot.addEventListener('click', () => {
      loadActiveSlot();
    });

    elements.saveSlot.addEventListener('click', () => {
      saveActiveSlot();
    });

    elements.exportPng.addEventListener('click', exportPng);
    elements.exportSvg.addEventListener('click', exportSvg);
    elements.copySvg.addEventListener('click', copySvgToClipboard);
    elements.exportJson.addEventListener('click', exportJson);
    elements.importJson.addEventListener('click', () => hiddenFileInput.click());
    elements.exportFrames.addEventListener('click', exportFramesZip);
    elements.exportLottie.addEventListener('click', exportLottieJson);

    hiddenFileInput.addEventListener('change', handleJsonImport);
  }

  function populateSlotControls() {
    elements.activeSlot.innerHTML = '';
    elements.morphSources.innerHTML = '';
    for (let i = 0; i < SLOT_COUNT; i++) {
      const option = document.createElement('option');
      option.value = String(i);
      option.textContent = `Slot ${i + 1}`;
      if (i === state.activeSlot) {
        option.selected = true;
      }
      elements.activeSlot.appendChild(option);

      const wrapper = document.createElement('label');
      wrapper.className = 'morph-item';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.value = String(i);
      checkbox.checked = state.morphSelection.has(i);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) {
          state.morphSelection.add(i);
        } else {
          state.morphSelection.delete(i);
        }
      });
      const span = document.createElement('span');
      span.textContent = `Slot ${i + 1}`;
      wrapper.appendChild(checkbox);
      wrapper.appendChild(span);
      elements.morphSources.appendChild(wrapper);
    }
  }

  function hydrateSlots() {
    const stored = readStorage();
    if (!stored) {
      return;
    }
    const rows = clampNumber(stored.rows, MIN_RC, MAX_RC, state.rows);
    const cols = clampNumber(stored.cols, MIN_RC, MAX_RC, state.cols);
    state.rows = rows;
    state.cols = cols;
    state.grid = createEmptyGrid(rows, cols);
    const slots = Array.isArray(stored.slots) ? stored.slots : [];
    for (let i = 0; i < SLOT_COUNT; i++) {
      const slotData = Array.isArray(slots[i]) ? slots[i] : [];
      state.slots[i] = normalizeSlot(slotData, rows, cols);
    }
    state.grid = state.slots[state.activeSlot].slice();
  }

  function readStorage() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (err) {
      console.warn('Failed to read stored slots', err);
      return null;
    }
  }

  function writeStorage() {
    try {
      const payload = {
        rows: state.rows,
        cols: state.cols,
        slots: state.slots.map(slot => slot.map(Boolean))
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch (err) {
      console.warn('Failed to write storage', err);
    }
  }

  function syncControls() {
    elements.rows.value = state.rows;
    elements.cols.value = state.cols;
    elements.cellSize.value = state.cellSize;
    elements.color.value = state.color;
    elements.radiusFactor.value = state.radiusFactor.toFixed(2);
    elements.radiusValue.textContent = state.radiusFactor.toFixed(2);
    elements.concaveDiagonal.checked = state.concaveDiagonal;
    elements.blobT.checked = state.blobT;
    elements.framesPerStep.value = state.framesPerStep;
  }

  function renderGrid() {
    const svg = elements.gridSvg;
    while (svg.firstChild) {
      svg.removeChild(svg.firstChild);
    }

    const width = state.cols * state.cellSize;
    const height = state.rows * state.cellSize;
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.setAttribute('width', width);
    svg.setAttribute('height', height);

    const cellsGroup = createSvgElement('g');
    const joinerGroup = createSvgElement('g');
    const hitsGroup = createSvgElement('g');

    const joiners = computeJoiners(state.grid, state.rows, state.cols, state.cellSize, state.radiusFactor, {
      concaveDiagonal: state.concaveDiagonal,
      blobT: state.blobT
    });

    for (let y = 0; y < state.rows; y++) {
      for (let x = 0; x < state.cols; x++) {
        const idx = y * state.cols + x;
        const isActive = Boolean(state.grid[idx]);
        const cell = createSvgElement('rect');
        cell.setAttribute('x', (x * state.cellSize + EPS).toFixed(4));
        cell.setAttribute('y', (y * state.cellSize + EPS).toFixed(4));
        cell.setAttribute('width', (state.cellSize - EPS * 2).toFixed(4));
        cell.setAttribute('height', (state.cellSize - EPS * 2).toFixed(4));
        cell.setAttribute('fill', state.color);
        cell.setAttribute('class', `cell-fill ${isActive ? 'active' : 'inactive'}`);
        cellsGroup.appendChild(cell);

        const hit = createSvgElement('rect');
        hit.setAttribute('x', (x * state.cellSize).toFixed(4));
        hit.setAttribute('y', (y * state.cellSize).toFixed(4));
        hit.setAttribute('width', state.cellSize.toFixed(4));
        hit.setAttribute('height', state.cellSize.toFixed(4));
        hit.setAttribute('class', 'cell-hit');
        hit.setAttribute('tabindex', '0');
        hit.setAttribute('role', 'button');
        hit.setAttribute('aria-pressed', isActive ? 'true' : 'false');
        hit.setAttribute('aria-label', `Toggle cell ${x + 1}, ${y + 1}`);
        hit.dataset.index = String(idx);
        hit.addEventListener('click', () => toggleCell(idx));
        hit.addEventListener('contextmenu', (ev) => {
          ev.preventDefault();
          toggleCell(idx);
        });
        hit.addEventListener('keydown', (ev) => {
          if (ev.key === ' ' || ev.key === 'Spacebar') {
            ev.preventDefault();
            toggleCell(idx);
          }
          if (ev.key === 'Enter') {
            ev.preventDefault();
            toggleCell(idx);
          }
        });
        hitsGroup.appendChild(hit);
      }
    }

    joiners.forEach(joiner => {
      const circle = createSvgElement('circle');
      circle.setAttribute('cx', joiner.cx.toFixed(4));
      circle.setAttribute('cy', joiner.cy.toFixed(4));
      circle.setAttribute('r', joiner.r.toFixed(4));
      circle.setAttribute('fill', state.color);
      circle.setAttribute('class', 'joiner');
      joinerGroup.appendChild(circle);
    });

    svg.appendChild(cellsGroup);
    svg.appendChild(joinerGroup);
    svg.appendChild(hitsGroup);
  }

  function toggleCell(idx) {
    state.grid[idx] = !state.grid[idx];
    renderGrid();
  }

  function resizeGrid(newRows, newCols) {
    const newGrid = createEmptyGrid(newRows, newCols);
    for (let y = 0; y < Math.min(newRows, state.rows); y++) {
      for (let x = 0; x < Math.min(newCols, state.cols); x++) {
        const oldIdx = y * state.cols + x;
        const newIdx = y * newCols + x;
        newGrid[newIdx] = state.grid[oldIdx];
      }
    }
    state.rows = newRows;
    state.cols = newCols;
    state.grid = newGrid;
    state.slots = state.slots.map(() => createEmptyGrid(newRows, newCols));
    writeStorage();
  }

  function saveActiveSlot() {
    state.slots[state.activeSlot] = state.grid.slice();
    writeStorage();
    announce(`Saved to slot ${state.activeSlot + 1}`);
  }

  function loadActiveSlot() {
    const slot = state.slots[state.activeSlot];
    if (!slot || slot.length !== state.rows * state.cols) {
      announce(`Slot ${state.activeSlot + 1} is empty`, 'warn');
      return;
    }
    state.grid = slot.slice();
    renderGrid();
    announce(`Loaded slot ${state.activeSlot + 1}`);
  }

  function exportPng() {
    const { width, height } = ensureCanvas();
    drawFrame(offscreenCtx, state.grid, state.rows, state.cols, state.cellSize, state.color, state.radiusFactor, {
      concaveDiagonal: state.concaveDiagonal,
      blobT: state.blobT
    });
    canvasToBlob(offscreenCanvas).then(blob => {
      if (!blob) return;
      downloadBlob(blob, 'pixel-logo.png');
      announce('PNG downloaded', 'ok');
    });
  }

  function exportSvg() {
    const svg = buildSvgString(state.grid, state.rows, state.cols, state.cellSize, state.color, state.radiusFactor, {
      concaveDiagonal: state.concaveDiagonal,
      blobT: state.blobT
    });
    const blob = new Blob([svg], { type: 'image/svg+xml' });
    downloadBlob(blob, 'pixel-logo.svg');
    announce('SVG downloaded', 'ok');
  }

  function copySvgToClipboard() {
    const svg = buildSvgString(state.grid, state.rows, state.cols, state.cellSize, state.color, state.radiusFactor, {
      concaveDiagonal: state.concaveDiagonal,
      blobT: state.blobT
    });
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(svg).then(() => {
        announce('SVG copied to clipboard', 'ok');
      }).catch(() => {
        window.alert('Clipboard copy blocked. Please copy manually.');
      });
    } else {
      window.alert('Clipboard API unavailable. Copy manually from SVG download.');
    }
  }

  function exportJson() {
    const payload = {
      schema: 1,
      rows: state.rows,
      cols: state.cols,
      cell: state.cellSize,
      color: state.color,
      opts: {
        radiusFactor: state.radiusFactor,
        concaveDiagonal: state.concaveDiagonal,
        blobT: state.blobT
      },
      grid: state.grid.map(Boolean)
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    downloadBlob(blob, 'pixel-logo.json');
    announce('JSON downloaded', 'ok');
  }

  function handleJsonImport(event) {
    const file = event.target.files && event.target.files[0];
    event.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const json = JSON.parse(String(reader.result));
        applyImport(json);
        announce('JSON imported', 'ok');
      } catch (err) {
        console.error(err);
        window.alert('Invalid JSON file.');
      }
    };
    reader.onerror = () => {
      window.alert('Could not read file.');
    };
    reader.readAsText(file);
  }

  function applyImport(data) {
    if (!data || typeof data !== 'object' || data.schema !== 1) {
      throw new Error('Unsupported schema');
    }
    const newRows = clampNumber(data.rows, MIN_RC, MAX_RC, state.rows);
    const newCols = clampNumber(data.cols, MIN_RC, MAX_RC, state.cols);
    const newCell = clampNumber(data.cell, MIN_CELL, MAX_CELL, state.cellSize);
    const newColor = sanitizeColor(data.color, state.color);
    const opts = data.opts || {};
    const newRadius = clampFloat(opts.radiusFactor, MIN_RADIUS, MAX_RADIUS, state.radiusFactor);
    const concave = typeof opts.concaveDiagonal === 'boolean' ? opts.concaveDiagonal : state.concaveDiagonal;
    const blobT = typeof opts.blobT === 'boolean' ? opts.blobT : state.blobT;
    const gridArray = Array.isArray(data.grid) ? data.grid : [];
    const sanitizedGrid = normalizeSlot(gridArray, newRows, newCols);

    if (newRows !== state.rows || newCols !== state.cols) {
      state.rows = newRows;
      state.cols = newCols;
      state.slots = Array.from({ length: SLOT_COUNT }, () => createEmptyGrid(newRows, newCols));
    }

    state.cellSize = newCell;
    state.color = newColor;
    state.radiusFactor = newRadius;
    state.concaveDiagonal = concave;
    state.blobT = blobT;
    state.grid = sanitizedGrid;
    state.slots[state.activeSlot] = sanitizedGrid.slice();
    writeStorage();
    syncControls();
    populateSlotControls();
    renderGrid();
  }

  function exportFramesZip() {
    const selection = Array.from(state.morphSelection.values()).sort();
    if (selection.length < 2) {
      announce('Select at least two slots for morph export', 'warn');
      return;
    }
    const designs = selection.map(index => normalizeSlot(state.slots[index], state.rows, state.cols));
    const frames = morphSequence(designs, state.framesPerStep);
    if (!frames.length) {
      announce('No frames to export', 'warn');
      return;
    }
    const zip = new ZipWriter();
    ensureCanvas();
    frames.forEach((frame, idx) => {
      drawFrame(offscreenCtx, frame, state.rows, state.cols, state.cellSize, state.color, state.radiusFactor, {
        concaveDiagonal: state.concaveDiagonal,
        blobT: state.blobT
      });
      const pngData = dataUrlToUint8(offscreenCanvas.toDataURL('image/png'));
      const name = `frame_${padNumber(idx + 1, 4)}.png`;
      zip.addFile(name, pngData);
    });
    const blob = new Blob([zip.finalize()], { type: 'application/zip' });
    downloadBlob(blob, 'frames.zip');
    announce('Frames ZIP downloaded', 'ok');
  }

  function exportLottieJson() {
    layerIdCounter = 1;
    const joiners = computeJoiners(state.grid, state.rows, state.cols, state.cellSize, state.radiusFactor, {
      concaveDiagonal: state.concaveDiagonal,
      blobT: state.blobT
    });
    const width = state.cols * state.cellSize;
    const height = state.rows * state.cellSize;
    const layers = [];
    const fillColor = hexToRgb(state.color);

    const colorArray = [fillColor.r / 255, fillColor.g / 255, fillColor.b / 255, 1];

    // Cells first to ensure they render below joiners.
    for (let y = 0; y < state.rows; y++) {
      for (let x = 0; x < state.cols; x++) {
        const idx = y * state.cols + x;
        if (!state.grid[idx]) continue;
        const cx = x * state.cellSize + state.cellSize / 2;
        const cy = y * state.cellSize + state.cellSize / 2;
        const path = rectPath(state.cellSize, state.cellSize, 0);
        layers.push(createLottieShapeLayer(`cell_${idx}`, cx, cy, path, colorArray));
      }
    }

    joiners.forEach((joiner, index) => {
      const path = circlePath(joiner.r);
      layers.push(createLottieShapeLayer(`joiner_${index}`, joiner.cx, joiner.cy, path, colorArray));
    });

    const lottie = {
      v: '5.7.4',
      fr: 30,
      ip: 0,
      op: 60,
      w: Math.round(width),
      h: Math.round(height),
      nm: 'Pixel Logo Studio Export',
      ddd: 0,
      assets: [],
      layers,
      markers: []
    };

    const blob = new Blob([JSON.stringify(lottie, null, 2)], { type: 'application/json' });
    downloadBlob(blob, 'pixel-logo.json');
    announce('Lottie JSON downloaded', 'ok');
  }

  function morphSequence(designs, framesPerStep) {
    if (!designs.length) return [];
    const frames = [];
    let current = designs[0].slice();
    frames.push(current.slice());
    for (let i = 1; i < designs.length; i++) {
      const target = designs[i].slice();
      const diff = [];
      for (let idx = 0; idx < current.length; idx++) {
        if (current[idx] !== target[idx]) {
          diff.push(idx);
        }
      }
      const total = diff.length;
      for (let step = 1; step <= framesPerStep; step++) {
        const threshold = Math.ceil(total * step / framesPerStep);
        const frame = current.slice();
        for (let d = 0; d < threshold; d++) {
          const index = diff[d];
          if (index === undefined) continue;
          frame[index] = target[index];
        }
        frames.push(frame);
      }
      current = target;
    }
    return frames;
  }

  function ensureCanvas() {
    const width = Math.max(1, Math.round(state.cols * state.cellSize));
    const height = Math.max(1, Math.round(state.rows * state.cellSize));
    if (offscreenCanvas.width !== width || offscreenCanvas.height !== height) {
      offscreenCanvas.width = width;
      offscreenCanvas.height = height;
    }
    return { width, height };
  }

  function drawFrame(ctx, grid, rows, cols, cellSize, color, radiusFactor, opts) {
    const width = cols * cellSize;
    const height = rows * cellSize;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);

    ctx.fillStyle = color;
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const idx = y * cols + x;
        if (!grid[idx]) continue;
        ctx.fillRect(x * cellSize, y * cellSize, cellSize, cellSize);
      }
    }

    const joiners = computeJoiners(grid, rows, cols, cellSize, radiusFactor, opts);
    joiners.forEach(joiner => {
      ctx.beginPath();
      ctx.arc(joiner.cx, joiner.cy, joiner.r, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  function buildSvgString(grid, rows, cols, cellSize, color, radiusFactor, opts) {
    const width = cols * cellSize;
    const height = rows * cellSize;
    const joiners = computeJoiners(grid, rows, cols, cellSize, radiusFactor, opts);
    const rects = [];
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const idx = y * cols + x;
        if (!grid[idx]) continue;
        const xPos = x * cellSize;
        const yPos = y * cellSize;
        rects.push(`<rect x="${round4(xPos)}" y="${round4(yPos)}" width="${round4(cellSize)}" height="${round4(cellSize)}" fill="${color}" />`);
      }
    }
    const circles = joiners.map(joiner => `<circle cx="${round4(joiner.cx)}" cy="${round4(joiner.cy)}" r="${round4(joiner.r)}" fill="${color}" />`);
    return `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<svg xmlns="http://www.w3.org/2000/svg" width="${round4(width)}" height="${round4(height)}" viewBox="0 0 ${round4(width)} ${round4(height)}">` +
      rects.join('') +
      circles.join('') +
      `</svg>`;
  }

  function computeJoiners(grid, rows, cols, cellSize, radiusFactor, opts) {
    const joiners = [];
    const radius = cellSize * radiusFactor;
    const diagonalRadius = radius * 0.85;
    const tRadius = radius * 0.65;

    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const idx = y * cols + x;
        if (!grid[idx]) continue;
        const baseX = x * cellSize;
        const baseY = y * cellSize;
        const centerX = baseX + cellSize / 2;
        const centerY = baseY + cellSize / 2;

        // Horizontal joiner to the right
        if (x + 1 < cols && grid[idx + 1]) {
          joiners.push({
            cx: baseX + cellSize,
            cy: centerY,
            r: radius
          });
        }

        // Vertical joiner downwards
        if (y + 1 < rows && grid[idx + cols]) {
          joiners.push({
            cx: centerX,
            cy: baseY + cellSize,
            r: radius
          });
        }

        if (opts.blobT) {
          const neighbours = [
            y > 0 ? grid[idx - cols] : false,
            x + 1 < cols ? grid[idx + 1] : false,
            y + 1 < rows ? grid[idx + cols] : false,
            x > 0 ? grid[idx - 1] : false
          ];
          const count = neighbours.filter(Boolean).length;
          if (count === 3) {
            joiners.push({ cx: centerX, cy: centerY, r: tRadius });
          }
        }

        if (opts.concaveDiagonal) {
          // Down-right diagonal
          if (x + 1 < cols && y + 1 < rows) {
            const diagIdx = (y + 1) * cols + (x + 1);
            const eastIdx = y * cols + (x + 1);
            const southIdx = (y + 1) * cols + x;
            if (grid[diagIdx] && !grid[eastIdx] && !grid[southIdx]) {
              joiners.push({
                cx: baseX + cellSize,
                cy: baseY + cellSize,
                r: diagonalRadius
              });
            }
          }
          // Up-right diagonal
          if (x + 1 < cols && y - 1 >= 0) {
            const diagIdx = (y - 1) * cols + (x + 1);
            const eastIdx = y * cols + (x + 1);
            const northIdx = (y - 1) * cols + x;
            if (grid[diagIdx] && !grid[eastIdx] && !grid[northIdx]) {
              joiners.push({
                cx: baseX + cellSize,
                cy: baseY,
                r: diagonalRadius
              });
            }
          }
        }
      }
    }

    return joiners;
  }

  function rectPath(width, height) {
    const w = width / 2;
    const h = height / 2;
    return {
      i: [
        [0, 0],
        [0, 0],
        [0, 0],
        [0, 0]
      ],
      o: [
        [0, 0],
        [0, 0],
        [0, 0],
        [0, 0]
      ],
      v: [
        [-w, -h],
        [w, -h],
        [w, h],
        [-w, h]
      ],
      c: true
    };
  }

  function circlePath(radius) {
    const c = 0.5522847498307936;
    const r = radius;
    const cp = c * r;
    return {
      i: [
        [0, -cp],
        [cp, 0],
        [0, cp],
        [-cp, 0]
      ],
      o: [
        [0, cp],
        [-cp, 0],
        [0, -cp],
        [cp, 0]
      ],
      v: [
        [0, -r],
        [r, 0],
        [0, r],
        [-r, 0]
      ],
      c: true
    };
  }

  function createLottieShapeLayer(name, x, y, path, colorArray) {
    const ind = layerIdCounter++;
    return {
      ddd: 0,
      ind,
      ty: 4,
      nm: name,
      sr: 1,
      ks: {
        o: { a: 0, k: 100 },
        r: { a: 0, k: 0 },
        p: { a: 0, k: [x, y, 0] },
        a: { a: 0, k: [0, 0, 0] },
        s: { a: 0, k: [100, 100, 100] }
      },
      shapes: [
        {
          ty: 'sh',
          ks: {
            a: 0,
            k: path
          },
          nm: `${name}_path`
        },
        {
          ty: 'fl',
          c: { a: 0, k: colorArray },
          o: { a: 0, k: 100 },
          r: 1,
          nm: `${name}_fill`
        }
      ],
      ip: 0,
      op: 60,
      st: 0,
      bm: 0
    };
  }

  function canvasToBlob(canvas) {
    return new Promise(resolve => {
      if (canvas.toBlob) {
        canvas.toBlob(resolve);
      } else {
        const dataUrl = canvas.toDataURL('image/png');
        resolve(dataUrlToBlob(dataUrl));
      }
    });
  }

  function dataUrlToBlob(dataUrl) {
    const binary = atob(dataUrl.split(',')[1]);
    const len = binary.length;
    const array = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      array[i] = binary.charCodeAt(i);
    }
    return new Blob([array], { type: 'image/png' });
  }

  function dataUrlToUint8(dataUrl) {
    const binary = atob(dataUrl.split(',')[1]);
    const len = binary.length;
    const array = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      array[i] = binary.charCodeAt(i);
    }
    return array;
  }

  function downloadBlob(blob, filename) {
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function announce(message, type = 'info') {
    const status = elements.status;
    status.textContent = message;
    status.className = 'inline-status';
    if (type === 'ok') status.classList.add('status-ok');
    if (type === 'warn') status.classList.add('status-warn');
    if (type === 'error') status.classList.add('status-error');
  }

  function createEmptyGrid(rows, cols) {
    return Array.from({ length: rows * cols }, () => false);
  }

  function normalizeSlot(input, rows, cols) {
    const out = createEmptyGrid(rows, cols);
    const len = Math.min(out.length, Array.isArray(input) ? input.length : 0);
    for (let i = 0; i < len; i++) {
      out[i] = Boolean(input[i]);
    }
    return out;
  }

  function clampNumber(value, min, max, fallback) {
    const number = Number.isFinite(value) ? value : fallback;
    if (!Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(min, number));
  }

  function clampFloat(value, min, max, fallback) {
    if (typeof value !== 'number' || Number.isNaN(value)) return fallback;
    return Math.min(max, Math.max(min, value));
  }

  function sanitizeColor(value, fallback) {
    if (typeof value !== 'string') return fallback;
    const match = /^#([0-9a-fA-F]{6})$/.test(value.trim()) ? value.trim().toLowerCase() : null;
    return match ? match : fallback;
  }

  function createHiddenFileInput() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json';
    input.style.display = 'none';
    document.body.appendChild(input);
    return input;
  }

  function createSvgElement(name) {
    return document.createElementNS('http://www.w3.org/2000/svg', name);
  }

  function round4(value) {
    return Number.parseFloat(value.toFixed(4));
  }

  function padNumber(value, length) {
    let str = String(value);
    while (str.length < length) {
      str = '0' + str;
    }
    return str;
  }

  function hexToRgb(hex) {
    const clean = hex.replace('#', '');
    return {
      r: parseInt(clean.slice(0, 2), 16),
      g: parseInt(clean.slice(2, 4), 16),
      b: parseInt(clean.slice(4, 6), 16)
    };
  }

  class ZipWriter {
    constructor() {
      this.files = [];
      this.parts = [];
      this.offset = 0;
    }

    addFile(name, data) {
      const nameBytes = textEncoder.encode(name);
      const crc = crc32(data);
      const size = data.length;
      const localHeader = new Uint8Array(30 + nameBytes.length);
      const view = new DataView(localHeader.buffer);
      let ptr = 0;

      view.setUint32(ptr, 0x04034b50, true); ptr += 4;
      view.setUint16(ptr, 20, true); ptr += 2; // version needed
      view.setUint16(ptr, 0, true); ptr += 2; // flags
      view.setUint16(ptr, 0, true); ptr += 2; // compression (store)
      view.setUint16(ptr, 0, true); ptr += 2; // mod time
      view.setUint16(ptr, 0, true); ptr += 2; // mod date
      view.setUint32(ptr, crc >>> 0, true); ptr += 4;
      view.setUint32(ptr, size, true); ptr += 4;
      view.setUint32(ptr, size, true); ptr += 4;
      view.setUint16(ptr, nameBytes.length, true); ptr += 2;
      view.setUint16(ptr, 0, true); ptr += 2; // extra length
      localHeader.set(nameBytes, 30);

      this.parts.push(localHeader, data);
      this.files.push({ nameBytes, crc, size, offset: this.offset });
      this.offset += localHeader.length + size;
    }

    finalize() {
      const centralParts = [];
      let centralSize = 0;
      this.files.forEach(file => {
        const header = new Uint8Array(46 + file.nameBytes.length);
        const view = new DataView(header.buffer);
        let ptr = 0;
        view.setUint32(ptr, 0x02014b50, true); ptr += 4;
        view.setUint16(ptr, 20, true); ptr += 2; // version made by
        view.setUint16(ptr, 20, true); ptr += 2; // version needed
        view.setUint16(ptr, 0, true); ptr += 2;
        view.setUint16(ptr, 0, true); ptr += 2;
        view.setUint16(ptr, 0, true); ptr += 2;
        view.setUint16(ptr, 0, true); ptr += 2;
        view.setUint32(ptr, file.crc >>> 0, true); ptr += 4;
        view.setUint32(ptr, file.size, true); ptr += 4;
        view.setUint32(ptr, file.size, true); ptr += 4;
        view.setUint16(ptr, file.nameBytes.length, true); ptr += 2;
        view.setUint16(ptr, 0, true); ptr += 2; // extra
        view.setUint16(ptr, 0, true); ptr += 2; // comment
        view.setUint16(ptr, 0, true); ptr += 2; // disk number
        view.setUint16(ptr, 0, true); ptr += 2; // internal attrs
        view.setUint32(ptr, 0, true); ptr += 4; // external attrs
        view.setUint32(ptr, file.offset, true); ptr += 4;
        header.set(file.nameBytes, 46);
        centralParts.push(header);
        centralSize += header.length;
      });

      const eocd = new Uint8Array(22);
      const eocdView = new DataView(eocd.buffer);
      let ptr = 0;
      eocdView.setUint32(ptr, 0x06054b50, true); ptr += 4;
      eocdView.setUint16(ptr, 0, true); ptr += 2;
      eocdView.setUint16(ptr, 0, true); ptr += 2;
      eocdView.setUint16(ptr, this.files.length, true); ptr += 2;
      eocdView.setUint16(ptr, this.files.length, true); ptr += 2;
      eocdView.setUint32(ptr, centralSize, true); ptr += 4;
      eocdView.setUint32(ptr, this.offset, true); ptr += 4;
      eocdView.setUint16(ptr, 0, true);

      const totalSize = this.offset + centralSize + eocd.length;
      const output = new Uint8Array(totalSize);
      let offset = 0;
      this.parts.forEach(part => {
        output.set(part, offset);
        offset += part.length;
      });
      centralParts.forEach(part => {
        output.set(part, offset);
        offset += part.length;
      });
      output.set(eocd, offset);
      return output;
    }
  }

  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++) {
        if (c & 1) {
          c = 0xedb88320 ^ (c >>> 1);
        } else {
          c = c >>> 1;
        }
      }
      table[i] = c >>> 0;
    }
    return table;
  })();

  function crc32(data) {
    let crc = -1;
    for (let i = 0; i < data.length; i++) {
      const byte = data[i];
      crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff];
    }
    return (crc ^ -1) >>> 0;
  }

})();
