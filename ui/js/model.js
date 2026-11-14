import { api } from './api.js';
import { state } from './state.js';

const FACET_EXTS = new Set(['stl', 'obj', 'ply', '3mf']);
const SPEED = 0.22;
const FRAME_MS = 33;
const FIT = 0.86;
const STRIDE = 24;

let active = null;

export function isRotatableModel(info) {
  return Boolean(
    info && !info.isDir && info.kind === 'model' && FACET_EXTS.has((info.ext || '').toLowerCase())
  );
}

function unit(x, y, z) {
  const length = Math.hypot(x, y, z);
  return length > 1e-9 ? [x / length, y / length, z / length] : null;
}

const FORWARD = unit(-1, -1, -1);
const RIGHT = unit(FORWARD[1], -FORWARD[0], 0);
const UP = [
  RIGHT[1] * FORWARD[2] - RIGHT[2] * FORWARD[1],
  RIGHT[2] * FORWARD[0] - RIGHT[0] * FORWARD[2],
  RIGHT[0] * FORWARD[1] - RIGHT[1] * FORWARD[0],
];

const VERTEX_300 = `#version 300 es
in vec3 aPos;
in vec3 aNormal;
in vec3 aColor;
uniform vec3 uRight;
uniform vec3 uUp;
uniform vec3 uForward;
uniform vec2 uScale;
uniform float uDepth;
out vec3 vNormal;
out vec3 vColor;
out float vDepth;
void main() {
  vec3 p = vec3(dot(aPos, uRight), dot(aPos, uUp), dot(aPos, uForward));
  vNormal = vec3(dot(aNormal, uRight), dot(aNormal, uUp), dot(aNormal, uForward));
  vColor = aColor;
  vDepth = p.z;
  gl_Position = vec4(p.x * uScale.x, p.y * uScale.y, p.z * uDepth, 1.0);
}`;

const FRAGMENT_300 = `#version 300 es
precision highp float;
in vec3 vNormal;
in vec3 vColor;
in float vDepth;
uniform float uRadius;
out vec4 outColor;
void main() {
  vec3 n = normalize(vNormal);
  if (n.z > 0.0) n = -n;
  vec3 key = normalize(vec3(1.0, 1.1, -1.4));
  vec3 fill = normalize(vec3(1.2, -0.3, -1.0));
  float diffuse = 0.20 + 0.66 * max(dot(n, key), 0.0) + 0.24 * max(dot(n, fill), 0.0);
  float fade = 1.0 - 0.30 * clamp((vDepth + uRadius) / (2.0 * uRadius), 0.0, 1.0);
  outColor = vec4(min(vColor * diffuse, vec3(1.0)) * fade, 1.0);
}`;

const VERTEX_100 = `attribute vec3 aPos;
attribute vec3 aNormal;
attribute vec3 aColor;
uniform vec3 uRight;
uniform vec3 uUp;
uniform vec3 uForward;
uniform vec2 uScale;
uniform float uDepth;
varying vec3 vNormal;
varying vec3 vColor;
varying float vDepth;
void main() {
  vec3 p = vec3(dot(aPos, uRight), dot(aPos, uUp), dot(aPos, uForward));
  vNormal = vec3(dot(aNormal, uRight), dot(aNormal, uUp), dot(aNormal, uForward));
  vColor = aColor;
  vDepth = p.z;
  gl_Position = vec4(p.x * uScale.x, p.y * uScale.y, p.z * uDepth, 1.0);
}`;

const FRAGMENT_100 = `precision mediump float;
varying vec3 vNormal;
varying vec3 vColor;
varying float vDepth;
uniform float uRadius;
void main() {
  vec3 n = normalize(vNormal);
  if (n.z > 0.0) n = -n;
  vec3 key = normalize(vec3(1.0, 1.1, -1.4));
  vec3 fill = normalize(vec3(1.2, -0.3, -1.0));
  float diffuse = 0.20 + 0.66 * max(dot(n, key), 0.0) + 0.24 * max(dot(n, fill), 0.0);
  float fade = 1.0 - 0.30 * clamp((vDepth + uRadius) / (2.0 * uRadius), 0.0, 1.0);
  gl_FragColor = vec4(min(vColor * diffuse, vec3(1.0)) * fade, 1.0);
}`;

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader;
  gl.deleteShader(shader);
  return null;
}

function buildProgram(gl, modern) {
  const vertex = compile(gl, gl.VERTEX_SHADER, modern ? VERTEX_300 : VERTEX_100);
  const fragment = compile(gl, gl.FRAGMENT_SHADER, modern ? FRAGMENT_300 : FRAGMENT_100);
  if (!vertex || !fragment) {
    if (vertex) gl.deleteShader(vertex);
    if (fragment) gl.deleteShader(fragment);
    return null;
  }
  const program = gl.createProgram();
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  // Attribute 0 must stay an enabled array; a constant color attribute there is slow or broken on some drivers.
  gl.bindAttribLocation(program, 0, 'aPos');
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program);
    return null;
  }
  return {
    program,
    pos: gl.getAttribLocation(program, 'aPos'),
    normal: gl.getAttribLocation(program, 'aNormal'),
    color: gl.getAttribLocation(program, 'aColor'),
    right: gl.getUniformLocation(program, 'uRight'),
    up: gl.getUniformLocation(program, 'uUp'),
    forward: gl.getUniformLocation(program, 'uForward'),
    scale: gl.getUniformLocation(program, 'uScale'),
    depth: gl.getUniformLocation(program, 'uDepth'),
    radiusLoc: gl.getUniformLocation(program, 'uRadius'),
  };
}

function createRenderer(canvas) {
  const options = {
    alpha: true,
    antialias: true,
    depth: true,
    premultipliedAlpha: false,
    powerPreference: 'low-power',
  };
  let gl = null;
  let modern = true;
  try {
    gl = canvas.getContext('webgl2', options);
  } catch {
    gl = null;
  }
  if (!gl) {
    modern = false;
    try {
      gl = canvas.getContext('webgl', options);
    } catch {
      return null;
    }
  }
  if (!gl) return null;
  const attrs = buildProgram(gl, modern);
  if (!attrs) return null;
  return { gl, ...attrs };
}

const SCENE_MAGIC = 0x7fc0334d;
const DEFAULT_TONE = [236, 240, 248];

function floatsAt(bytes, offset, length) {
  const start = bytes.byteOffset + offset;
  if (start % 4 === 0) return new Float32Array(bytes.buffer, start, length);
  return new Float32Array(bytes.slice(offset, offset + length * 4).buffer);
}

/** Plain payloads are bare corners; 3MF scenes carry a header, per-facet RGBA and info JSON. */
function readPayload(buffer) {
  const bytes =
    buffer instanceof ArrayBuffer
      ? new Uint8Array(buffer)
      : ArrayBuffer.isView(buffer)
        ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
        : null;
  if (!bytes || bytes.byteLength < 36) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== SCENE_MAGIC) {
    return { corners: floatsAt(bytes, 0, bytes.byteLength >> 2), colors: null, info: null };
  }
  const count = view.getUint32(8, true);
  const infoLength = view.getUint32(12, true);
  const colorStart = 16 + count * 36;
  const infoStart = colorStart + count * 4;
  if (infoStart + infoLength > bytes.byteLength) return null;
  let info = null;
  try {
    info = JSON.parse(new TextDecoder().decode(bytes.subarray(infoStart, infoStart + infoLength)));
  } catch {
    info = null;
  }
  return {
    corners: floatsAt(bytes, 16, count * 9),
    colors: bytes.subarray(colorStart, infoStart),
    info,
  };
}

function vertexColors(colors, facets) {
  if (!colors || colors.length < facets * 4) return null;
  const out = new Uint8Array(facets * 12);
  let tinted = false;
  for (let facet = 0; facet < facets; facet += 1) {
    const src = facet * 4;
    const lit = colors[src + 3] !== 0;
    if (lit) tinted = true;
    for (let channel = 0; channel < 3; channel += 1) {
      const value = lit ? Math.round(24 + 0.9 * colors[src + channel]) : DEFAULT_TONE[channel];
      for (let corner = 0; corner < 3; corner += 1) out[facet * 12 + corner * 4 + channel] = value;
    }
  }
  return tinted ? out : null;
}

function buildGeometry(raw) {
  if (!raw) return null;
  const facets = Math.floor(raw.length / 9);
  if (!facets) return null;

  const low = [Infinity, Infinity, Infinity];
  const high = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < facets * 9; i += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = raw[i + axis];
      if (value < low[axis]) low[axis] = value;
      if (value > high[axis]) high[axis] = value;
    }
  }
  if (!Number.isFinite(low[0]) || !Number.isFinite(high[0])) return null;
  const center = [(low[0] + high[0]) / 2, (low[1] + high[1]) / 2, (low[2] + high[2]) / 2];
  const radius = Math.max(
    1e-6,
    0.5 * Math.hypot(high[0] - low[0], high[1] - low[1], high[2] - low[2])
  );

  const data = new Float32Array(facets * 18);
  for (let facet = 0; facet < facets; facet += 1) {
    const src = facet * 9;
    const dst = facet * 18;
    for (let corner = 0; corner < 3; corner += 1) {
      data[dst + corner * 6] = raw[src + corner * 3] - center[0];
      data[dst + corner * 6 + 1] = raw[src + corner * 3 + 1] - center[1];
      data[dst + corner * 6 + 2] = raw[src + corner * 3 + 2] - center[2];
    }
    const ax = data[dst];
    const ay = data[dst + 1];
    const az = data[dst + 2];
    const bx = data[dst + 6];
    const by = data[dst + 7];
    const bz = data[dst + 8];
    const cx = data[dst + 12];
    const cy = data[dst + 13];
    const cz = data[dst + 14];
    let nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
    let ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
    let nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    const length = Math.hypot(nx, ny, nz) || 1;
    nx /= length;
    ny /= length;
    nz /= length;
    for (let corner = 0; corner < 3; corner += 1) {
      data[dst + corner * 6 + 3] = nx;
      data[dst + corner * 6 + 4] = ny;
      data[dst + corner * 6 + 5] = nz;
    }
  }
  return { data, facets, radius };
}

function fitCanvas(canvas) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(1, Math.round(canvas.clientWidth * dpr));
  const height = Math.max(1, Math.round(canvas.clientHeight * dpr));
  if (canvas.width === width && canvas.height === height) return;
  canvas.width = width;
  canvas.height = height;
}

function draw(model, angle) {
  const { gl, canvas, radius, facets } = model;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const right = [
    RIGHT[0] * cos + FORWARD[0] * sin,
    RIGHT[1] * cos + FORWARD[1] * sin,
    RIGHT[2] * cos + FORWARD[2] * sin,
  ];
  const forward = [
    FORWARD[0] * cos - RIGHT[0] * sin,
    FORWARD[1] * cos - RIGHT[1] * sin,
    FORWARD[2] * cos - RIGHT[2] * sin,
  ];
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  gl.enable(gl.DEPTH_TEST);
  gl.depthFunc(gl.LESS);
  gl.disable(gl.CULL_FACE);
  gl.useProgram(model.program);
  gl.uniform3fv(model.right, right);
  gl.uniform3fv(model.up, UP);
  gl.uniform3fv(model.forward, forward);
  const fit = (FIT * Math.min(canvas.width, canvas.height)) / radius;
  gl.uniform2f(model.scale, fit / canvas.width, fit / canvas.height);
  gl.uniform1f(model.depth, 0.5 / radius);
  gl.uniform1f(model.radiusLoc, radius);
  gl.drawArrays(gl.TRIANGLES, 0, facets * 3);
}

export function stopModelPreview() {
  const model = active;
  if (!model) return;
  active = null;
  if (model.raf) cancelAnimationFrame(model.raf);
  try {
    model.gl.deleteBuffer(model.buffer);
    if (model.colorBuffer) model.gl.deleteBuffer(model.colorBuffer);
    model.gl.deleteProgram(model.program);
  } catch {
    /* the context may already be gone */
  }
}

function prefersReducedMotion() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

function stopSpin(model) {
  if (model.raf) cancelAnimationFrame(model.raf);
  model.raf = 0;
}

function startSpin(model) {
  if (model.raf || state.modelSpin === false || prefersReducedMotion()) return;
  const started = performance.now() - (model.angle / SPEED) * 1000;
  const tick = (now) => {
    if (active !== model || !model.canvas.isConnected) return;
    model.raf = requestAnimationFrame(tick);
    if (now - model.last < FRAME_MS) return;
    model.last = now;
    if (!model.canvas.clientWidth) return;
    fitCanvas(model.canvas);
    model.angle = ((now - started) / 1000) * SPEED;
    draw(model, model.angle);
  };
  model.raf = requestAnimationFrame(tick);
}

export function setModelSpin(enabled) {
  state.modelSpin = enabled !== false;
  if (!active) return;
  if (state.modelSpin) {
    startSpin(active);
  } else {
    stopSpin(active);
    active.angle = 0;
    draw(active, 0);
  }
}

/** Resolves with the 3MF scene info (or null) once the mesh is on screen. */
export async function wireModelPreview(entry, body, token) {
  const holder = body.querySelector('.model-preview');
  const canvas = holder?.querySelector('.model-canvas');
  if (!canvas) return null;
  stopModelPreview();

  let response = null;
  try {
    response = await api.meshGeometry(entry.path);
  } catch {
    return null;
  }
  if (token !== state.preview.token || !canvas.isConnected) return null;

  const payload = readPayload(response);
  if (!payload) return null;
  const { info } = payload;
  const geometry = buildGeometry(payload.corners);
  if (!geometry) return info;
  const renderer = createRenderer(canvas);
  if (!renderer) return info;

  const { gl } = renderer;
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, geometry.data, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(renderer.pos);
  gl.vertexAttribPointer(renderer.pos, 3, gl.FLOAT, false, STRIDE, 0);
  gl.enableVertexAttribArray(renderer.normal);
  gl.vertexAttribPointer(renderer.normal, 3, gl.FLOAT, false, STRIDE, 12);

  let colorBuffer = null;
  const tints = vertexColors(payload.colors, geometry.facets);
  if (renderer.color >= 0) {
    if (tints) {
      colorBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, colorBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, tints, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(renderer.color);
      gl.vertexAttribPointer(renderer.color, 3, gl.UNSIGNED_BYTE, true, 4, 0);
    } else {
      gl.disableVertexAttribArray(renderer.color);
      gl.vertexAttrib3f(renderer.color, ...DEFAULT_TONE.map((value) => value / 255));
    }
  }

  const model = {
    ...renderer,
    canvas,
    buffer,
    colorBuffer,
    facets: geometry.facets,
    radius: geometry.radius,
    raf: 0,
    last: 0,
    angle: 0,
  };
  active = model;
  fitCanvas(canvas);
  draw(model, 0);
  holder.classList.add('model-ready');
  startSpin(model);
  return info;
}
