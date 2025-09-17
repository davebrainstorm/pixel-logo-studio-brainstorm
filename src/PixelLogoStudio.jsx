import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import JSZip from "jszip"

/**
 * Pixel Logo Studio — v3.7 (performance refactor)
 * ------------------------------------------------------
 * Keeps all v3.6 features and fixes while trimming re-renders, bundling utilities,
 * and simplifying the draw pipeline. Designed as a single drop-in file.
 *
 * Features
 * - White UI/canvas, 5×5 default grid
 * - Click/drag to paint; hold Alt (Option) to erase while dragging
 * - Concave diagonal joiners (approx) + blobbed T-junctions toggles
 * - Save up to 5 designs (localStorage), rename, delete
 * - Pick any subset of saves (2–5) and morph between them (pixel-wise, no crossfade)
 * - Export: PNG, SVG, JSON; Copy SVG; Load JSON
 * - Export Frames (ZIP) for the full morph sequence
 * - Clear button, undo/redo
 *
 * Notes
 * - Rendering is done on <canvas> for speed; SVG export builds path data separately
 * - Concave/T toggles approximate smooth joins by adapting corner radii per-neighbour
 */

// ---------- small helpers ----------
const clamp = (v, a, b) => Math.min(Math.max(v, a), b)
const uid = () => Math.random().toString(36).slice(2, 9)
const DPR = () => (typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1)

// Cell bitmap utilities
function createGrid(rows, cols, fill = false) {
  return Array.from({ length: rows }, () => Array(cols).fill(fill))
}

function cloneGrid(g) {
  return g.map((row) => row.slice())
}

function serializeGrid(g) {
  return g.map((row) => row.map((b) => (b ? 1 : 0)).join("")).join("\n")
}

function deserializeGrid(text, rows, cols) {
  const lines = text.trim().split(/\n+/)
  const out = createGrid(rows, cols, false)
  for (let r = 0; r < rows; r++) {
    const line = lines[r] || ""
    for (let c = 0; c < cols; c++) {
      out[r][c] = line[c] === "1"
    }
  }
  return out
}

function gridDiffPositions(a, b) {
  const diffs = []
  for (let r = 0; r < a.length; r++)
    for (let c = 0; c < a[0].length; c++)
      if (a[r][c] !== b[r][c]) diffs.push([r, c])
  return diffs
}

function applyDiffStep(base, diffs, step) {
  const g = cloneGrid(base)
  for (let i = 0; i < step && i < diffs.length; i++) {
    const [r, c] = diffs[i]
    g[r][c] = !g[r][c]
  }
  return g
}

// ---------- drawing (canvas) ----------
function drawGridToCanvas(ctx, grid, opts) {
  const {
    cell,
    gap,
    pad,
    fg,
    bg,
    radiusBase,
    concaveJoiners,
    blobTJunctions,
  } = opts

  const rows = grid.length
  const cols = grid[0].length
  const W = pad * 2 + cols * cell + (cols - 1) * gap
  const H = pad * 2 + rows * cell + (rows - 1) * gap

  // clear
  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height)
  ctx.restore()

  // bg
  ctx.fillStyle = bg
  ctx.fillRect(0, 0, W, H)

  // draw pixels with neighbour-aware corners
  ctx.fillStyle = fg

  const has = (r, c) => r >= 0 && r < rows && c >= 0 && c < cols && grid[r][c]

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!grid[r][c]) continue

      const x = pad + c * (cell + gap)
      const y = pad + r * (cell + gap)

      const n = has(r - 1, c)
      const s = has(r + 1, c)
      const w = has(r, c - 1)
      const e = has(r, c + 1)

      const nw = has(r - 1, c - 1)
      const ne = has(r - 1, c + 1)
      const sw = has(r + 1, c - 1)
      const se = has(r + 1, c + 1)

      // Base corner radius adapted by neighbours
      let rt = radiusBase,
        rr = radiusBase,
        rb = radiusBase,
        rl = radiusBase

      if (n) {
        rt = 0
      }
      if (s) {
        rb = 0
      }
      if (w) {
        rl = 0
      }
      if (e) {
        rr = 0
      }

      // Concave diagonal joiners: soften diagonals when the orthogonals are empty
      const cr = radiusBase * 0.8
      if (concaveJoiners) {
        if (!n && !w && nw) rl = rt = cr
        if (!n && !e && ne) rr = rt = cr
        if (!s && !w && sw) rl = rb = cr
        if (!s && !e && se) rr = rb = cr
      }

      // Blobbed T-junctions: add subtle rounding when 3-way connects
      if (blobTJunctions) {
        const deg3 = n + s + e + w === 2 && !(n && s && e && w)
        if (deg3) {
          rt = Math.max(rt, radiusBase * 0.35)
          rr = Math.max(rr, radiusBase * 0.35)
          rb = Math.max(rb, radiusBase * 0.35)
          rl = Math.max(rl, radiusBase * 0.35)
        }
      }

      // Rounded-rect like path with per-corner radii
      const r1 = clamp(rt, 0, cell / 2)
      const r2 = clamp(rr, 0, cell / 2)
      const r3 = clamp(rb, 0, cell / 2)
      const r4 = clamp(rl, 0, cell / 2)

      ctx.beginPath()
      ctx.moveTo(x + r4, y)
      ctx.lineTo(x + cell - r2, y)
      if (r2) ctx.quadraticCurveTo(x + cell, y, x + cell, y + r2)
      ctx.lineTo(x + cell, y + cell - r3)
      if (r3) ctx.quadraticCurveTo(x + cell, y + cell, x + cell - r3, y + cell)
      ctx.lineTo(x + r4, y + cell)
      if (r4) ctx.quadraticCurveTo(x, y + cell, x, y + cell - r4)
      ctx.lineTo(x, y + r1)
      if (r1) ctx.quadraticCurveTo(x, y, x + r1, y)
      ctx.closePath()
      ctx.fill()
    }
  }
}

// Build SVG path string (simple rects + neighbour rounding approx)
function buildSVG(grid, opts) {
  const { cell, gap, pad, radiusBase, concaveJoiners, blobTJunctions, fg, bg } = opts
  const rows = grid.length,
    cols = grid[0].length
  const W = pad * 2 + cols * cell + (cols - 1) * gap
  const H = pad * 2 + rows * cell + (rows - 1) * gap

  const has = (r, c) => r >= 0 && r < rows && c >= 0 && c < cols && grid[r][c]

  const path = []
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!grid[r][c]) continue
      const x = pad + c * (cell + gap)
      const y = pad + r * (cell + gap)
      const n = has(r - 1, c)
      const s = has(r + 1, c)
      const w = has(r, c - 1)
      const e = has(r, c + 1)
      const nw = has(r - 1, c - 1)
      const ne = has(r - 1, c + 1)
      const sw = has(r + 1, c - 1)
      const se = has(r + 1, c + 1)

      let rt = radiusBase,
        rr = radiusBase,
        rb = radiusBase,
        rl = radiusBase
      if (n) rt = 0
      if (s) rb = 0
      if (w) rl = 0
      if (e) rr = 0
      const cr = radiusBase * 0.8
      if (concaveJoiners) {
        if (!n && !w && nw) rl = rt = cr
        if (!n && !e && ne) rr = rt = cr
        if (!s && !w && sw) rl = rb = cr
        if (!s && !e && se) rr = rb = cr
      }
      if (blobTJunctions) {
        const deg3 = n + s + e + w === 2 && !(n && s && e && w)
        if (deg3) {
          rt = Math.max(rt, radiusBase * 0.35)
          rr = Math.max(rr, radiusBase * 0.35)
          rb = Math.max(rb, radiusBase * 0.35)
          rl = Math.max(rl, radiusBase * 0.35)
        }
      }

      const r1 = clamp(rt, 0, cell / 2)
      const r2 = clamp(rr, 0, cell / 2)
      const r3 = clamp(rb, 0, cell / 2)
      const r4 = clamp(rl, 0, cell / 2)

      // Construct a rounded rectangle path for each filled cell
      const d = [
        `M ${x + r4} ${y}`,
        `L ${x + cell - r2} ${y}`,
        r2 ? `Q ${x + cell} ${y} ${x + cell} ${y + r2}` : `L ${x + cell} ${y}`,
        `L ${x + cell} ${y + cell - r3}`,
        r3
          ? `Q ${x + cell} ${y + cell} ${x + cell - r3} ${y + cell}`
          : `L ${x + cell} ${y + cell}`,
        `L ${x + r4} ${y + cell}`,
        r4
          ? `Q ${x} ${y + cell} ${x} ${y + cell - r4}`
          : `L ${x} ${y + cell}`,
        `L ${x} ${y + r1}`,
        r1 ? `Q ${x} ${y} ${x + r1} ${y}` : `L ${x} ${y}`,
        "Z",
      ].join(" ")

      path.push(d)
    }
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">\n  <rect width="100%" height="100%" fill="${bg}"/>\n  <path d="${path.join(" ")}" fill="${fg}"/>\n</svg>`
}

// ---------- main component ----------
export default function PixelLogoStudio() {
  // Canvas + layout
  const canvasRef = useRef(null)
  const [rows, setRows] = useState(5)
  const [cols, setCols] = useState(5)
  const [cell, setCell] = useState(48) // pixel size
  const [gap, setGap] = useState(8)
  const [pad, setPad] = useState(24)
  const [radius, setRadius] = useState(14)
  const [concaveJoiners, setConcaveJoiners] = useState(true)
  const [blobTJunctions, setBlobTJunctions] = useState(true)

  const [grid, setGrid] = useState(() => createGrid(5, 5, false))
  const [mouseDown, setMouseDown] = useState(false)
  const [paintVal, setPaintVal] = useState(true)
  const [undoStack, setUndoStack] = useState([])
  const [redoStack, setRedoStack] = useState([])

  // Theme
  const fg = "#111"
  const bg = "#fff"

  // Derived canvas size (CSS vs backing store)
  const dpr = DPR()
  const width = useMemo(
    () => pad * 2 + cols * cell + (cols - 1) * gap,
    [pad, cols, cell, gap],
  )
  const height = useMemo(
    () => pad * 2 + rows * cell + (rows - 1) * gap,
    [pad, rows, cell, gap],
  )

  // Saves (localStorage)
  const [saves, setSaves] = useState(() => {
    try {
      const raw = localStorage.getItem("pls:saves")
      return raw ? JSON.parse(raw) : []
    } catch (error) {
      console.warn("Failed to restore saved designs", error)
      return []
    }
  })
  const [selectedForMorph, setSelectedForMorph] = useState([]) // ids

  useEffect(() => {
    try {
      localStorage.setItem("pls:saves", JSON.stringify(saves))
    } catch (error) {
      console.warn("Failed to persist saved designs", error)
    }
  }, [saves])

  // Drawing pipeline
  const draw = useCallback(() => {
    const cv = canvasRef.current
    if (!cv) return
    const ctx = cv.getContext("2d")
    ctx.save()
    drawGridToCanvas(ctx, grid, {
      cell,
      gap,
      pad,
      fg,
      bg,
      radiusBase: radius,
      concaveJoiners,
      blobTJunctions,
    })
    ctx.restore()
  }, [grid, cell, gap, pad, fg, bg, radius, concaveJoiners, blobTJunctions])

  useEffect(() => {
    draw()
  }, [draw, width, height, dpr])

  useEffect(() => {
    const cv = canvasRef.current
    if (!cv) return
    cv.width = Math.round(width * dpr)
    cv.height = Math.round(height * dpr)
    cv.style.width = `${width}px`
    cv.style.height = `${height}px`
    const ctx = cv.getContext("2d")
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    draw()
  }, [width, height, dpr, draw])

  // Painting logic
  const toggleCell = useCallback((r, c, value) => {
    setGrid((prev) => {
      const next = cloneGrid(prev)
      next[r][c] = value
      return next
    })
  }, [])

  const pushUndo = useCallback((g) => {
    setUndoStack((u) => [...u, serializeGrid(g)])
    setRedoStack([])
  }, [])

  const onCanvasPointer = useCallback(
    (e) => {
      const rect = e.currentTarget.getBoundingClientRect()
      const mx = e.clientX - rect.left
      const my = e.clientY - rect.top
      const cx = Math.floor((mx - pad) / (cell + gap))
      const cy = Math.floor((my - pad) / (cell + gap))
      if (cy < 0 || cy >= rows || cx < 0 || cx >= cols) return
      const gx = pad + cx * (cell + gap)
      const gy = pad + cy * (cell + gap)
      if (mx >= gx && mx <= gx + cell && my >= gy && my <= gy + cell) {
        toggleCell(cy, cx, paintVal)
      }
    },
    [pad, cell, gap, rows, cols, toggleCell, paintVal],
  )

  const handlePointerDown = useCallback(
    (e) => {
      e.preventDefault()
      const erase = e.altKey || e.button === 2
      setPaintVal(!erase)
      setMouseDown(true)
      pushUndo(grid)
      onCanvasPointer(e)
    },
    [grid, onCanvasPointer, pushUndo],
  )

  const handlePointerMove = useCallback(
    (e) => {
      if (!mouseDown) return
      onCanvasPointer(e)
    },
    [mouseDown, onCanvasPointer],
  )

  const handlePointerUp = useCallback(() => setMouseDown(false), [])

  // Undo/redo
  const undo = useCallback(() => {
    setUndoStack((u) => {
      if (!u.length) return u
      const last = u[u.length - 1]
      setRedoStack((r) => [...r, serializeGrid(grid)])
      setGrid(deserializeGrid(last, rows, cols))
      return u.slice(0, -1)
    })
  }, [grid, rows, cols])

  const redo = useCallback(() => {
    setRedoStack((r) => {
      if (!r.length) return r
      const last = r[r.length - 1]
      setUndoStack((u) => [...u, serializeGrid(grid)])
      setGrid(deserializeGrid(last, rows, cols))
      return r.slice(0, -1)
    })
  }, [grid, rows, cols])

  // Resize grid while preserving content top-left
  const resizeGrid = useCallback(
    (nr, nc) => {
      nr = clamp(nr | 0, 1, 64)
      nc = clamp(nc | 0, 1, 64)
      const next = createGrid(nr, nc, false)
      for (let r = 0; r < Math.min(nr, rows); r++)
        for (let c = 0; c < Math.min(nc, cols); c++) next[r][c] = grid[r][c]
      setRows(nr)
      setCols(nc)
      setGrid(next)
    },
    [grid, rows, cols],
  )

  // Saves API
  const saveDesign = useCallback(
    (name = "Untitled") => {
      const entry = {
        id: uid(),
        name,
        rows,
        cols,
        grid: grid.map((r) => r.slice()),
        createdAt: Date.now(),
      }
      setSaves((prev) => {
        if (prev.length >= 5) {
          alert("You can save up to 5 designs. Delete one to save another.")
          return prev
        }
        return [...prev, entry]
      })
    },
    [grid, rows, cols],
  )

  const renameSave = useCallback((id, name) => {
    setSaves((prev) => prev.map((s) => (s.id === id ? { ...s, name } : s)))
  }, [])

  const deleteSave = useCallback((id) => {
    setSaves((prev) => prev.filter((s) => s.id !== id))
    setSelectedForMorph((sel) => sel.filter((x) => x !== id))
  }, [])

  const loadSave = useCallback(
    (id) => {
      const s = saves.find((x) => x.id === id)
      if (!s) return
      setRows(s.rows)
      setCols(s.cols)
      setGrid(cloneGrid(s.grid))
    },
    [saves],
  )

  const toggleSelect = useCallback((id) => {
    setSelectedForMorph((prev) => {
      const has = prev.includes(id)
      const next = has ? prev.filter((x) => x !== id) : [...prev, id]
      return next.slice(0, 5)
    })
  }, [])

  // Morph playback
  const [playing, setPlaying] = useState(false)
  const [fps, setFps] = useState(24)
  const [stepsPerMorph, setStepsPerMorph] = useState(20)
  const rafRef = useRef()
  const playStateRef = useRef({ index: 0, step: 0, base: null, diffs: [] })

  const stop = useCallback(() => {
    setPlaying(false)
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
  }, [])

  const start = useCallback(() => {
    if (selectedForMorph.length < 2) return
    const seq = selectedForMorph
      .map((id) => saves.find((s) => s.id === id))
      .filter(Boolean)
    if (seq.length < 2) return

    // normalise sizes to first design
    const base0 = seq[0]
    const norm = seq.map((s) => {
      if (s.rows !== base0.rows || s.cols !== base0.cols) {
        const g = createGrid(base0.rows, base0.cols, false)
        for (let r = 0; r < Math.min(base0.rows, s.rows); r++)
          for (let c = 0; c < Math.min(base0.cols, s.cols); c++) g[r][c] = s.grid[r][c]
        return { ...s, rows: base0.rows, cols: base0.cols, grid: g }
      }
      return s
    })

    setRows(base0.rows)
    setCols(base0.cols)
    setGrid(cloneGrid(base0.grid))

    playStateRef.current = {
      index: 0,
      step: 0,
      base: cloneGrid(base0.grid),
      diffs: gridDiffPositions(base0.grid, norm[1].grid),
      seq: norm,
    }

    setPlaying(true)

    let last = performance.now()
    const interval = 1000 / clamp(fps, 1, 60)

    const tick = (now) => {
      const st = playStateRef.current
      if (!st || !st.seq) return
      if (now - last < interval) {
        rafRef.current = requestAnimationFrame(tick)
        return
      }
      last = now

      const nxt = st.seq[st.index + 1]
      if (!nxt) {
        stop()
        return
      }

      // advance step
      st.step++
      const total = Math.max(1, stepsPerMorph)
      const diffs = st.diffs.length || 1
      const inc = Math.ceil((st.step / total) * diffs)
      const frameGrid = applyDiffStep(st.base, st.diffs, inc)
      setGrid(frameGrid)

      if (st.step >= total) {
        // move to next pair
        st.index++
        st.base = cloneGrid(nxt.grid)
        st.diffs = gridDiffPositions(
          nxt.grid,
          st.seq[st.index + 1]?.grid || nxt.grid,
        )
        st.step = 0
        setGrid(cloneGrid(nxt.grid))
      }

      rafRef.current = requestAnimationFrame(tick)
    }

    rafRef.current = requestAnimationFrame(tick)
  }, [selectedForMorph, saves, fps, stepsPerMorph, stop])

  useEffect(() => () => stop(), [stop])

  // Keybindings (match previous version: Ctrl/Cmd+Z = undo, Ctrl/Cmd+Y = redo)
  useEffect(() => {
    const onKey = (e) => {
      const key = (e.key || e.detail?.key || "").toLowerCase()
      const combo = e.ctrlKey || e.metaKey
      if (combo && key === "z") {
        e.preventDefault?.()
        undo()
      }
      if (combo && key === "y") {
        e.preventDefault?.()
        redo()
      }
    }
    document.addEventListener("keydown", onKey)
    document.addEventListener("pls:key", onKey)
    return () => {
      document.removeEventListener("keydown", onKey)
      document.removeEventListener("pls:key", onKey)
    }
  }, [undo, redo])

  // Exports
  const exportPNG = useCallback(() => {
    const cv = canvasRef.current
    if (!cv) return
    cv.toBlob((blob) => {
      if (!blob) return
      const a = document.createElement("a")
      a.href = URL.createObjectURL(blob)
      a.download = `pixel-logo-${rows}x${cols}.png`
      a.click()
      setTimeout(() => URL.revokeObjectURL(a.href), 1000)
    }, "image/png")
  }, [rows, cols])

  const exportSVG = useCallback(() => {
    const svg = buildSVG(grid, {
      cell,
      gap,
      pad,
      radiusBase: radius,
      concaveJoiners,
      blobTJunctions,
      fg,
      bg,
    })
    const blob = new Blob([svg], { type: "image/svg+xml" })
    const a = document.createElement("a")
    a.href = URL.createObjectURL(blob)
    a.download = `pixel-logo-${rows}x${cols}.svg`
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  }, [grid, cell, gap, pad, radius, concaveJoiners, blobTJunctions, fg, bg, rows, cols])

  const copySVG = useCallback(async () => {
    const svg = buildSVG(grid, {
      cell,
      gap,
      pad,
      radiusBase: radius,
      concaveJoiners,
      blobTJunctions,
      fg,
      bg,
    })
    await navigator.clipboard.writeText(svg)
    alert("SVG copied to clipboard")
  }, [grid, cell, gap, pad, radius, concaveJoiners, blobTJunctions, fg, bg])

  const exportJSON = useCallback(() => {
    const data = { rows, cols, grid }
    const blob = new Blob([JSON.stringify(data)], { type: "application/json" })
    const a = document.createElement("a")
    a.href = URL.createObjectURL(blob)
    a.download = `pixel-logo-${rows}x${cols}.json`
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  }, [rows, cols, grid])

  const loadJSON = useCallback((file) => {
    if (!file) return
    const fr = new FileReader()
    fr.onload = () => {
      try {
        const data = JSON.parse(String(fr.result || "{}"))
        if (!data || !Array.isArray(data.grid)) throw new Error("Invalid JSON")
        setRows((data.rows | 0) || 5)
        setCols((data.cols | 0) || 5)
        setGrid(data.grid.map((row) => row.map(Boolean)))
      } catch (error) {
        console.error("Failed to load JSON", error)
        alert("Failed to load JSON")
      }
    }
    fr.readAsText(file)
  }, [])

  const clearGrid = useCallback(() => {
    setGrid(createGrid(rows, cols, false))
  }, [rows, cols])

  // Export Frames ZIP for morph sequence
  const exportFramesZip = useCallback(async () => {
    if (selectedForMorph.length < 2) {
      alert("Select 2–5 saved designs for morph export.")
      return
    }
    const seq = selectedForMorph
      .map((id) => saves.find((s) => s.id === id))
      .filter(Boolean)
    if (seq.length < 2) return

    // Normalise to first dimensions
    const base0 = seq[0]
    const norm = seq.map((s) => {
      if (s.rows !== base0.rows || s.cols !== base0.cols) {
        const g = createGrid(base0.rows, base0.cols, false)
        for (let r = 0; r < Math.min(base0.rows, s.rows); r++)
          for (let c = 0; c < Math.min(base0.cols, s.cols); c++) g[r][c] = s.grid[r][c]
        return { ...s, rows: base0.rows, cols: base0.cols, grid: g }
      }
      return s
    })

    // Offscreen canvas render
    const cv = document.createElement("canvas")
    const dprVal = DPR()
    const W = pad * 2 + base0.cols * cell + (base0.cols - 1) * gap
    const H = pad * 2 + base0.rows * cell + (base0.rows - 1) * gap
    cv.width = Math.round(W * dprVal)
    cv.height = Math.round(H * dprVal)
    const ctx = cv.getContext("2d")
    ctx.setTransform(dprVal, 0, 0, dprVal, 0, 0)

    const zip = new JSZip()
    let frameNo = 0

    for (let i = 0; i < norm.length - 1; i++) {
      const a = norm[i].grid
      const b = norm[i + 1].grid
      const diffs = gridDiffPositions(a, b)
      const total = Math.max(1, stepsPerMorph)
      for (let step = 1; step <= total; step++) {
        const inc = Math.ceil((step / total) * diffs.length)
        const g = applyDiffStep(a, diffs, inc)
        drawGridToCanvas(ctx, g, {
          cell,
          gap,
          pad,
          fg,
          bg,
          radiusBase: radius,
          concaveJoiners,
          blobTJunctions,
        })
        const blob = await new Promise((res) => cv.toBlob(res, "image/png"))
        if (blob) {
          const arrBuf = await blob.arrayBuffer()
          const name = `frame_${String(frameNo).padStart(4, "0")}.png`
          zip.file(name, arrBuf)
          frameNo++
        }
      }
    }

    const content = await zip.generateAsync({ type: "blob" })
    const a = document.createElement("a")
    a.href = URL.createObjectURL(content)
    a.download = `morph_frames_${base0.rows}x${base0.cols}_${frameNo}f.zip`
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  }, [
    selectedForMorph,
    saves,
    stepsPerMorph,
    pad,
    cell,
    gap,
    radius,
    concaveJoiners,
    blobTJunctions,
    fg,
    bg,
  ])

  // UI helpers
  const onWheelScale = useCallback((e) => {
    if (!e.ctrlKey) return // pinch-zoom style
    e.preventDefault()
    const delta = e.deltaY < 0 ? 1 : -1
    setCell((v) => clamp(v + delta * 2, 8, 80))
  }, [])

  return (
    <div className="min-h-screen bg-white text-neutral-900">
      <header className="sticky top-0 z-10 bg-white/80 backdrop-blur border-b">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between">
          <h1 className="font-semibold tracking-tight">
            Pixel Logo Studio <span className="text-neutral-400">v3.7</span>
          </h1>
          <div className="flex items-center gap-2 text-sm">
            <button
              onClick={undo}
              className="px-2 py-1 rounded border hover:bg-neutral-50 disabled:opacity-50 disabled:pointer-events-none"
              title="Undo (Z)"
              disabled={undoStack.length === 0}
            >
              Undo
            </button>
            <button
              onClick={redo}
              className="px-2 py-1 rounded border hover:bg-neutral-50 disabled:opacity-50 disabled:pointer-events-none"
              title="Redo (Y)"
              disabled={redoStack.length === 0}
            >
              Redo
            </button>
            <button
              onClick={() => saveDesign(prompt("Save name?", "Design") || "Design")}
              className="px-2 py-1 rounded border hover:bg-neutral-50"
            >
              Save
            </button>
            <button onClick={clearGrid} className="px-2 py-1 rounded border hover:bg-neutral-50">
              Clear
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto grid md:grid-cols-[1fr,360px] gap-6 p-4">
        {/* Canvas area */}
        <section className="rounded-2xl border p-3">
          <div className="flex items-center justify-between mb-3 text-sm">
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-2">
                Rows
                <input
                  type="number"
                  className="w-16 border rounded px-2 py-1"
                  value={rows}
                  onChange={(e) => resizeGrid(parseInt(e.target.value || 1, 10), cols)}
                />
              </label>
              <label className="flex items-center gap-2">
                Cols
                <input
                  type="number"
                  className="w-16 border rounded px-2 py-1"
                  value={cols}
                  onChange={(e) => resizeGrid(rows, parseInt(e.target.value || 1, 10))}
                />
              </label>
              <label className="flex items-center gap-2">
                Cell
                <input
                  type="number"
                  className="w-16 border rounded px-2 py-1"
                  value={cell}
                  onChange={(e) => setCell(clamp(parseInt(e.target.value || 8, 10), 8, 80))}
                />
              </label>
              <label className="flex items-center gap-2">
                Gap
                <input
                  type="number"
                  className="w-16 border rounded px-2 py-1"
                  value={gap}
                  onChange={(e) => setGap(clamp(parseInt(e.target.value || 0, 10), 0, 24))}
                />
              </label>
              <label className="flex items-center gap-2">
                Pad
                <input
                  type="number"
                  className="w-16 border rounded px-2 py-1"
                  value={pad}
                  onChange={(e) => setPad(clamp(parseInt(e.target.value || 0, 10), 0, 72))}
                />
              </label>
              <label className="flex items-center gap-2">
                Radius
                <input
                  type="number"
                  className="w-16 border rounded px-2 py-1"
                  value={radius}
                  onChange={(e) =>
                    setRadius(clamp(parseInt(e.target.value || 0, 10), 0, Math.floor(cell / 2)))
                  }
                />
              </label>
            </div>
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={concaveJoiners}
                  onChange={(e) => setConcaveJoiners(e.target.checked)}
                />
                Concave
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={blobTJunctions}
                  onChange={(e) => setBlobTJunctions(e.target.checked)}
                />
                T-junctions
              </label>
            </div>
          </div>

          <div onWheel={onWheelScale} className="overflow-auto">
            <canvas
              ref={canvasRef}
              onContextMenu={(e) => e.preventDefault()}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              width={Math.round(width * dpr)}
              height={Math.round(height * dpr)}
              style={{ width: `${width}px`, height: `${height}px`, touchAction: "none" }}
              className="border rounded-xl block mx-auto bg-white"
            />
            <p className="text-xs text-neutral-500 mt-2">
              Tip: hold Alt/Option (or right-click) to erase while dragging. Pinch-zoom or
              Ctrl+Scroll to scale cell size.
            </p>
          </div>
        </section>

        {/* Sidebar */}
        <aside className="rounded-2xl border p-3 space-y-4">
          <section>
            <h2 className="font-medium mb-2">Export</h2>
            <div className="grid grid-cols-2 gap-2">
              <button onClick={exportPNG} className="px-3 py-2 rounded border hover:bg-neutral-50">
                PNG
              </button>
              <button onClick={exportSVG} className="px-3 py-2 rounded border hover:bg-neutral-50">
                SVG
              </button>
              <button onClick={copySVG} className="px-3 py-2 rounded border hover:bg-neutral-50">
                Copy SVG
              </button>
              <button onClick={exportJSON} className="px-3 py-2 rounded border hover:bg-neutral-50">
                JSON
              </button>
            </div>
            <div className="mt-2">
              <label className="block text-sm">
                Load JSON
                <input
                  type="file"
                  accept="application/json"
                  onChange={(e) => loadJSON(e.target.files?.[0])}
                  className="mt-1 block w-full text-sm"
                />
              </label>
            </div>
          </section>

          <section>
            <h2 className="font-medium mb-2">Morph</h2>
            <div className="flex items-center gap-2 mb-2">
              <label className="flex items-center gap-2 text-sm">
                FPS
                <input
                  type="number"
                  className="w-16 border rounded px-2 py-1"
                  value={fps}
                  onChange={(e) => setFps(clamp(parseInt(e.target.value || 24, 10), 1, 60))}
                />
              </label>
              <label className="flex items-center gap-2 text-sm">
                Steps
                <input
                  type="number"
                  className="w-16 border rounded px-2 py-1"
                  value={stepsPerMorph}
                  onChange={(e) =>
                    setStepsPerMorph(clamp(parseInt(e.target.value || 20, 10), 1, 200))
                  }
                />
              </label>
            </div>
            <div className="flex items-center gap-2">
              {!playing ? (
                <button
                  onClick={start}
                  className="px-3 py-2 rounded border hover:bg-neutral-50 disabled:opacity-50"
                  disabled={selectedForMorph.length < 2}
                >
                  Play
                </button>
              ) : (
                <button onClick={stop} className="px-3 py-2 rounded border hover:bg-neutral-50">
                  Stop
                </button>
              )}
              <button onClick={exportFramesZip} className="px-3 py-2 rounded border hover:bg-neutral-50">
                Export Frames (ZIP)
              </button>
            </div>
          </section>

          <section>
            <h2 className="font-medium mb-2">Saves (max 5)</h2>
            <ul className="space-y-2">
              {saves.map((s) => (
                <li key={s.id} className="border rounded p-2">
                  <div className="flex items-center gap-2 justify-between">
                    <div className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={selectedForMorph.includes(s.id)}
                        onChange={() => toggleSelect(s.id)}
                      />
                      <button
                        onClick={() => loadSave(s.id)}
                        className="px-2 py-1 rounded border hover:bg-neutral-50 text-xs"
                      >
                        Load
                      </button>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() =>
                          renameSave(s.id, prompt("Rename save", s.name) || s.name)
                        }
                        className="px-2 py-1 rounded border hover:bg-neutral-50 text-xs"
                      >
                        Rename
                      </button>
                      <button
                        onClick={() => deleteSave(s.id)}
                        className="px-2 py-1 rounded border hover:bg-neutral-50 text-xs"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                  <div className="mt-1 text-xs text-neutral-600 truncate">
                    {s.name} · {s.rows}×{s.cols}
                  </div>
                </li>
              ))}
            </ul>
            {!saves.length && (
              <p className="text-xs text-neutral-500">
                No saves yet. Click <em>Save</em> in the header.
              </p>
            )}
          </section>

          <section>
            <h2 className="font-medium mb-2">Shortcuts</h2>
            <ul className="text-sm list-disc pl-5 space-y-1 text-neutral-700">
              <li>Drag to paint; hold Alt/Option or right-click to erase</li>
              <li>Ctrl/Cmd + Z / Y for undo/redo</li>
              <li>Ctrl + Scroll (or pinch) to adjust cell size quickly</li>
            </ul>
          </section>
        </aside>
      </main>

      <footer className="max-w-6xl mx-auto px-4 pb-6 text-xs text-neutral-500">
        Pixel Logo Studio renders rounded pixels with neighbour-aware corners to approximate
        concave joins and T-junction blobs.
      </footer>
    </div>
  )
}

// Global keybinds
if (typeof window !== "undefined") {
  window.__pls_keybinds__ ||= (() => {
    const handler = (e) => {
      const isInput = ["INPUT", "TEXTAREA"].includes((e.target || {}).tagName)
      if (isInput) return
      const ev = new Event("pls:key", { bubbles: true })
      ev.key = e.key.toLowerCase()
      document.dispatchEvent(ev)
    }
    window.addEventListener("keydown", handler)
    return true
  })()
}
