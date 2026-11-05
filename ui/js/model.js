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
uniform vec3 uRight;
uniform vec3 uUp;
uniform vec3 uForward;
uniform vec2 uScale;
uniform float uDepth;
out vec3 vNormal;
out float vDepth;
void main() {
  vec3 p = vec3(dot(aPos, uRight), dot(aPos, uUp), dot(aPos, uForward));
  vNormal = vec3(dot(aNormal, uRight), dot(aNormal, uUp), dot(aNormal, uForward));
  vDepth = p.z;
  gl_Position = vec4(p.x * uScale.x, -p.y * uScale.y, p.z * uDepth, 1.0);
}`;

const FRAGMENT_300 = `#version 300 es
precision highp float;
in vec3 vNormal;
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
  vec3 tone = min(vec3(236.0, 240.0, 248.0) * diffuse, vec3(255.0)) * fade;
  outColor = vec4(tone / 255.0, 1.0);
}`;

const VERTEX_100 = `attribute vec3 aPos;
attribute vec3 aNormal;
uniform vec3 uRight;
uniform vec3 uUp;
uniform vec3 uForward;
uniform vec2 uScale;
uniform float uDepth;
varying vec3 vNormal;
varying float vDepth;
void main() {
  vec3 p = vec3(dot(aPos, uRight), dot(aPos, uUp), dot(aPos, uForward));
  vNormal = vec3(dot(aNormal, uRight), dot(aNormal, uUp), dot(aNormal, uForward));
  vDepth = p.z;
  gl_Position = vec4(p.x * uScale.x, -p.y * uScale.y, p.z * uDepth, 1.0);
}`;

const FRAGMENT_100 = `precision mediump float;
varying vec3 vNormal;
varying float vDepth;
uniform float uRadius;
void main() {
  vec3 n = normalize(vNormal);
  if (n.z > 0.0) n = -n;
  vec3 key = normalize(vec3(1.0, 1.1, -1.4));
  vec3 fill = normalize(vec3(1.2, -0.3, -1.0));
  float diffuse = 0.20 + 0.66 * max(dot(n, key), 0.0) + 0.24 * max(dot(n, fill), 0.0);
  float fade = 1.0 - 0.30 * clamp((vDepth + uRadius) / (2.0 * uRadius), 0.0, 1.0);
  vec3 tone = min(vec3(236.0, 240.0, 248.0) * diffuse, vec3(255.0)) * fade;
  gl_FragColor = vec4(tone / 255.0, 1.0);
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

function buildGeometry(buffer) {
  const raw =
    buffer instanceof ArrayBuffer
      ? new Float32Array(buffer)
      : ArrayBuffer.isView(buffer)
        ? new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength >> 2)
        : null;
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
    model.gl.deleteProgram(model.program);
  } catch {
    /* the context may already be gone */
  }
}

export async function wireModelPreview(entry, body, token) {
  const holder = body.querySelector('.model-preview');
  const canvas = holder?.querySelector('.model-canvas');
  if (!canvas) return;
  stopModelPreview();

  let response = null;
  try {
    response = await api.meshGeometry(entry.path);
  } catch {
    return;
  }
  if (token !== state.preview.token || !canvas.isConnected) return;

  const geometry = buildGeometry(response);
  if (!geometry) return;
  const renderer = createRenderer(canvas);
  if (!renderer) return;

  const { gl } = renderer;
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, geometry.data, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(renderer.pos);
  gl.vertexAttribPointer(renderer.pos, 3, gl.FLOAT, false, STRIDE, 0);
  gl.enableVertexAttribArray(renderer.normal);
  gl.vertexAttribPointer(renderer.normal, 3, gl.FLOAT, false, STRIDE, 12);

  const model = {
    ...renderer,
    canvas,
    buffer,
    facets: geometry.facets,
    radius: geometry.radius,
    raf: 0,
    last: 0,
  };
  active = model;
  fitCanvas(canvas);
  draw(model, 0);
  holder.classList.add('model-ready');

  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
  const started = performance.now();
  const tick = (now) => {
    if (active !== model || !canvas.isConnected) return;
    model.raf = requestAnimationFrame(tick);
    if (now - model.last < FRAME_MS) return;
    model.last = now;
    if (!canvas.clientWidth) return;
    fitCanvas(canvas);
    draw(model, ((now - started) / 1000) * SPEED);
  };
  model.raf = requestAnimationFrame(tick);
}
