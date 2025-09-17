# Pixel Logo Studio

A React + Vite implementation of the Pixel Logo Studio v3.7 playground. The app lets you draw on a pixel grid, store multiple logo variations, morph between them, and export your work as PNG, SVG, JSON, or a ZIP archive containing morph frames.

## Getting started

```bash
npm install
npm run dev
```

The dev server runs at [http://localhost:5173](http://localhost:5173) by default.

## Available scripts

- `npm run dev` – start the Vite dev server with hot reloading.
- `npm run build` – generate a production build.
- `npm run preview` – preview the production build locally.
- `npm run lint` – run ESLint against the project source.

## Features

- Click or drag on the canvas to paint pixels. Hold `Alt`/`Option` (or right-click) to erase while dragging.
- Save up to five designs in local storage. Rename, delete, or load designs from the sidebar.
- Select between two and five saved designs to morph between them with adjustable FPS and steps-per-morph.
- Export the current design to PNG, SVG, JSON, or copy the SVG markup directly to your clipboard.
- Export the entire morph sequence as a ZIP archive of PNG frames.
- Customize grid dimensions, pixel size, gap, padding, corner radius, and neighbour-aware smoothing.

## Styling

Tailwind CSS powers the utility-first styles used throughout the interface. The design defaults to a light theme with neutral accents to keep your artwork in focus.
