/**
 * Canvas illustrations for FIVE / SLICE.
 *
 * The playable board is deliberately 2D and readable; these drawings supply
 * the third dimension: the home hero shows two intersecting planes and a cut
 * line, and the result card reconstructs the winning line inside the cube.
 */

import { BLACK, coordOf, planeInfo } from './engine.js';

const INK = '#05090c';
const GOLD = '#e3b86f';
const JADE = '#77e2d2';
const IVORY = '#f3ead7';

function fitCanvas(canvas) {
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(1, rect.width);
  const height = Math.max(1, rect.height);
  const backingWidth = Math.max(1, Math.round(width * dpr));
  const backingHeight = Math.max(1, Math.round(height * dpr));
  if (canvas.width !== backingWidth || canvas.height !== backingHeight) {
    canvas.width = backingWidth;
    canvas.height = backingHeight;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, width, height };
}

function cubePoint(value) {
  return (value / 4 - 1) * 0.94;
}

function createProjector(width, height, yaw, pitch, scaleFactor = 0.29) {
  const cx = width * 0.53;
  const cy = height * 0.51;
  const scale = Math.min(width, height) * scaleFactor;
  return (x, y, z) => {
    const cosY = Math.cos(yaw);
    const sinY = Math.sin(yaw);
    const x1 = x * cosY - z * sinY;
    const z1 = x * sinY + z * cosY;
    const cosX = Math.cos(pitch);
    const sinX = Math.sin(pitch);
    const y1 = y * cosX - z1 * sinX;
    const z2 = y * sinX + z1 * cosX;
    const perspective = 3.4 / (3.4 + z2 * 0.72);
    return {
      x: cx + x1 * scale * perspective,
      y: cy - y1 * scale * perspective,
      depth: z2,
      scale: perspective,
    };
  };
}

function strokePolygon(ctx, points, stroke, width = 1) {
  ctx.beginPath();
  points.forEach((point, index) => {
    if (index === 0) ctx.moveTo(point.x, point.y);
    else ctx.lineTo(point.x, point.y);
  });
  ctx.closePath();
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = width;
    ctx.stroke();
  }
}

function fillPolygon(ctx, points, fill) {
  ctx.beginPath();
  points.forEach((point, index) => {
    if (index === 0) ctx.moveTo(point.x, point.y);
    else ctx.lineTo(point.x, point.y);
  });
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
}

function planeCorners(project, axis, value) {
  const v = value;
  if (axis === 'z') {
    return [
      project(-1, -1, v),
      project(1, -1, v),
      project(1, 1, v),
      project(-1, 1, v),
    ];
  }
  if (axis === 'y') {
    return [
      project(-1, v, -1),
      project(1, v, -1),
      project(1, v, 1),
      project(-1, v, 1),
    ];
  }
  return [
    project(v, -1, -1),
    project(v, 1, -1),
    project(v, 1, 1),
    project(v, -1, 1),
  ];
}

function drawPlaneGrid(ctx, project, axis, value, color, alpha = 0.22) {
  const corners = planeCorners(project, axis, value);
  fillPolygon(ctx, corners, hexToRgba(color, 0.035));
  strokePolygon(ctx, corners, hexToRgba(color, alpha * 1.4), 0.9);
  ctx.save();
  ctx.strokeStyle = hexToRgba(color, alpha);
  ctx.lineWidth = 0.7;
  const steps = 8;
  for (let i = 0; i <= steps; i += 1) {
    const t = -1 + (2 * i) / steps;
    let a;
    let b;
    if (axis === 'z') {
      a = project(-1, t, value);
      b = project(1, t, value);
    } else if (axis === 'y') {
      a = project(-1, value, t);
      b = project(1, value, t);
    } else {
      a = project(value, -1, t);
      b = project(value, 1, t);
    }
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    if (axis === 'z') {
      a = project(t, -1, value);
      b = project(t, 1, value);
    } else if (axis === 'y') {
      a = project(t, value, -1);
      b = project(t, value, 1);
    } else {
      a = project(value, t, -1);
      b = project(value, t, 1);
    }
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
  ctx.restore();
}

function drawCubeWire(ctx, project, alpha = 0.12) {
  const edges = [
    [[-1, -1, -1], [1, -1, -1]],
    [[1, -1, -1], [1, -1, 1]],
    [[1, -1, 1], [-1, -1, 1]],
    [[-1, -1, 1], [-1, -1, -1]],
    [[-1, 1, -1], [1, 1, -1]],
    [[1, 1, -1], [1, 1, 1]],
    [[1, 1, 1], [-1, 1, 1]],
    [[-1, 1, 1], [-1, 1, -1]],
    [[-1, -1, -1], [-1, 1, -1]],
    [[1, -1, -1], [1, 1, -1]],
    [[1, -1, 1], [1, 1, 1]],
    [[-1, -1, 1], [-1, 1, 1]],
  ];
  ctx.save();
  ctx.strokeStyle = `rgba(192, 225, 222, ${alpha})`;
  ctx.lineWidth = 0.9;
  for (const [from, to] of edges) {
    const a = project(...from);
    const b = project(...to);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
  ctx.restore();
}

function drawAxisLabels(ctx, project, width, height) {
  const labels = [
    { text: 'X', point: project(1.17, -1, -1), color: GOLD },
    { text: 'Y', point: project(-1, 1, -1), color: JADE },
    { text: 'Z', point: project(-1, -1, 1.18), color: '#a7b8d4' },
  ];
  ctx.save();
  ctx.font = '600 10px "IBM Plex Mono", "SFMono-Regular", Consolas, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const item of labels) {
    if (item.point.x < 10 || item.point.x > width - 10) continue;
    if (item.point.y < 10 || item.point.y > height - 10) continue;
    ctx.fillStyle = item.color;
    ctx.globalAlpha = 0.62;
    ctx.fillText(item.text, item.point.x, item.point.y);
  }
  ctx.restore();
}

function drawStone(ctx, point, color, radius = 7.2, options = {}) {
  const { glow = 0, used = false, winning = false } = options;
  const r = radius * point.scale;
  ctx.save();
  if (glow > 0) {
    const halo = ctx.createRadialGradient(point.x, point.y, 0, point.x, point.y, r * 2.4);
    halo.addColorStop(0, color === BLACK ? 'rgba(113, 234, 218, 0.22)' : 'rgba(242, 204, 130, 0.22)');
    halo.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(point.x, point.y, r * 2.4, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.beginPath();
  ctx.arc(point.x + r * 0.14, point.y + r * 0.2, r, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0,0,0,.38)';
  ctx.fill();

  const gradient = ctx.createRadialGradient(
    point.x - r * 0.32,
    point.y - r * 0.34,
    r * 0.1,
    point.x,
    point.y,
    r * 1.05,
  );
  if (color === BLACK) {
    gradient.addColorStop(0, '#60727a');
    gradient.addColorStop(0.28, '#27343b');
    gradient.addColorStop(0.75, '#091014');
    gradient.addColorStop(1, '#020507');
  } else {
    gradient.addColorStop(0, '#fffdf6');
    gradient.addColorStop(0.42, '#efe4d0');
    gradient.addColorStop(0.83, '#c6b79e');
    gradient.addColorStop(1, '#978870');
  }
  ctx.beginPath();
  ctx.arc(point.x, point.y, r, 0, Math.PI * 2);
  ctx.fillStyle = gradient;
  ctx.fill();
  ctx.lineWidth = 0.8;
  ctx.strokeStyle =
    color === BLACK ? 'rgba(181, 227, 224, 0.35)' : 'rgba(255, 248, 230, 0.65)';
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(point.x - r * 0.28, point.y - r * 0.32, r * 0.16, 0, Math.PI * 2);
  ctx.fillStyle = color === BLACK ? 'rgba(232, 248, 244, 0.55)' : 'rgba(255,255,255,0.72)';
  ctx.fill();

  if (used) {
    ctx.strokeStyle = JADE;
    ctx.lineWidth = Math.min(1.2, r * 0.18);
    ctx.beginPath();
    ctx.moveTo(point.x - r * 0.56, point.y + r * 0.5);
    ctx.lineTo(point.x + r * 0.45, point.y - r * 0.62);
    ctx.stroke();
  }
  if (winning) {
    ctx.strokeStyle = GOLD;
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    ctx.arc(point.x, point.y, r + 2.4, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

function hexToRgba(hex, alpha) {
  const value = hex.replace('#', '');
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

const HERO_STONES = [
  { coord: [-0.5, -0.5, 0], color: BLACK, used: true },
  { coord: [-0.25, -0.5, 0], color: BLACK },
  { coord: [0, -0.5, 0], color: BLACK },
  { coord: [0.25, -0.5, 0], color: BLACK },
  { coord: [-0.5, -0.25, 0], color: 2 },
  { coord: [0.25, -0.25, 0], color: 2 },
  { coord: [0.5, 0, 0.25], color: 2 },
  { coord: [0, 0.4, 0.25], color: BLACK },
  { coord: [-0.25, 0.4, 0.25], color: 2 },
];

const HERO_DUST = (() => {
  let seed = 17;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  return Array.from({ length: 34 }, () => ({
    x: rand(),
    y: rand(),
    r: 0.4 + rand() * 1.2,
    phase: rand() * Math.PI * 2,
    speed: 0.25 + rand() * 0.6,
  }));
})();

function drawHeroFrame(ctx, width, height, time) {
  ctx.clearRect(0, 0, width, height);

  // Stars/dust behind the cube.
  for (const dust of HERO_DUST) {
    const x = dust.x * width;
    const y = dust.y * height;
    const alpha = 0.14 + 0.12 * Math.sin(time * dust.speed + dust.phase);
    ctx.beginPath();
    ctx.arc(x, y, dust.r, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(171, 225, 218, ${alpha})`;
    ctx.fill();
  }

  const yaw = -0.6 + Math.sin(time * 0.16) * 0.055;
  const pitch = 0.36 + Math.sin(time * 0.11) * 0.02;
  const project = createProjector(width, height, yaw, pitch, 0.3);

  // Halo behind the cube.
  const halo = ctx.createRadialGradient(
    width * 0.52,
    height * 0.48,
    0,
    width * 0.52,
    height * 0.48,
    Math.min(width, height) * 0.45,
  );
  halo.addColorStop(0, 'rgba(59, 154, 144, 0.15)');
  halo.addColorStop(0.55, 'rgba(39, 89, 84, 0.05)');
  halo.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = halo;
  ctx.fillRect(0, 0, width, height);

  drawCubeWire(ctx, project, 0.1);
  drawAxisLabels(ctx, project, width, height);

  // The current plane, warm and horizontal.
  drawPlaneGrid(ctx, project, 'z', 0, GOLD, 0.18);

  // The plane the cut would enter.
  drawPlaneGrid(ctx, project, 'y', -0.5, JADE, 0.24);

  // Shared line.
  const lineA = project(-1, -0.5, 0);
  const lineB = project(1, -0.5, 0);
  ctx.save();
  ctx.lineCap = 'round';
  ctx.strokeStyle = 'rgba(119, 226, 210, 0.1)';
  ctx.lineWidth = 16;
  ctx.beginPath();
  ctx.moveTo(lineA.x, lineA.y);
  ctx.lineTo(lineB.x, lineB.y);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(119, 226, 210, 0.5)';
  ctx.lineWidth = 2.4;
  ctx.beginPath();
  ctx.moveTo(lineA.x, lineA.y);
  ctx.lineTo(lineB.x, lineB.y);
  ctx.stroke();
  const pulse = (time * 0.24) % 1;
  const pulsePoint = {
    x: lineA.x + (lineB.x - lineA.x) * pulse,
    y: lineA.y + (lineB.y - lineA.y) * pulse,
    scale: 1,
  };
  ctx.shadowBlur = 14;
  ctx.shadowColor = JADE;
  ctx.fillStyle = JADE;
  ctx.beginPath();
  ctx.arc(pulsePoint.x, pulsePoint.y, 3.2, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.restore();

  // Stones, sorted back to front.
  const projected = HERO_STONES.map((stone) => ({
    ...stone,
    point: project(...stone.coord),
    wx: (stone.coord[0] / 4) * width,
  })).sort((a, b) => a.point.depth - b.point.depth);
  for (const stone of projected) {
    const nearPulse = 1 - Math.min(1, Math.abs(stone.coord[0] - (-1 + pulse * 2)) / 1.6);
    drawStone(ctx, stone.point, stone.color, stone.coord[2] === 0 ? 7.4 : 6.6, {
      used: Boolean(stone.used),
      glow: 0.3 + nearPulse * 0.7,
    });
  }

  // A small ghost stone waiting on the target plane.
  const ghost = project(0.5, -0.5, 0.42);
  ctx.save();
  ctx.beginPath();
  ctx.arc(ghost.x, ghost.y, 6.8 * ghost.scale, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(119, 226, 210, 0.45)';
  ctx.lineWidth = 1;
  ctx.setLineDash([2, 3]);
  ctx.stroke();
  ctx.restore();

  // A faint scanning plane to suggest motion.
  const scanT = (time * 0.1) % 1;
  const scanLine = project(-1 + scanT * 2, -1, 1);
  const scanLine2 = project(-1 + scanT * 2, 1, 1);
  ctx.save();
  ctx.strokeStyle = 'rgba(227, 184, 111, 0.12)';
  ctx.lineWidth = 0.8;
  ctx.beginPath();
  ctx.moveTo(scanLine.x, scanLine.y);
  ctx.lineTo(scanLine2.x, scanLine2.y);
  ctx.stroke();
  ctx.restore();
}

export function mountHero(canvas) {
  if (!canvas) return () => {};
  let running = true;
  let raf = 0;
  let width = 0;
  let height = 0;
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  const resize = () => {
    const rect = canvas.getBoundingClientRect();
    width = rect.width;
    height = rect.height;
  };
  const observer = new ResizeObserver(resize);
  observer.observe(canvas);
  resize();

  const frame = (timestamp) => {
    if (!running) return;
    if (width <= 1 || height <= 1) {
      raf = requestAnimationFrame(frame);
      return;
    }
    const { ctx, width: w, height: h } = fitCanvas(canvas);
    drawHeroFrame(ctx, w, h, reduced ? 2.2 : timestamp / 1000);
    if (!reduced) raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);

  return () => {
    running = false;
    cancelAnimationFrame(raf);
    observer.disconnect();
  };
}

export function drawResultCube(canvas, options = {}) {
  if (!canvas) return;
  const { line = null, color = BLACK, plane = null } = options;
  const { ctx, width, height } = fitCanvas(canvas);
  ctx.clearRect(0, 0, width, height);

  const project = createProjector(width, height, -0.62, 0.4, 0.31);
  const halo = ctx.createRadialGradient(
    width * 0.5,
    height * 0.5,
    0,
    width * 0.5,
    height * 0.5,
    Math.min(width, height) * 0.55,
  );
  halo.addColorStop(0, 'rgba(115, 211, 199, 0.09)');
  halo.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = halo;
  ctx.fillRect(0, 0, width, height);

  drawCubeWire(ctx, project, 0.16);

  if (Number.isInteger(plane)) {
    const info = planeInfo(plane);
    drawPlaneGrid(ctx, project, info.axisName, cubePoint(info.value), GOLD, 0.11);
  }

  if (!Array.isArray(line) || line.length === 0) {
    ctx.save();
    ctx.fillStyle = 'rgba(233, 234, 221, 0.3)';
    ctx.font = '500 12px "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('没有五连线', width / 2, height - 16);
    ctx.restore();
    return;
  }

  const points = line.map((index) => {
    const c = coordOf(index);
    return {
      coord: [cubePoint(c.x), cubePoint(c.y), cubePoint(c.z)],
      point: project(cubePoint(c.x), cubePoint(c.y), cubePoint(c.z)),
    };
  });

  const first = points[0].point;
  const last = points[points.length - 1].point;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.strokeStyle = 'rgba(227, 184, 111, 0.13)';
  ctx.lineWidth = 12;
  ctx.beginPath();
  ctx.moveTo(first.x, first.y);
  ctx.lineTo(last.x, last.y);
  ctx.stroke();
  ctx.strokeStyle = hexToRgba(GOLD, 0.8);
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(first.x, first.y);
  ctx.lineTo(last.x, last.y);
  ctx.stroke();
  ctx.restore();

  for (const item of points) {
    drawStone(ctx, item.point, color, 7.8, { winning: true, glow: 0.8 });
  }

  drawAxisLabels(ctx, project, width, height);

  // Coordinate readout is intentionally left to the DOM around the canvas.
}
