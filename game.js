/*
 * ほうきバランス
 * 教室で手のひらにほうきを乗せて、どれだけ長くバランスをとれるかを競うゲーム。
 * 描画は three.js r159（vendor/three.min.js）。外部との通信は一切しない。
 */
(function () {
  'use strict';

  // ===== DOM =====
  const $ = (id) => document.getElementById(id);
  const ui = {
    stage: $('stage'), canvas: $('view'), fatal: $('fatal'),
    hud: $('hud'), time: $('timeVal'), hudBest: $('hudBest'), hint: $('hint'), banner: $('banner'),
    gaugeDot: $('gaugeDot'), bubble: $('bubble'), bubbleText: $('bubbleText'), mute: $('btnMute'),
    title: $('titleScreen'), titleBest: $('titleBest'), start: $('btnStart'),
    pause: $('pauseScreen'), resume: $('btnResume'),
    result: $('resultScreen'), resTime: $('resTime'), resNew: $('resNew'), resRank: $('resRank'),
    resComment: $('resComment'), resBest: $('resBest'), retry: $('btnRetry'), toTitle: $('btnTitle'),
    share: $('btnShare'),
  };

  function fatal(msg) {
    ui.fatal.textContent = msg;
    ui.fatal.classList.remove('hidden');
    ui.title.classList.add('hidden');
  }

  const THREE = window.THREE;
  if (!THREE) {
    fatal('ゲームの読み込みに失敗しました。ページを再読み込みしてください。');
    return;
  }

  // ===== 小道具 =====
  const V3 = THREE.Vector3;
  const UP = new V3(0, 1, 0);
  const DOWN = new V3(0, -1, 0);
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const damp = (a, b, k, dt) => lerp(a, b, 1 - Math.exp(-k * dt));
  const rand = (a, b) => a + Math.random() * (b - a);
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const smooth = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
  const angleLerp = (a, b, k) => a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * k;

  // ===== 保存（自分の端末の localStorage のみ） =====
  const KEY_BEST = 'houki-balance:best';
  const KEY_MUTE = 'houki-balance:mute';
  const store = {
    get(key) { try { return window.localStorage.getItem(key); } catch (e) { return null; } },
    set(key, value) { try { window.localStorage.setItem(key, String(value)); } catch (e) { /* 保存できなくても遊べる */ } },
  };
  function readBest() {
    const v = parseFloat(store.get(KEY_BEST));
    return Number.isFinite(v) && v > 0 && v < 100000 ? v : 0;
  }
  let best = readBest();

  // ===== レンダラー =====
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas: ui.canvas, antialias: true, powerPreference: 'high-performance' });
  } catch (e) {
    fatal('このブラウザでは3D表示（WebGL）が使えないため遊べません。');
    return;
  }
  let pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  renderer.setPixelRatio(pixelRatio);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xeee4d0);
  const camera = new THREE.PerspectiveCamera(90, 9 / 16, 0.03, 160);
  camera.rotation.order = 'YXZ';
  scene.add(camera);

  // ===== マテリアルとジオメトリの結合 =====
  const matCache = new Map();
  function lam(hex) {
    let m = matCache.get(hex);
    if (!m) {
      m = new THREE.MeshLambertMaterial({ color: hex, flatShading: true });
      matCache.set(hex, m);
    }
    return m;
  }
  const vcMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);

  function vary(hex, amount) {
    const c = new THREE.Color(hex);
    c.offsetHSL(0, 0, (Math.random() - 0.5) * amount);
    return c;
  }

  const _m4 = new THREE.Matrix4();
  const _q = new THREE.Quaternion();
  const _e = new THREE.Euler();
  const _s = new V3();
  const _p = new V3();

  // 頂点カラー付きで多数の部品を1つのメッシュにまとめる（描画負荷を下げる）
  class Builder {
    constructor() { this.pos = []; this.nor = []; this.col = []; }
    addGeo(geo, color, matrix) {
      const g = geo.index ? geo.toNonIndexed() : geo.clone();
      g.applyMatrix4(matrix);
      const p = g.attributes.position.array;
      const n = g.attributes.normal.array;
      const c = color instanceof THREE.Color ? color : new THREE.Color(color);
      for (let i = 0; i < p.length; i++) { this.pos.push(p[i]); this.nor.push(n[i]); }
      for (let i = 0, cnt = p.length / 3; i < cnt; i++) this.col.push(c.r, c.g, c.b);
      g.dispose();
      return this;
    }
    add(geo, color, x, y, z, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
      _m4.compose(_p.set(x, y, z), _q.setFromEuler(_e.set(rx, ry, rz)), _s.set(sx, sy, sz));
      return this.addGeo(geo, color, _m4);
    }
    box(x, y, z, w, h, d, color, ry = 0) { return this.add(UNIT_BOX, color, x, y, z, 0, ry, 0, w, h, d); }
    boxMM(x0, y0, z0, x1, y1, z1, color) {
      return this.box((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2, Math.abs(x1 - x0), Math.abs(y1 - y0), Math.abs(z1 - z0), color);
    }
    geometry() {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
      g.computeBoundingSphere();
      return g;
    }
    mesh(material = vcMat, cast = true, receive = true) {
      const m = new THREE.Mesh(this.geometry(), material);
      m.castShadow = cast;
      m.receiveShadow = receive;
      return m;
    }
  }

  function canvasTexture(w, h, draw) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    draw(c.getContext('2d'), w, h);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    return tex;
  }
  const CANVAS_FONT = '"Hiragino Maru Gothic ProN","Hiragino Sans","BIZ UDPGothic","Yu Gothic","Meiryo",sans-serif';

  // ===== 教室 =====
  // 座標はメートル。プレイヤーは原点に立って -z（黒板）を向く。左(-x)が窓側。
  const ROOM = { x0: -1.9, x1: 6.2, z0: -6.2, z1: 2.8, h: 3.0 };
  const PODIUM = { x0: -1.4, x1: 4.4, z1: -5.25, h: 0.18 };
  const BOARD = { x0: -1.2, x1: 3.2, y0: 0.84, y1: 2.04 };
  const SILL = 0.86, WIN_TOP = 2.5;
  const WINDOWS = [[-5.6, -3.8], [-3.6, -1.8], [-1.6, 0.2], [0.4, 2.2]];

  function buildClassroom() {
    const { x0, x1, z0, z1, h } = ROOM;
    const T = 0.12;
    const shell = new Builder();
    const props = new Builder();
    const wallC = 0xf0e7d3, wainC = 0x9c7047, railC = 0x7c5532;

    // 床（板張り）
    shell.boxMM(x0, -0.06, z0, x1, -0.005, z1, 0x6b4527);
    const pw = 0.125;
    for (let x = x0; x < x1 - 0.01; x += pw) {
      let z = z0 - Math.random() * 1.6;
      while (z < z1) {
        const len = rand(1.1, 2.3);
        const za = Math.max(z, z0), zb = Math.min(z + len, z1);
        if (zb - za > 0.05) shell.boxMM(x + 0.003, -0.014, za + 0.004, Math.min(x + pw, x1) - 0.003, 0, zb - 0.004, vary(0xc8955c, 0.08));
        z += len;
      }
    }

    // 壁と天井
    shell.boxMM(x0 - T, 0, z0 - T, x1 + T, h, z0, wallC);
    shell.boxMM(x0 - T, 0, z1, x1 + T, h, z1 + T, wallC);
    shell.boxMM(x1, 0, z0, x1 + T, h, z1, wallC);
    shell.boxMM(x0 - T, 0, z0, x0, SILL, z1, wallC);
    shell.boxMM(x0 - T, WIN_TOP, z0, x0, h, z1, wallC);
    let zPrev = z0;
    for (const [a, b] of WINDOWS) { shell.boxMM(x0 - T, SILL, zPrev, x0, WIN_TOP, a, wallC); zPrev = b; }
    shell.boxMM(x0 - T, SILL, zPrev, x0, WIN_TOP, z1, wallC);
    shell.boxMM(x0 - T, h, z0 - T, x1 + T, h + T, z1 + T, 0xf4f0e6);

    // 腰板・幅木・窓台
    shell.boxMM(x0, 0, z0, x1, 0.9, z0 + 0.012, wainC);
    shell.boxMM(x0, 0.9, z0, x1, 0.93, z0 + 0.03, railC);
    shell.boxMM(x1 - 0.012, 0, z0, x1, 0.9, z1, wainC);
    shell.boxMM(x1 - 0.03, 0.9, z0, x1, 0.93, z1, railC);
    shell.boxMM(x0, 0, z1 - 0.012, x1, 0.9, z1, wainC);
    shell.boxMM(x0, 0, z0, x0 + 0.012, SILL - 0.03, z1, wainC);
    shell.boxMM(x0, SILL - 0.03, z0, x0 + 0.17, SILL, z1, 0xd9c7a3);

    // 天井の目地とパネルの色むら
    for (let x = x0; x < x1 - 0.1; x += 0.91) {
      for (let z = z0; z < z1 - 0.1; z += 0.91) {
        if (Math.random() < 0.45) shell.boxMM(x + 0.01, h - 0.003, z + 0.01, Math.min(x + 0.91, x1) - 0.01, h - 0.001, Math.min(z + 0.91, z1) - 0.01, vary(0xf6f2e9, 0.035));
      }
    }
    for (let x = x0 + 0.91; x < x1; x += 0.91) shell.boxMM(x - 0.006, h - 0.006, z0, x + 0.006, h, z1, 0xd8d0c0);
    for (let z = z0 + 0.91; z < z1; z += 0.91) shell.boxMM(x0, h - 0.006, z - 0.006, x1, h, z + 0.006, 0xd8d0c0);

    // 窓枠（アルミ）
    const alu = 0xc4c9cf;
    const fx0 = x0 - 0.09, fx1 = x0 - 0.03;
    for (const [a, b] of WINDOWS) {
      props.boxMM(fx0, SILL, a, fx1, SILL + 0.04, b, alu);
      props.boxMM(fx0, WIN_TOP - 0.04, a, fx1, WIN_TOP, b, alu);
      props.boxMM(fx0, SILL, a, fx1, WIN_TOP, a + 0.04, alu);
      props.boxMM(fx0, SILL, b - 0.04, fx1, WIN_TOP, b, alu);
      const m = (a + b) / 2;
      props.boxMM(fx0 - 0.01, SILL, m - 0.025, fx1, WIN_TOP, m + 0.025, alu);
      props.boxMM(fx0, 2.08, a, fx1, 2.12, b, alu);
      // カーテン（束ねた状態）
      props.add(new THREE.CylinderGeometry(0.1, 0.13, 2.3, 7), vary(0xf1dcaa, 0.04), x0 + 0.1, 1.43, a - 0.12, 0, 0.3, 0, 0.6, 1, 1.25);
    }
    props.boxMM(x0 + 0.02, 2.6, z0, x0 + 0.07, 2.64, z1, 0xb0b5bb);

    // 教壇・教卓
    const { x0: px0, x1: px1, z1: pz1, h: ph } = PODIUM;
    props.boxMM(px0, 0, z0, px1, ph, pz1, 0x9b6e45);
    props.boxMM(px0, ph - 0.02, pz1 - 0.02, px1, ph, pz1 + 0.01, 0x7b5332);
    props.boxMM(0.5, ph, z0 + 0.42, 1.5, 1.0, z0 + 0.92, 0xb4865a);
    props.boxMM(0.46, 1.0, z0 + 0.4, 1.54, 1.04, z0 + 0.94, 0xc79a69);
    props.boxMM(0.55, 0.32, z0 + 0.921, 1.45, 0.9, z0 + 0.93, 0xa77a4f);
    props.boxMM(0.72, 1.04, z0 + 0.55, 1.05, 1.06, z0 + 0.78, 0x2f5fa6); // 出席簿
    props.add(new THREE.CylinderGeometry(0.035, 0.045, 0.14, 6), 0x9ec9e0, 1.3, 1.11, z0 + 0.62);
    for (let i = 0; i < 3; i++) props.add(new THREE.IcosahedronGeometry(0.035, 0), [0xff7a8a, 0xffd84a, 0xff9f43][i], 1.3 + (i - 1) * 0.04, 1.22 + (i % 2) * 0.03, z0 + 0.62);

    // 黒板まわり
    const { x0: bx0, x1: bx1, y0: by0, y1: by1 } = BOARD;
    props.boxMM(bx0 - 0.07, by0 - 0.06, z0, bx1 + 0.07, by1 + 0.06, z0 + 0.025, 0x7d5a3a);
    props.boxMM(bx0, by0 - 0.04, z0, bx1, by0 - 0.015, z0 + 0.11, alu);
    props.boxMM(bx0, by0 - 0.015, z0 + 0.1, bx1, by0 + 0.005, z0 + 0.115, alu);
    const chalkCols = [0xf7f7f0, 0xf7f7f0, 0xff7b6b, 0xffe066, 0x7fc8ff];
    chalkCols.forEach((c, i) => props.add(new THREE.CylinderGeometry(0.006, 0.006, 0.07, 5), c, 0.1 + i * 0.09, by0 - 0.007, z0 + 0.06, 0, 0.2 * i, Math.PI / 2));
    props.box(-0.7, by0, z0 + 0.06, 0.13, 0.03, 0.05, 0x24365e);
    // 時計
    props.add(new THREE.CylinderGeometry(0.19, 0.19, 0.05, 16), 0x3a3a3a, 1.0, 2.42, z0 + 0.025, Math.PI / 2, 0, 0);
    // スピーカー
    props.boxMM(0.05, 2.5, z0, 0.45, 2.78, z0 + 0.12, 0xe9e4d8);
    for (let i = 0; i < 4; i++) props.boxMM(0.1, 2.55 + i * 0.055, z0 + 0.121, 0.4, 2.565 + i * 0.055, z0 + 0.124, 0x8a8478);
    // テレビ
    props.boxMM(-1.62, 2.3, z0 + 0.14, -0.86, 2.76, z0 + 0.24, 0x1d1e21);
    props.boxMM(-1.58, 2.33, z0 + 0.241, -0.9, 2.73, z0 + 0.245, 0x2c3b48);
    props.boxMM(-1.27, 2.72, z0, -1.21, 2.8, z0 + 0.2, 0x55585c);
    // 掲示板
    props.boxMM(3.75, 1.0, z0, 5.6, 1.9, z0 + 0.03, 0xc79f68);
    const papers = [0xffffff, 0xfff1b8, 0xd6f0ff, 0xffe0e6, 0xffffff, 0xe3ffd9];
    papers.forEach((c, i) => {
      const px = 3.95 + (i % 3) * 0.55 + rand(-0.04, 0.04), py = 1.62 - Math.floor(i / 3) * 0.42 + rand(-0.03, 0.03);
      props.boxMM(px, py - 0.17, z0 + 0.031, px + 0.4, py + 0.17, z0 + 0.036, c);
      for (let k = 0; k < 4; k++) props.boxMM(px + 0.05, py + 0.1 - k * 0.06, z0 + 0.037, px + 0.33 - (k % 2) * 0.08, py + 0.11 - k * 0.06, z0 + 0.039, 0x9a9a9a);
    });
    // バケツ・ちりとり
    props.add(new THREE.CylinderGeometry(0.15, 0.12, 0.27, 8), 0x3d7fd6, x0 + 0.42, 0.135, z0 + 0.95);
    props.add(new THREE.TorusGeometry(0.15, 0.008, 4, 10, Math.PI), 0xb8bec4, x0 + 0.42, 0.27, z0 + 0.95, 0, 0.4, 0);
    props.boxMM(x0 + 0.62, 0.0, z0 + 0.62, x0 + 0.9, 0.012, z0 + 0.86, 0xe34b3b);
    props.add(UNIT_BOX, 0xe34b3b, x0 + 0.76, 0.35, z0 + 0.6, -0.15, 0, 0, 0.025, 0.7, 0.025);

    // 蛍光灯
    const glow = new Builder();
    for (const lx of [-0.6, 2.2, 5.0]) {
      for (const lz of [-4.6, -2.0, 0.6]) {
        props.box(lx, h - 0.035, lz, 1.32, 0.05, 0.26, 0xebebe8);
        for (const off of [-0.06, 0.06]) glow.add(new THREE.CylinderGeometry(0.018, 0.018, 1.22, 6), 0xffffff, lx, h - 0.075, lz + off, 0, 0, Math.PI / 2);
      }
    }

    const shellMesh = shell.mesh();
    const propsMesh = props.mesh();
    const glowMesh = new THREE.Mesh(glow.geometry(), new THREE.MeshBasicMaterial({ color: 0xfffbf0 }));
    scene.add(shellMesh, propsMesh, glowMesh);

    // 窓ガラス
    const glass = new Builder();
    for (const [a, b] of WINDOWS) glass.boxMM(x0 - 0.065, SILL + 0.04, a + 0.04, x0 - 0.06, WIN_TOP - 0.04, b - 0.04, 0xffffff);
    const glassMesh = new THREE.Mesh(glass.geometry(), new THREE.MeshBasicMaterial({ color: 0xd8ecff, transparent: true, opacity: 0.14, depthWrite: false }));
    scene.add(glassMesh);

    // 黒板（文字入り）
    const boardTex = canvasTexture(2048, 560, drawBlackboard);
    const board = new THREE.Mesh(new THREE.PlaneGeometry(bx1 - bx0, by1 - by0), new THREE.MeshLambertMaterial({ map: boardTex }));
    board.position.set((bx0 + bx1) / 2, (by0 + by1) / 2, z0 + 0.027);
    board.receiveShadow = true;
    scene.add(board);

    // 時間割
    const tt = new THREE.Mesh(new THREE.PlaneGeometry(0.42, 0.6), new THREE.MeshLambertMaterial({ map: canvasTexture(256, 366, drawTimetable) }));
    tt.position.set(-1.62, 1.42, z0 + 0.01);
    scene.add(tt);

    // 額（整理整頓）
    props.boxMM(2.55, 2.26, z0, 3.55, 2.68, z0 + 0.03, 0x6b4a2e);
    const motto = new THREE.Mesh(new THREE.PlaneGeometry(0.92, 0.34), new THREE.MeshLambertMaterial({ map: canvasTexture(512, 190, drawMotto) }));
    motto.position.set(3.05, 2.47, z0 + 0.032);
    scene.add(motto);

    // 時計の文字盤と針（今の時刻を指す）
    const face = new THREE.Mesh(new THREE.CircleGeometry(0.165, 24), new THREE.MeshLambertMaterial({ map: canvasTexture(256, 256, drawClock) }));
    face.position.set(1.0, 2.42, z0 + 0.052);
    scene.add(face);
    const hand = (w, len, color, zOff) => {
      const g = new THREE.Group();
      const m = new THREE.Mesh(UNIT_BOX, lam(color));
      m.scale.set(w, len, 0.004);
      m.position.y = len / 2 - 0.015;
      g.add(m);
      g.position.set(1.0, 2.42, z0 + 0.056 + zOff);
      scene.add(g);
      return g;
    };
    clockHands.h = hand(0.014, 0.095, 0x1e1e1e, 0);
    clockHands.m = hand(0.009, 0.135, 0x1e1e1e, 0.003);
    clockHands.s = hand(0.004, 0.145, 0xd8452e, 0.006);

    // 机と逆さに乗せた椅子（インスタンス描画）
    const deskGeo = buildDeskSet();
    const cols = [-1.3, -0.55, 0.2, 1.5, 2.25, 3.0, 3.75, 4.5, 5.25];
    const rows = [-2.55, -3.25, -3.95, -4.65];
    const desks = new THREE.InstancedMesh(deskGeo, vcMat, cols.length * rows.length);
    let i = 0;
    for (const cz of rows) {
      for (const cx of cols) {
        _m4.compose(_p.set(cx + rand(-0.02, 0.02), 0, cz + rand(-0.02, 0.02)), _q.setFromEuler(_e.set(0, rand(-0.035, 0.035), 0)), _s.set(1, 1, 1));
        desks.setMatrixAt(i++, _m4);
      }
    }
    desks.instanceMatrix.needsUpdate = true;
    desks.castShadow = true;
    desks.receiveShadow = true;
    scene.add(desks);
  }

  const clockHands = { h: null, m: null, s: null };
  function updateClock() {
    const d = new Date();
    const s = d.getSeconds(), m = d.getMinutes() + s / 60, hr = (d.getHours() % 12) + m / 60;
    clockHands.h.rotation.z = -hr / 12 * Math.PI * 2;
    clockHands.m.rotation.z = -m / 60 * Math.PI * 2;
    clockHands.s.rotation.z = -s / 60 * Math.PI * 2;
  }

  function buildDeskSet() {
    const b = new Builder();
    const wood = 0xdcb27a, metal = 0x8b9198, inner = 0x9aa0a6;
    b.box(0, 0.705, 0, 0.6, 0.022, 0.45, wood);
    b.box(0, 0.62, -0.02, 0.54, 0.12, 0.38, inner);
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) b.box(sx * 0.27, 0.35, sz * 0.19, 0.024, 0.7, 0.024, metal);
      b.box(sx * 0.27, 0.08, 0, 0.022, 0.022, 0.4, metal);
    }
    // 椅子を逆さにして机に乗せる（背もたれは手前側に垂れる）
    const cb = (px, py, pz, w, hh, d, c) => b.box(px, 1.148 - py, 0.06 - pz, w, hh, d, c);
    cb(0, 0.42, 0, 0.38, 0.022, 0.36, wood);
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) cb(sx * 0.165, 0.21, sz * 0.155, 0.02, 0.42, 0.02, metal);
      cb(sx * 0.165, 0.61, -0.17, 0.02, 0.38, 0.02, metal);
    }
    cb(0, 0.7, -0.175, 0.36, 0.15, 0.018, wood);
    return b.geometry();
  }

  function drawBlackboard(g, W, H) {
    g.fillStyle = '#2d5844';
    g.fillRect(0, 0, W, H);
    for (let i = 0; i < 26; i++) {
      const x = Math.random() * W, y = Math.random() * H, r = 60 + Math.random() * 180;
      const grd = g.createRadialGradient(x, y, 0, x, y, r);
      grd.addColorStop(0, 'rgba(130,170,145,0.10)');
      grd.addColorStop(1, 'rgba(130,170,145,0)');
      g.fillStyle = grd;
      g.fillRect(x - r, y - r, r * 2, r * 2);
    }
    const chalk = (txt, x, y, size, color, align = 'left') => {
      g.font = `bold ${size}px ${CANVAS_FONT}`;
      g.textAlign = align;
      g.textBaseline = 'middle';
      g.fillStyle = color;
      g.shadowColor = color;
      g.shadowBlur = 3;
      g.fillText(txt, x, y);
      g.shadowBlur = 0;
    };
    const vertical = (txt, x, y, size, color) => {
      let yy = y;
      for (const tok of txt.match(/\d+|./g)) { chalk(tok, x, yy, size, color, 'center'); yy += size * 1.1; }
    };
    const white = 'rgba(250,250,240,0.92)';
    const d = new Date();
    vertical(`${d.getMonth() + 1}月${d.getDate()}日`, W - 70, 62, 52, white);
    vertical(`${'日月火水木金土'[d.getDay()]}曜日`, W - 70, 300, 46, white);
    vertical('日直', W - 175, 70, 46, white);
    vertical('さとう', W - 175, 210, 40, white);
    vertical('たなか', W - 240, 210, 40, white);

    chalk('★ そうじの時間 ★', 980, 105, 76, white, 'center');
    chalk('ほうきで あそばない！！', 980, 265, 118, 'rgba(255,150,135,0.95)', 'center');
    g.strokeStyle = 'rgba(255,226,110,0.9)';
    g.lineWidth = 7;
    g.beginPath();
    for (let x = 330; x <= 1630; x += 10) {
      const y = 350 + Math.sin(x / 26) * 7;
      if (x === 330) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.stroke();
    chalk('つくえ → 前へ　　ほうき → ちりとり → ぞうきん', 980, 450, 48, white, 'center');
    chalk('(x+2)(x−3) =', 70, 120, 58, 'rgba(250,250,240,0.32)');
    chalk('x² − x − 6', 110, 205, 58, 'rgba(250,250,240,0.22)');
    // にっこりマーク
    g.strokeStyle = 'rgba(250,250,240,0.8)';
    g.lineWidth = 6;
    g.beginPath(); g.arc(200, 420, 58, 0, Math.PI * 2); g.stroke();
    g.beginPath(); g.arc(200, 430, 32, 0.15 * Math.PI, 0.85 * Math.PI); g.stroke();
    g.fillStyle = 'rgba(250,250,240,0.8)';
    g.fillRect(178, 398, 9, 16);
    g.fillRect(214, 398, 9, 16);
    // チョークのかすれ
    g.fillStyle = 'rgba(45,88,68,0.4)';
    for (let i = 0; i < 9000; i++) g.fillRect(Math.random() * W, Math.random() * H, 2, 2);
  }

  function drawTimetable(g, W, H) {
    g.fillStyle = '#fbfaf4';
    g.fillRect(0, 0, W, H);
    g.fillStyle = '#333';
    g.font = `bold 30px ${CANVAS_FONT}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('時間割', W / 2, 26);
    const days = '月火水木金';
    const subj = ['国', '数', '英', '理', '社', '体', '音', '美', '学'];
    const colors = { 国: '#ffd6d6', 数: '#d6e8ff', 英: '#fff0c2', 理: '#d9f5d0', 社: '#f0dcff', 体: '#ffe2c4', 音: '#ffd9ef', 美: '#d5f3f3', 学: '#eeeeee' };
    const cw = (W - 20) / 5, ch = (H - 80) / 6;
    g.font = `bold 20px ${CANVAS_FONT}`;
    for (let c = 0; c < 5; c++) g.fillText(days[c], 10 + cw * (c + 0.5), 62);
    g.font = `bold 26px ${CANVAS_FONT}`;
    for (let r = 0; r < 6; r++) {
      for (let c = 0; c < 5; c++) {
        const s = subj[(r * 5 + c * 3 + r) % subj.length];
        g.fillStyle = colors[s];
        g.fillRect(12 + cw * c, 76 + ch * r, cw - 4, ch - 4);
        g.fillStyle = '#444';
        g.fillText(s, 10 + cw * (c + 0.5), 76 + ch * (r + 0.5));
      }
    }
  }

  function drawMotto(g, W, H) {
    g.fillStyle = '#fbf8ef';
    g.fillRect(0, 0, W, H);
    g.fillStyle = '#222';
    g.font = `bold 118px "Hiragino Mincho ProN","Yu Mincho","MS PMincho",serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('整理整頓', W / 2, H / 2 + 6);
  }

  function drawClock(g, W, H) {
    const cx = W / 2, cy = H / 2;
    g.fillStyle = '#fdfdfb';
    g.fillRect(0, 0, W, H);
    g.fillStyle = '#222';
    g.font = `bold 30px ${CANVAS_FONT}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    for (let i = 1; i <= 12; i++) {
      const a = i / 12 * Math.PI * 2;
      g.fillText(String(i), cx + Math.sin(a) * 96, cy - Math.cos(a) * 96);
    }
    for (let i = 0; i < 60; i++) {
      const a = i / 60 * Math.PI * 2, r0 = i % 5 === 0 ? 112 : 118;
      g.lineWidth = i % 5 === 0 ? 4 : 2;
      g.beginPath();
      g.moveTo(cx + Math.sin(a) * r0, cy - Math.cos(a) * r0);
      g.lineTo(cx + Math.sin(a) * 125, cy - Math.cos(a) * 125);
      g.stroke();
    }
  }

  // ===== 窓の外 =====
  function buildOutside() {
    const x0 = ROOM.x0;
    const sky = new THREE.PlaneGeometry(200, 70, 1, 14);
    const pos = sky.attributes.position;
    const cols = [];
    const cLow = new THREE.Color(0xffd2a0), cMid = new THREE.Color(0xffe9c9), cTop = new THREE.Color(0x7db4ee);
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i) + 18;
      if (y < 4) c.copy(cLow).lerp(cMid, clamp((y + 10) / 14, 0, 1));
      else c.copy(cMid).lerp(cTop, clamp((y - 4) / 26, 0, 1));
      cols.push(c.r, c.g, c.b);
    }
    sky.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
    const skyMesh = new THREE.Mesh(sky, new THREE.MeshBasicMaterial({ vertexColors: true }));
    skyMesh.rotation.y = Math.PI / 2;
    skyMesh.position.set(x0 - 60, 18, -4);
    scene.add(skyMesh);

    // 遠くの山
    const far = new Builder();
    for (let z = -70; z < 60; z += 9) {
      const hgt = rand(4, 11);
      far.add(new THREE.ConeGeometry(rand(8, 13), hgt, 4), vary(0x9fb6c6, 0.05), x0 - 55, -4 + hgt / 2, z + rand(-3, 3), 0, rand(0, 3), 0);
    }
    scene.add(new THREE.Mesh(far.geometry(), new THREE.MeshBasicMaterial({ vertexColors: true })));

    // 校庭と木
    const yard = new Builder();
    yard.boxMM(x0 - 58, -4.6, -70, x0 - 0.3, -4.5, 60, 0xd6c29a);
    for (let k = 0; k < 9; k++) {
      const tx = x0 - rand(3, 10), tz = rand(-9, 5), th = rand(5.5, 8);
      yard.add(new THREE.CylinderGeometry(0.15, 0.22, th, 5), 0x7a5a3c, tx, -4.5 + th / 2, tz);
      for (let j = 0; j < 3; j++) {
        yard.add(new THREE.IcosahedronGeometry(rand(1.0, 1.6), 0), vary(0x5f9e4f, 0.12), tx + rand(-0.8, 0.8), -4.5 + th + rand(-0.6, 0.8), tz + rand(-0.8, 0.8));
      }
    }
    // 向かいの校舎
    yard.boxMM(x0 - 30, -4.5, -26, x0 - 22, 6, 4, 0xe8dcc6);
    for (let fl = 0; fl < 3; fl++) for (let w = 0; w < 9; w++) yard.boxMM(x0 - 22.02, -2.6 + fl * 3, -24 + w * 3.1, x0 - 21.98, -1.2 + fl * 3, -22.2 + w * 3.1, 0x8fb2cf);
    const yardMesh = yard.mesh(vcMat, false, false);
    scene.add(yardMesh);
  }

  // ===== 光 =====
  const hemi = new THREE.HemisphereLight(0xfff7ea, 0xf1e6d4, 2.3);
  scene.add(hemi, new THREE.AmbientLight(0xfff8ee, 0.5));
  const fill = new THREE.DirectionalLight(0xfffdf6, 1.0);
  fill.position.set(0.6, 4, 2);
  scene.add(fill);
  const sun = new THREE.DirectionalLight(0xffd29c, 4.2);
  const sunDir = new V3(-0.871, 0.276, -0.406).normalize();
  sun.target.position.set(2.1, 1.0, -1.7);
  sun.position.copy(sun.target.position).addScaledVector(sunDir, 18);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -7.5, right: 7.5, top: 7.5, bottom: -7.5, near: 4, far: 34 });
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.025;
  scene.add(sun, sun.target);

  // ===== 自分の腕とほうき =====
  const HAND_Y = 1.38;
  const REST_Z = -0.7;
  const BROOM_LEN = 1.23;
  const BROOM_COM = 0.79;
  const SHOULDER = new V3(0.17, 1.28, -0.08);

  function addBox(parent, mat, w, h, d, x, y, z) {
    const m = new THREE.Mesh(UNIT_BOX, mat);
    m.scale.set(w, h, d);
    m.position.set(x, y, z);
    m.castShadow = true;
    m.receiveShadow = true;
    parent.add(m);
    return m;
  }

  function buildPlayerArm() {
    const skin = lam(0xf0c19c);
    const hand = new THREE.Group();
    addBox(hand, skin, 0.088, 0.03, 0.1, 0, -0.022, 0);
    addBox(hand, skin, 0.072, 0.044, 0.065, 0, -0.03, 0.075);
    for (const [fx, len] of [[-0.033, 0.040], [-0.011, 0.047], [0.011, 0.044], [0.033, 0.035]]) {
      const g1 = new THREE.Group();
      g1.position.set(fx, -0.022, -0.05);
      g1.rotation.x = 0.28;
      hand.add(g1);
      addBox(g1, skin, 0.019, 0.02, len, 0, 0, -len / 2);
      const g2 = new THREE.Group();
      g2.position.z = -len;
      g2.rotation.x = 0.5;
      g1.add(g2);
      addBox(g2, skin, 0.017, 0.018, len * 0.75, 0, 0, -len * 0.375);
    }
    // 右手を上に向けているので親指は +x 側
    const t1 = new THREE.Group();
    t1.position.set(0.043, -0.024, 0.02);
    t1.rotation.set(0.2, -0.75, 0.25);
    hand.add(t1);
    addBox(t1, skin, 0.023, 0.022, 0.045, 0, 0, -0.022);
    const t2 = new THREE.Group();
    t2.position.z = -0.045;
    t2.rotation.x = 0.35;
    t1.add(t2);
    addBox(t2, skin, 0.019, 0.019, 0.034, 0, 0, -0.017);
    scene.add(hand);

    const foreGeo = new THREE.CylinderGeometry(0.031, 0.04, 1, 6, 1);
    foreGeo.translate(0, -0.5, 0);
    const fore = new THREE.Mesh(foreGeo, skin);
    const upperGeo = new THREE.CylinderGeometry(0.055, 0.058, 1, 6, 1);
    upperGeo.translate(0, -0.5, 0);
    const upper = new THREE.Mesh(upperGeo, lam(0xf7f7f3));
    fore.castShadow = upper.castShadow = true;
    fore.receiveShadow = upper.receiveShadow = true;
    scene.add(fore, upper);
    return { hand, fore, upper };
  }

  function buildBroom() {
    const g = new THREE.Group();
    const add = (geo, color, y) => {
      const m = new THREE.Mesh(geo, lam(color));
      m.position.y = y;
      m.castShadow = true;
      m.receiveShadow = true;
      g.add(m);
      return m;
    };
    add(new THREE.CylinderGeometry(0.0125, 0.0125, 0.9, 6), 0x2f6db3, 0.465);
    add(new THREE.CylinderGeometry(0.0155, 0.0155, 0.03, 6), 0x2a2a2a, 0.015);
    add(new THREE.CylinderGeometry(0.018, 0.016, 0.07, 6), 0xd8452e, 0.93);
    const block = add(UNIT_BOX, 0xd8452e, 0.975);
    block.scale.set(0.3, 0.045, 0.055);
    // 穂（先が少し広がった台形）
    const brGeo = new THREE.BoxGeometry(1, 1, 1, 6, 1, 1);
    const p = brGeo.attributes.position;
    for (let i = 0; i < p.count; i++) {
      if (p.getY(i) > 0) {
        const x = p.getX(i);
        p.setXYZ(i, x * 1.18, 0.5 + Math.sin(x * 41) * 0.05, p.getZ(i) * 0.75);
      }
    }
    brGeo.computeVertexNormals();
    const bristle = add(brGeo, 0xffffff, 1.107);
    bristle.material = new THREE.MeshLambertMaterial({ map: canvasTexture(128, 64, drawBristles), flatShading: true });
    bristle.scale.set(0.29, 0.22, 0.045);
    const band = add(UNIT_BOX, 0x3a2a1a, 1.03);
    band.scale.set(0.3, 0.016, 0.05);
    scene.add(g);
    return g;
  }

  function drawBristles(g, W, H) {
    g.fillStyle = '#b8894f';
    g.fillRect(0, 0, W, H);
    for (let x = 0; x < W; x += 2) {
      const l = 42 + Math.random() * 22;
      g.fillStyle = `hsl(32, ${45 + Math.random() * 15}%, ${l}%)`;
      g.fillRect(x, 0, 2, H);
    }
    g.fillStyle = 'rgba(60,35,15,0.35)';
    g.fillRect(0, H - 8, W, 8);
  }

  // 2関節のIK。S（肩）から T（手）へ、pole の方向にひじを曲げる。届かないときは少し伸ばす。
  const _d = new V3(), _pp = new V3();
  function solveIK(S, T, a, b, pole, outElbow, outHand) {
    _d.subVectors(T, S);
    let dist = _d.length();
    if (dist < 1e-5) { _d.set(0, -1, 0); dist = 1e-5; } else _d.divideScalar(dist);
    let stretch = 1;
    if (dist > (a + b) * 0.999) stretch = Math.min(1.25, dist / ((a + b) * 0.999));
    const sa = a * stretch, sb = b * stretch;
    const dd = clamp(dist, Math.abs(sa - sb) + 1e-4, (sa + sb) * 0.9999);
    const cosA = clamp((sa * sa + dd * dd - sb * sb) / (2 * sa * dd), -1, 1);
    const sinA = Math.sqrt(1 - cosA * cosA);
    _pp.copy(pole).addScaledVector(_d, -pole.dot(_d));
    if (_pp.lengthSq() < 1e-8) _pp.set(0, 0, 1);
    _pp.normalize();
    outElbow.copy(S).addScaledVector(_d, sa * cosA).addScaledVector(_pp, sa * sinA);
    if (outHand) outHand.copy(S).addScaledVector(_d, dd);
    return stretch;
  }
  const _seg = new V3();
  function orientSegment(obj, from, to, baseLen) {
    _seg.subVectors(to, from);
    const len = _seg.length();
    obj.position.copy(from);
    if (len > 1e-6) obj.quaternion.setFromUnitVectors(DOWN, _seg.divideScalar(len));
    obj.scale.set(1, baseLen ? len / baseLen : len, 1);
  }

  // ===== 友達 =====
  function buildFriend() {
    const M = {
      skin: lam(0xf1c6a2), hair: lam(0x3b2b22), shirt: lam(0xf6f5ef), pants: lam(0x2c3552),
      shoe: lam(0xf3f3ef), toe: lam(0x3a6fd8), eye: lam(0x1f1f24), mouth: lam(0x9e3f38),
      cheek: lam(0xf5a3a0), tie: lam(0x2a4a8a), tag: lam(0xffffff), white: lam(0xffffff),
    };
    const root = new THREE.Group();
    const hips = new THREE.Group();
    hips.position.y = 0.88;
    root.add(hips);
    addBox(hips, M.pants, 0.3, 0.17, 0.2, 0, 0.04, 0);

    const legs = [];
    for (const side of [1, -1]) {
      const thigh = new THREE.Group();
      thigh.position.x = side * 0.085;
      hips.add(thigh);
      addBox(thigh, M.pants, 0.125, 0.43, 0.135, 0, -0.2, 0);
      const knee = new THREE.Group();
      knee.position.y = -0.42;
      thigh.add(knee);
      addBox(knee, M.pants, 0.11, 0.4, 0.12, 0, -0.19, 0);
      const foot = new THREE.Group();
      foot.position.y = -0.4;
      knee.add(foot);
      addBox(foot, M.shoe, 0.11, 0.065, 0.25, 0, -0.025, 0.045);
      addBox(foot, M.toe, 0.114, 0.04, 0.07, 0, -0.035, 0.14);
      legs.push({ thigh, knee, foot, side });
    }

    const upper = new THREE.Group();
    upper.position.y = 0.1;
    hips.add(upper);
    addBox(upper, M.shirt, 0.34, 0.4, 0.2, 0, 0.2, 0);
    addBox(upper, M.shirt, 0.22, 0.045, 0.17, 0, 0.405, 0);
    addBox(upper, M.tie, 0.045, 0.25, 0.012, 0, 0.25, 0.104);
    addBox(upper, M.tag, 0.075, 0.03, 0.008, 0.095, 0.31, 0.103);
    addBox(upper, M.skin, 0.075, 0.08, 0.075, 0, 0.44, 0);

    const head = new THREE.Group();
    head.position.y = 0.5;
    head.rotation.order = 'YXZ';
    upper.add(head);
    const skull = new THREE.Mesh(new THREE.IcosahedronGeometry(0.125, 1), M.skin);
    skull.scale.set(0.98, 1.06, 0.98);
    skull.position.y = 0.04;
    skull.castShadow = true;
    head.add(skull);
    const hairCap = new THREE.Mesh(new THREE.SphereGeometry(0.137, 8, 5, 0, Math.PI * 2, 0, Math.PI * 0.52), M.hair);
    hairCap.position.set(0, 0.06, -0.008);
    hairCap.castShadow = true;
    head.add(hairCap);
    addBox(head, M.hair, 0.24, 0.15, 0.08, 0, 0.02, -0.085);
    const fringe = addBox(head, M.hair, 0.23, 0.055, 0.06, 0, 0.135, 0.08);
    fringe.rotation.x = 0.4;
    for (const s of [1, -1]) addBox(head, M.hair, 0.035, 0.11, 0.15, s * 0.118, 0.07, -0.01);
    const ahoge = addBox(head, M.hair, 0.012, 0.07, 0.03, 0.02, 0.2, 0.0);
    ahoge.rotation.z = -0.5;
    const eyes = [];
    for (const s of [1, -1]) {
      eyes.push(addBox(head, M.eye, 0.026, 0.038, 0.014, s * 0.045, 0.045, 0.118));
      addBox(head, M.white, 0.008, 0.01, 0.006, s * 0.045 + 0.006, 0.055, 0.127);
      addBox(head, M.hair, 0.045, 0.011, 0.012, s * 0.048, 0.095, 0.113);
      addBox(head, M.cheek, 0.032, 0.014, 0.006, s * 0.072, 0.0, 0.104);
      addBox(head, M.skin, 0.025, 0.045, 0.035, s * 0.124, 0.03, 0);
    }
    const mouth = addBox(head, M.mouth, 0.04, 0.013, 0.012, 0, -0.035, 0.103);

    const arms = {};
    for (const [name, side] of [['L', 1], ['R', -1]]) {
      const up = new THREE.Group();
      upper.add(up);
      addBox(up, M.shirt, 0.1, 0.13, 0.105, 0, -0.055, 0);
      addBox(up, M.skin, 0.072, 0.2, 0.072, 0, -0.17, 0);
      const lo = new THREE.Group();
      upper.add(lo);
      addBox(lo, M.skin, 0.066, 0.24, 0.066, 0, -0.12, 0);
      addBox(lo, M.skin, 0.078, 0.088, 0.04, 0, -0.29, 0);
      addBox(lo, M.skin, 0.022, 0.05, 0.024, -side * 0.035, -0.27, 0.022);
      arms[name] = {
        side, up, lo,
        shoulder: new V3(side * 0.205, 0.35, 0),
        pole: new V3(side * 0.6, -0.25, -1).normalize(),
        target: new V3(), elbow: new V3(), hand: new V3(),
      };
    }
    // 黒板消し（右手に持っている）
    const eraser = new THREE.Group();
    addBox(eraser, lam(0x24365e), 0.13, 0.035, 0.05, 0, 0, 0);
    addBox(eraser, lam(0xd9cfb8), 0.13, 0.012, 0.05, 0, -0.022, 0);
    eraser.position.set(0, -0.33, 0.02);
    eraser.rotation.x = Math.PI / 2;
    arms.R.lo.add(eraser);

    root.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    scene.add(root);
    return { root, hips, upper, head, legs, arms, eyes, mouth, eraser };
  }

  // ===== 組み立て =====
  buildClassroom();
  buildOutside();
  const arm = buildPlayerArm();
  const broom = buildBroom();
  const fr = Object.assign(buildFriend(), {
    state: 'wipe', st: 0, pos: new V3(), y: PODIUM.h, yaw: Math.PI, phase: 0, walk: 0,
    path: [], lean: 0, atk: null, nextAtk: 0, lines: new Set(), chatAt: 0,
    blinkAt: 2, cheer: 0, grin: 0, talkUntil: 0,
  });
  const FRIEND_HOME = new V3(1.85, 0, -5.86);
  const trayEraser = new THREE.Mesh(UNIT_BOX, lam(0x24365e));
  trayEraser.scale.set(0.13, 0.035, 0.05);
  trayEraser.position.set(2.05, BOARD.y0 + 0.01, ROOM.z0 + 0.06);
  trayEraser.visible = false;
  scene.add(trayEraser);

  // ===== 音（Web Audio で合成。音声ファイルは使わない） =====
  const sound = (() => {
    let ctx = null, master = null, noiseBuf = null;
    let muted = store.get(KEY_MUTE) === '1';
    const VOL = 0.55;
    function ensure() {
      if (!ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        try { ctx = new AC(); } catch (e) { return null; }
        master = ctx.createGain();
        master.gain.value = muted ? 0 : VOL;
        master.connect(ctx.destination);
        noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
        const d = noiseBuf.getChannelData(0);
        for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      }
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      return ctx;
    }
    function tone(f, dur, { type = 'sine', vol = 0.25, at = 0, to = 0, attack = 0.005 } = {}) {
      if (!ctx || muted) return;
      const t0 = ctx.currentTime + at;
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = type;
      o.frequency.setValueAtTime(f, t0);
      if (to) o.frequency.exponentialRampToValueAtTime(to, t0 + dur);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(vol, t0 + attack);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      o.connect(g);
      g.connect(master);
      o.start(t0);
      o.stop(t0 + dur + 0.05);
    }
    function noise(dur, { vol = 0.2, at = 0, freq = 1200, q = 1 } = {}) {
      if (!ctx || muted) return;
      const t0 = ctx.currentTime + at;
      const src = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
      src.buffer = noiseBuf;
      f.type = 'bandpass';
      f.frequency.value = freq;
      f.Q.value = q;
      g.gain.setValueAtTime(vol, t0);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      src.connect(f);
      f.connect(g);
      g.connect(master);
      src.start(t0, Math.random() * 0.5);
      src.stop(t0 + dur + 0.05);
    }
    return {
      unlock: ensure,
      get muted() { return muted; },
      setMuted(m) {
        muted = m;
        store.set(KEY_MUTE, m ? '1' : '0');
        if (master) master.gain.value = m ? 0 : VOL;
      },
      chime() {
        [659.3, 523.3, 587.3, 392.0].forEach((f, i) => {
          tone(f, 1.2, { vol: 0.12, at: i * 0.45, attack: 0.01 });
          tone(f * 2.01, 0.5, { vol: 0.025, at: i * 0.45 });
        });
      },
      go() { tone(520, 0.1, { type: 'triangle', vol: 0.2 }); tone(780, 0.14, { type: 'triangle', vol: 0.2, at: 0.08 }); },
      blip() { tone(880, 0.05, { type: 'square', vol: 0.04 }); tone(1100, 0.05, { type: 'square', vol: 0.035, at: 0.06 }); },
      poke() { tone(620, 0.14, { vol: 0.3, to: 240 }); noise(0.05, { vol: 0.15, freq: 2500, q: 1.5 }); },
      whoosh() { noise(0.35, { vol: 0.12, freq: 700, q: 0.8 }); },
      milestone() { tone(988, 0.25, { vol: 0.14 }); tone(1319, 0.4, { vol: 0.14, at: 0.12 }); },
      fail() { tone(392, 0.18, { type: 'triangle', vol: 0.16 }); tone(311, 0.3, { type: 'triangle', vol: 0.16, at: 0.16 }); },
      clatter() {
        [0, 0.12, 0.22, 0.3, 0.36].forEach((at, i) => {
          const v = 0.3 * Math.pow(0.68, i);
          tone(rand(380, 640), 0.13, { type: 'triangle', vol: v, at, to: rand(190, 300) });
          tone(rand(900, 1500), 0.06, { type: 'square', vol: v * 0.2, at });
          noise(0.09, { vol: v * 0.7, at, freq: rand(1500, 3200), q: 2 });
        });
      },
    };
  })();

  function vibrate(ms) {
    try { if (navigator.vibrate) navigator.vibrate(ms); } catch (e) { /* 対応していなければ何もしない */ }
  }

  // ===== ゲームの状態 =====
  const PH = {
    k: 1.08,          // ほうきの慣性で決まる係数（m*l/I）
    damp: 1.5,        // 大きいほど倒れ方がゆっくりになる
    zGrav: 0.45,      // 奥行き方向は見えにくいので倒れ方を穏やかにする
    fail: 1.05,       // この角度（ラジアン）を超えたら落下
    step: 1 / 240,
    handW: 32,        // 手が指の動きについてくる速さ
    handAmax: 60,
    sens: 1.0,        // 画面幅いっぱいのドラッグで何メートル動くか
    rangeX: 0.55, rangeFwd: 0.38, rangeBack: 0.3,
  };
  function gravityAt(t) {
    return 0.5 + 2.2 * clamp(t / 60, 0, 1) + 2.4 * clamp((t - 60) / 60, 0, 1);
  }

  const st = {
    mode: 'title', // title | ready | play | paused | fall | result
    t: 0, acc: 0, clock: 0,
    tx: 0, tz: 0, wx: 0, wz: 0,
    hand: new V3(0, 0, REST_Z), handV: new V3(), handA: new V3(), handT: new V3(0, 0, REST_Z),
    body: new V3(),
    noise: [0, 0, 0, 0, 0, 0],
    shake: 0,
    fall: null,
    nextMilestone: 0,
    camPitch: 0.42, camYaw: 0,
    armDrop: 0,
  };
  const G = { st, fr, PH, bot: null }; // テスト用の参照（外部には公開しない）

  const MILESTONES = [
    { t: 5, text: '友達が気づいた…！' },
    { t: 10, text: '友達が邪魔してくる！', danger: true },
    { t: 20, text: '20秒突破！' },
    { t: 30, text: '30秒突破！ すごい！' },
  ];
  function milestoneAt(i) {
    if (i < MILESTONES.length) return MILESTONES[i];
    const t = 40 + (i - MILESTONES.length) * 10;
    return { t, text: `${t}秒突破！` };
  }

  // ===== 入力 =====
  const input = { id: null, x: 0, y: 0, keys: new Set() };
  let stageW = 360, stageH = 640;

  ui.canvas.addEventListener('pointerdown', (e) => {
    if (st.mode === 'ready') startPlay();
    if (st.mode !== 'play') return;
    input.id = e.pointerId;
    input.x = e.clientX;
    input.y = e.clientY;
    try { ui.canvas.setPointerCapture(e.pointerId); } catch (err) { /* 古いブラウザ */ }
    e.preventDefault();
  });
  ui.canvas.addEventListener('pointermove', (e) => {
    if (e.pointerId !== input.id || st.mode !== 'play') return;
    const dx = e.clientX - input.x, dy = e.clientY - input.y;
    input.x = e.clientX;
    input.y = e.clientY;
    moveHandTarget(dx / stageW * PH.sens, dy / stageW * PH.sens);
  });
  const endPointer = (e) => { if (e.pointerId === input.id) input.id = null; };
  ui.canvas.addEventListener('pointerup', endPointer);
  ui.canvas.addEventListener('pointercancel', endPointer);
  ui.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  function moveHandTarget(dx, dz) {
    st.handT.x = clamp(st.handT.x + dx, -PH.rangeX, PH.rangeX);
    st.handT.z = clamp(st.handT.z + dz, REST_Z - PH.rangeFwd, REST_Z + PH.rangeBack);
  }

  const KEYMAP = {
    ArrowLeft: 'l', KeyA: 'l', ArrowRight: 'r', KeyD: 'r', ArrowUp: 'u', KeyW: 'u', ArrowDown: 'd', KeyS: 'd',
  };
  window.addEventListener('keydown', (e) => {
    if ((e.code === 'Enter' || e.code === 'Space') && !e.repeat && !(e.target instanceof HTMLButtonElement) && !(e.target instanceof HTMLAnchorElement)) {
      if (st.mode === 'title') { e.preventDefault(); ui.start.click(); return; }
      if (st.mode === 'result') { e.preventDefault(); ui.retry.click(); return; }
      if (st.mode === 'ready') { e.preventDefault(); startPlay(); return; }
    }
    const k = KEYMAP[e.code];
    if (!k) return;
    if (st.mode === 'ready') startPlay();
    if (st.mode === 'play') {
      input.keys.add(k);
      e.preventDefault();
    }
  });
  window.addEventListener('keyup', (e) => { const k = KEYMAP[e.code]; if (k) input.keys.delete(k); });
  window.addEventListener('blur', () => input.keys.clear());

  function applyKeys(dt) {
    if (!input.keys.size) return;
    const sp = 0.8 * dt;
    const dx = (input.keys.has('r') ? 1 : 0) - (input.keys.has('l') ? 1 : 0);
    const dz = (input.keys.has('d') ? 1 : 0) - (input.keys.has('u') ? 1 : 0);
    moveHandTarget(dx * sp, dz * sp);
  }

  // ===== ふきだし・バナー =====
  let bubbleUntil = 0;
  function say(text, dur = 1.8) {
    ui.bubbleText.textContent = text;
    ui.bubble.classList.remove('hidden');
    bubbleUntil = st.clock + dur;
    fr.talkUntil = st.clock + Math.min(dur, 1.2);
    sound.blip();
  }
  function hideBubble() {
    ui.bubble.classList.add('hidden');
    bubbleUntil = 0;
  }
  function showBanner(text, danger) {
    ui.banner.textContent = text;
    ui.banner.classList.toggle('danger', !!danger);
    ui.banner.classList.remove('show');
    void ui.banner.offsetWidth;
    ui.banner.classList.add('show');
  }
  function setHint(text, pulse) {
    ui.hint.textContent = text;
    ui.hint.classList.toggle('pulse', !!pulse);
  }

  // ===== 進行 =====
  function resetRound() {
    st.t = 0;
    st.acc = 0;
    st.tx = st.tz = st.wx = st.wz = 0;
    st.hand.set(0, 0, REST_Z);
    st.handT.set(0, 0, REST_Z);
    st.handV.set(0, 0, 0);
    st.handA.set(0, 0, 0);
    st.fall = null;
    st.shake = 0;
    st.nextMilestone = 0;
    st.armDrop = 0;
    for (let i = 0; i < 6; i++) st.noise[i] = rand(0, Math.PI * 2);
    input.id = null;
    input.keys.clear();
    resetFriend();
    hideBubble();
    ui.banner.classList.remove('show');
    ui.time.textContent = '0.00';
  }

  function toTitle() {
    resetRound();
    st.mode = 'title';
    ui.title.classList.remove('hidden');
    ui.result.classList.add('hidden');
    ui.hud.classList.add('hidden');
    ui.titleBest.textContent = best > 0 ? best.toFixed(2) : '--';
  }

  function toReady() {
    resetRound();
    st.mode = 'ready';
    ui.title.classList.add('hidden');
    ui.result.classList.add('hidden');
    ui.hud.classList.remove('hidden');
    ui.hudBest.textContent = best.toFixed(2);
    setHint('画面をタッチしてスタート！', true);
  }

  function startPlay() {
    st.mode = 'play';
    // 最初の傾きは横向きにほぼ一定にする（何もしないと10〜12秒で落ちるように）
    st.tx = (Math.random() < 0.5 ? -1 : 1) * rand(0.018, 0.022);
    st.tz = rand(-0.005, 0.005);
    sound.unlock();
    sound.go();
    setHint('ドラッグで手を動かそう', false);
  }

  function beginFall() {
    st.mode = 'fall';
    st.fall = { phase: 'tip', t: 0, com: null, v: new V3(), q: new THREE.Quaternion(), w: new V3(), restQ: null, restP: null, fromQ: null, fromP: null };
    input.id = null;
    sound.fail();
    setHint('', false);
    friendReact();
  }

  const RANKS = [
    { t: 0, title: 'ほうき見習い', comment: '友達はまだ黒板をふいている…まずは5秒をめざそう！' },
    { t: 5, title: 'そうじ当番', comment: '友達「あー、おしい！」' },
    { t: 10, title: 'バランス係', comment: '友達「ジャマしたのに…やるじゃん」' },
    { t: 20, title: 'ほうき職人', comment: '友達「まじかよ…クラスで自慢していい？」' },
    { t: 30, title: '学年のレジェンド', comment: '友達「お前…何者？」' },
    { t: 60, title: '伝説の日直', comment: '友達「…弟子にしてください」' },
  ];

  function showResult() {
    st.mode = 'result';
    const t = Math.floor(st.t * 100) / 100;
    const isNew = t > best;
    if (isNew) {
      best = t;
      store.set(KEY_BEST, best.toFixed(2));
    }
    let rank = RANKS[0];
    for (const r of RANKS) if (t >= r.t) rank = r;
    ui.resTime.textContent = t.toFixed(2);
    ui.resRank.textContent = rank.title;
    ui.resComment.textContent = rank.comment;
    ui.resBest.textContent = best.toFixed(2);
    ui.resNew.classList.toggle('hidden', !isNew);
    ui.share.href = buildShareUrl(t, rank.title);
    ui.hud.classList.add('hidden');
    ui.result.classList.remove('hidden');
    hideBubble();
    if (isNew) sound.milestone();
  }

  // シェア用URL。本文は数値と固定文だけで組み立て、必ずエンコードする
  function buildShareUrl(t, title) {
    const text = `教室でほうきを手のひらに乗せて【${t.toFixed(2)}秒】キープできた！\n称号：${title}\n#ほうきバランス`;
    const params = [`text=${encodeURIComponent(text)}`];
    if (location.protocol === 'https:' || location.protocol === 'http:') {
      params.push(`url=${encodeURIComponent(location.origin + location.pathname)}`);
    }
    return `https://x.com/intent/tweet?${params.join('&')}`;
  }

  // ===== 物理 =====
  function stepPlay(h) {
    st.t += h;
    const t = st.t;
    for (const ax of ['x', 'z']) {
      const a = clamp(PH.handW * PH.handW * (st.handT[ax] - st.hand[ax]) - 2 * PH.handW * st.handV[ax], -PH.handAmax, PH.handAmax);
      st.handV[ax] += a * h;
      st.hand[ax] += st.handV[ax] * h;
      st.handA[ax] = a;
    }
    const g = gravityAt(t) * clamp(t / 0.6, 0, 1);
    const amp = 0.01 + 0.06 * clamp(t / 60, 0, 1);
    const p = st.noise;
    const nx = amp * (Math.sin(1.7 * t + p[0]) + 0.6 * Math.sin(3.3 * t + p[1]) + 0.35 * Math.sin(6.1 * t + p[2]));
    const nz = amp * (Math.sin(1.3 * t + p[3]) + 0.6 * Math.sin(2.9 * t + p[4]) + 0.35 * Math.sin(5.7 * t + p[5]));
    const ax = PH.k * (g * Math.sin(st.tx) - st.handA.x * Math.cos(st.tx)) - PH.damp * st.wx + nx;
    const az = PH.k * (g * PH.zGrav * Math.sin(st.tz) - st.handA.z * Math.cos(st.tz)) - PH.damp * st.wz + nz;
    st.wx += ax * h;
    st.wz += az * h;
    st.tx += st.wx * h;
    st.tz += st.wz * h;
    if (Math.hypot(st.tx, st.tz) > PH.fail) beginFall();
  }

  // 傾き（tx, tz）からほうきの向き
  function tiltDir(tx, tz, out) {
    const a = Math.hypot(tx, tz);
    if (a < 1e-9) return out.set(0, 1, 0);
    const s = Math.sin(a) / a;
    return out.set(tx * s, Math.cos(a), tz * s);
  }

  const _dir = new V3(), _tmp = new V3(), _tmp2 = new V3(), _dq = new THREE.Quaternion(), _basis = new THREE.Matrix4();
  function stepFall(dt) {
    const F = st.fall;
    F.t += dt;
    if (F.phase === 'tip') {
      st.handV.multiplyScalar(Math.exp(-8 * dt));
      st.hand.addScaledVector(st.handV, dt);
      const n = 4, h = dt / n;
      for (let i = 0; i < n; i++) {
        const a = Math.hypot(st.tx, st.tz) || 1e-6;
        const acc = PH.k * 9.8 * Math.sin(a);
        st.wx += (acc * st.tx / a) * h;
        st.wz += (acc * st.tz / a) * h;
        st.tx += st.wx * h;
        st.tz += st.wz * h;
      }
      if (Math.hypot(st.tx, st.tz) > 1.25) {
        const dir = tiltDir(st.tx, st.tz, _dir);
        F.q.setFromUnitVectors(UP, dir);
        F.w.set(st.wz, 0, -st.wx);
        const pivot = _tmp.set(st.hand.x, HAND_Y, st.hand.z);
        F.com = pivot.clone().addScaledVector(dir, BROOM_COM);
        F.v.crossVectors(F.w, _tmp2.copy(dir).multiplyScalar(BROOM_COM)).add(st.handV);
        F.phase = 'air';
      }
    } else if (F.phase === 'air') {
      F.v.y -= 9.8 * dt;
      F.com.addScaledVector(F.v, dt);
      const wl = F.w.length();
      if (wl > 1e-6) {
        _dq.setFromAxisAngle(_tmp.copy(F.w).divideScalar(wl), wl * dt);
        F.q.premultiply(_dq);
      }
      const dir = _dir.copy(UP).applyQuaternion(F.q);
      const yLow = Math.min(F.com.y - dir.y * BROOM_COM, F.com.y + dir.y * (BROOM_LEN - BROOM_COM));
      if (yLow < 0.03 || F.t > 3) {
        // 床に寝かせる（穂の平らな面を下に）
        const hd = _tmp.set(dir.x, 0, dir.z);
        if (hd.lengthSq() < 1e-6) hd.set(1, 0, 0);
        hd.normalize();
        const xAxis = _tmp2.crossVectors(hd, UP).normalize();
        _basis.makeBasis(xAxis, hd, UP);
        F.restQ = new THREE.Quaternion().setFromRotationMatrix(_basis);
        F.restP = new V3(F.com.x, 0.028, F.com.z).addScaledVector(hd, -BROOM_COM);
        F.fromQ = F.q.clone();
        F.fromP = F.com.clone().addScaledVector(dir, -BROOM_COM);
        F.phase = 'rest';
        F.t = 0;
        sound.clatter();
        vibrate(120);
        st.shake = 0.5;
      }
    } else if (F.phase === 'rest') {
      if (F.t > 1.1 && st.mode === 'fall') showResult();
    }
  }

  // ===== 友達の行動 =====
  const SPOT_BASE = { x: 0.42, z: -0.86 }, SPOT_POKE = { x: 0.4, z: -0.6 }, SPOT_WAVE = { x: 0.34, z: -0.34 };
  function friendSpot(out, lunge = 0, kind = SPOT_POKE) {
    out.set(st.hand.x + lerp(SPOT_BASE.x, kind.x, lunge), 0, st.hand.z + lerp(SPOT_BASE.z, kind.z, lunge));
    return out;
  }

  function resetFriend() {
    fr.state = 'wipe';
    fr.st = 0;
    fr.pos.copy(FRIEND_HOME);
    fr.y = PODIUM.h;
    fr.yaw = Math.PI;
    fr.walk = 0;
    fr.lean = 0;
    fr.atk = null;
    fr.nextAtk = 10.1;
    fr.lines.clear();
    fr.chatAt = 0;
    fr.cheer = 0;
    fr.grin = 0;
    fr.talkUntil = 0;
    fr.eraser.visible = true;
    trayEraser.visible = false;
  }

  function friendReact() {
    if (fr.state === 'wipe' || fr.state === 'turn') {
      say('ん？ なんか落ちた？', 1.8);
      return;
    }
    fr.state = 'react';
    fr.atk = null;
    fr.st = 0;
    fr.cheer = 1;
    say(pick(['あっ！', 'あーあ！', 'おしいっ！']), 1.6);
  }

  function groundY(x, z) {
    return z < PODIUM.z1 && x > PODIUM.x0 && x < PODIUM.x1 ? PODIUM.h : 0;
  }

  const _fv = new V3();
  function walkTowards(target, speed, dt) {
    _fv.set(target.x - fr.pos.x, 0, target.z - fr.pos.z);
    const d = _fv.length();
    if (d < 1e-4) return 0;
    const stepLen = Math.min(d, speed * dt);
    fr.pos.addScaledVector(_fv, stepLen / d);
    fr.yaw = angleLerp(fr.yaw, Math.atan2(_fv.x, _fv.z), 1 - Math.exp(-10 * dt));
    return d - stepLen;
  }

  function chooseAttack(t) {
    const r = Math.random();
    if (t > 14 && r < 0.22) return 'wave';
    if (t > 18 && r < 0.36) return 'feint';
    return 'poke';
  }

  function startAttack(t) {
    const type = chooseAttack(t);
    const lv = clamp((t - 10) / 50, 0, 1);
    fr.atk = {
      type, t: 0, hit: false, said: false,
      side: Math.random() < 0.6 ? 1 : -1,
      s: rand(0.36, 0.52),
      windup: lerp(0.8, 0.5, lv),
      strike: 0.14,
      recover: 0.42,
      power: (0.15 + 0.25 * lv) * rand(0.85, 1.15),
      last: new V3(),
    };
    if (type === 'wave') {
      fr.atk.windup = 0.45;
      fr.atk.strike = 1.5;
      fr.atk.recover = 0.45;
      say(pick(['ほれほれ〜', '見えるかな〜？', 'こちょこちょ〜']), 1.6);
      sound.whoosh();
    } else {
      say(pick(['えいっ！', 'それっ！', 'ほいっ', 'つんっ！']), 1.0);
    }
    fr.state = 'attack';
    fr.st = 0;
  }

  // 攻撃中の手の目標（ワールド座標）と重み
  const _atkT = new V3(), _contact = new V3(), _windPt = new V3();
  function attackTarget(A) {
    const dir = tiltDir(st.tx, st.tz, _dir);
    _contact.set(st.hand.x, HAND_Y, st.hand.z).addScaledVector(dir, A.s);
    const tw = A.t, t1 = A.windup, t2 = t1 + A.strike, t3 = t2 + A.recover;
    let w = 1;
    if (A.type === 'wave') {
      camera.getWorldDirection(_tmp);
      _atkT.copy(camera.position).addScaledVector(_tmp, 0.4);
      _tmp2.set(1, 0, 0).applyQuaternion(camera.quaternion);
      _atkT.addScaledVector(_tmp2, 0.03 + Math.sin(tw * 11) * 0.09 * smooth((tw - t1 * 0.5) / t1));
      _atkT.y -= 0.03;
      if (tw < t1) w = smooth(tw / t1);
      else if (tw > t2) w = 1 - smooth((tw - t2) / A.recover);
      A.last.copy(_atkT);
      return w;
    }
    _windPt.copy(_contact).add(_tmp.set(A.side * 0.22, 0.06, -0.08));
    if (tw < t1) {
      _atkT.copy(_windPt);
      w = smooth(tw / t1);
    } else if (tw < t2) {
      const u = (tw - t1) / A.strike;
      const end = A.type === 'feint' ? _tmp.copy(_contact).add(_tmp2.set(A.side * 0.08, 0.02, -0.03)) : _tmp.copy(_contact).add(_tmp2.set(-A.side * 0.1, 0, 0.02));
      _atkT.copy(_windPt).lerp(end, u * u);
      A.last.copy(_atkT);
      if (A.type === 'poke' && !A.hit && u >= 0.55) {
        A.hit = true;
        hitBroom(A);
      }
    } else {
      _atkT.copy(A.last);
      w = 1 - smooth((tw - t2) / A.recover);
      if (A.type === 'feint' && !A.said) {
        A.said = true;
        say('…なーんてね♪', 1.3);
      }
    }
    if (tw >= t3) w = 0;
    return w;
  }

  function hitBroom(A) {
    if (st.mode !== 'play') return;
    let dx = -A.side, dz = rand(-0.1, 0.3);
    const l = Math.hypot(dx, dz);
    dx /= l;
    dz /= l;
    st.wx += dx * A.power;
    st.wz += dz * A.power;
    st.shake = Math.max(st.shake, 0.18);
    sound.poke();
    vibrate(30);
  }

  const _sp = new V3(), _look = new V3(), _loc = new V3(), _idle = new V3(), _wt = new V3();
  function updateFriend(dt) {
    const T = st.t;
    const playing = st.mode === 'play';
    fr.st += dt;
    let moving = 0;
    let atkW = 0;

    if (fr.state === 'wipe') {
      if (playing && T >= 5) {
        fr.state = 'turn';
        fr.st = 0;
        fr.eraser.visible = false;
        trayEraser.visible = true;
        fr.path = [new V3(1.85, 0, -5.06), new V3(0.86, 0, -5.02), new V3(0.86, 0, -2.3), friendSpot(new V3())];
        say('お？ なにしてんの？', 2.2);
      }
    } else if (fr.state === 'turn') {
      const wp = fr.path[0];
      fr.yaw = angleLerp(fr.yaw, Math.atan2(wp.x - fr.pos.x, wp.z - fr.pos.z), 1 - Math.exp(-9 * dt));
      if (fr.st > 0.4) { fr.state = 'walk'; fr.st = 0; }
    } else if (fr.state === 'walk') {
      friendSpot(fr.path[fr.path.length - 1]);
      let budget = 1.45 * dt;
      while (budget > 0 && fr.path.length) {
        const before = Math.hypot(fr.path[0].x - fr.pos.x, fr.path[0].z - fr.pos.z);
        const left = walkTowards(fr.path[0], budget / dt, dt);
        budget -= before - left;
        if (left < 0.02) fr.path.shift(); else break;
      }
      moving = 1;
      if (!fr.path.length) { fr.state = 'watch'; fr.st = 0; }
      if (playing && T >= 7.2 && !fr.lines.has('a')) { fr.lines.add('a'); say('ほうき乗せてんの！？', 1.8); }
    } else if (fr.state === 'watch' || fr.state === 'attack') {
      const lunge = fr.atk && fr.atk.type !== 'feint' ? attackWeightPreview(fr.atk) : fr.atk ? attackWeightPreview(fr.atk) * 0.6 : 0;
      friendSpot(_sp, lunge, fr.atk && fr.atk.type === 'wave' ? SPOT_WAVE : SPOT_POKE);
      const d = Math.hypot(_sp.x - fr.pos.x, _sp.z - fr.pos.z);
      if (d > 0.05) {
        walkTowards(_sp, Math.min(1.4, d * 5), dt);
        if (d > 0.12) moving = clamp(d * 4, 0, 1);
      }
      // 自分（ほうき）の方を向く
      fr.yaw = angleLerp(fr.yaw, Math.atan2(st.hand.x - fr.pos.x, st.hand.z - fr.pos.z), 1 - Math.exp(-6 * dt));
      if (fr.state === 'watch' && playing) {
        if (T >= 9.2 && !fr.lines.has('b')) { fr.lines.add('b'); say('ちょっと邪魔しちゃお〜', 1.4); }
        if (T >= fr.nextAtk) startAttack(T);
        else if (st.clock > bubbleUntil + 4 && st.clock > fr.chatAt) {
          fr.chatAt = st.clock + rand(5, 8);
          if (T > 12) say(pick(['まだいけるの！？', 'しぶといな〜', 'なかなかやるじゃん', 'ぐらぐらしてるよ〜']), 1.6);
        }
      }
    } else if (fr.state === 'react') {
      fr.cheer = Math.max(0, fr.cheer - dt * 0.5);
    }

    if (fr.state === 'attack') {
      fr.atk.t += dt;
      atkW = attackTarget(fr.atk);
      const A = fr.atk;
      if (A.t >= A.windup + A.strike + A.recover) {
        fr.atk = null;
        fr.state = 'watch';
        const lv = clamp((T - 10) / 50, 0, 1);
        fr.nextAtk = T + lerp(4.3, 2.6, lv) + rand(-0.4, 0.6);
      }
    }
    fr.grin = damp(fr.grin, fr.state === 'attack' ? 1 : 0, 8, dt);

    // --- 体の姿勢 ---
    fr.walk = damp(fr.walk, moving, 8, dt);
    fr.phase += dt * (5.5 + 3 * fr.walk) * (fr.walk > 0.05 ? 1 : 0);
    fr.y = damp(fr.y, groundY(fr.pos.x, fr.pos.z), 12, dt);
    fr.root.position.set(fr.pos.x, fr.y, fr.pos.z);
    fr.root.rotation.y = fr.yaw;
    fr.hips.position.y = 0.88 - 0.012 * fr.walk + Math.abs(Math.cos(fr.phase)) * 0.022 * fr.walk;
    for (const L of fr.legs) {
      const ph = fr.phase + (L.side > 0 ? 0 : Math.PI);
      L.thigh.rotation.x = -Math.sin(ph) * 0.5 * fr.walk;
      L.knee.rotation.x = Math.max(0, Math.cos(ph)) * 0.75 * fr.walk;
      L.foot.rotation.x = -(L.thigh.rotation.x + L.knee.rotation.x) * 0.5;
    }
    let leanT = 0.04 * fr.walk;
    if (fr.atk && atkW > 0) {
      _wt.copy(fr.atk.type === 'wave' ? fr.atk.last : _atkT);
      const hd = Math.hypot(_wt.x - fr.pos.x, _wt.z - fr.pos.z);
      leanT += clamp((hd - 0.35) * 0.9, 0, 0.38) * atkW;
    }
    fr.lean = damp(fr.lean, leanT, 10, dt);
    fr.upper.rotation.x = fr.lean;
    fr.upper.rotation.z = Math.sin(fr.phase) * 0.03 * fr.walk;
    fr.root.updateMatrixWorld(true);

    // --- 頭の向き ---
    let lookW = 0;
    if (fr.state === 'react') {
      if (st.fall && st.fall.com) { _look.copy(st.fall.com); lookW = 1; }
    } else if (fr.state !== 'wipe') {
      if (st.clock < fr.talkUntil) _look.copy(camera.position);
      else tiltDir(st.tx, st.tz, _look).multiplyScalar(BROOM_LEN * 0.8).add(_tmp.set(st.hand.x, HAND_Y, st.hand.z));
      lookW = fr.state === 'turn' ? 0 : 1;
    }
    if (lookW > 0) {
      fr.upper.worldToLocal(_loc.copy(_look)).sub(fr.head.position);
      const yawH = clamp(Math.atan2(_loc.x, _loc.z), -1.0, 1.0);
      const pitchH = clamp(-Math.atan2(_loc.y, Math.hypot(_loc.x, _loc.z)), -0.6, 0.5);
      fr.head.rotation.y = damp(fr.head.rotation.y, yawH, 8, dt);
      fr.head.rotation.x = damp(fr.head.rotation.x, pitchH, 8, dt);
    } else {
      fr.head.rotation.y = damp(fr.head.rotation.y, 0, 6, dt);
      fr.head.rotation.x = damp(fr.head.rotation.x, fr.state === 'wipe' ? -0.15 : 0, 6, dt);
    }

    // --- 顔 ---
    if (st.clock > fr.blinkAt) fr.blinkAt = st.clock + rand(2, 4.5);
    const closed = fr.blinkAt - st.clock < 0.12;
    for (const e of fr.eyes) e.scale.y = 0.038 * (closed ? 0.15 : 1);
    const talking = st.clock < fr.talkUntil;
    fr.mouth.scale.x = 0.04 * (1 + 0.6 * fr.grin);
    fr.mouth.scale.y = 0.013 * (talking ? 1 + 1.8 * Math.abs(Math.sin(st.clock * 18)) : 1 + fr.grin);

    // --- 腕（IK） ---
    for (const key of ['L', 'R']) {
      const A = fr.arms[key];
      const s = A.side;
      const swing = -Math.sin(fr.phase + (s > 0 ? 0 : Math.PI)) * 0.16 * fr.walk;
      _idle.set(A.shoulder.x + s * 0.05, A.shoulder.y - 0.52, A.shoulder.z + 0.06 + swing);
      if (fr.state === 'wipe' && key === 'R') {
        const w = st.clock * 6.5;
        _idle.set(A.shoulder.x + 0.05 + Math.cos(w) * 0.13, A.shoulder.y + 0.14 + Math.sin(w) * 0.1, 0.27);
      }
      if (fr.cheer > 0) {
        const c = smooth(Math.min(1, fr.cheer * 2.5));
        _idle.lerp(_tmp.set(A.shoulder.x + s * 0.15, A.shoulder.y + 0.5, 0.05 + Math.sin(st.clock * 14 + s) * 0.04), c);
      }
      A.target.copy(_idle);
      if (key === 'R' && fr.atk && atkW > 0) {
        fr.upper.worldToLocal(_loc.copy(fr.atk.type === 'wave' ? fr.atk.last : _atkT));
        A.target.lerp(_loc, atkW);
      }
      solveIK(A.shoulder, A.target, 0.27, 0.29, A.pole, A.elbow, A.hand);
      orientSegment(A.up, A.shoulder, A.elbow, 0.27);
      orientSegment(A.lo, A.elbow, A.hand, 0.29);
    }
  }

  function attackWeightPreview(A) {
    const t1 = A.windup, t2 = t1 + A.strike;
    if (A.t < t1) return smooth(A.t / t1);
    if (A.t < t2) return 1;
    return 1 - smooth((A.t - t2) / A.recover);
  }

  // ===== カメラ・腕・ほうきの配置 =====
  const _eye = new V3(), _piv = new V3(), _sh = new V3(), _wrist = new V3(), _elbow = new V3(), _lk = new V3();
  const ARM_POLE = new V3(0.6, -1, 0.3).normalize();
  function updateRig(dt) {
    // タイトル中はほうきが軽くゆれているだけ
    if (st.mode === 'title') {
      st.tx = 0.03 * Math.sin(st.clock * 1.1);
      st.tz = 0.018 * Math.sin(st.clock * 0.8 + 1);
      st.hand.x = st.tx * 0.35;
    }
    st.body.set(st.hand.x * 0.45, 0, (st.hand.z - REST_Z) * 0.85);
    const pivot = _piv.set(st.hand.x, HAND_Y, st.hand.z);

    // ほうき
    const F = st.fall;
    if (F && F.phase === 'air') {
      broom.quaternion.copy(F.q);
      broom.position.copy(F.com).addScaledVector(_dir.copy(UP).applyQuaternion(F.q), -BROOM_COM);
    } else if (F && F.phase === 'rest') {
      const u = smooth(F.t / 0.16);
      broom.quaternion.slerpQuaternions(F.fromQ, F.restQ, u);
      broom.position.lerpVectors(F.fromP, F.restP, u);
      broom.position.y += Math.abs(Math.sin(F.t * 16)) * 0.05 * Math.exp(-F.t * 7);
    } else {
      broom.position.copy(pivot);
      broom.quaternion.setFromUnitVectors(UP, tiltDir(st.tx, st.tz, _dir));
    }

    // カメラ：ほうきの中ほどを見る。頭（穂先）が動いた分の半分だけ追いかける
    _eye.set(st.body.x, 1.5 + Math.sin(st.clock * 1.3) * 0.004, st.body.z);
    let pitchT, yawT;
    if (F && F.com && st.mode !== 'play') {
      _lk.copy(broom.position).addScaledVector(_dir.copy(UP).applyQuaternion(broom.quaternion), BROOM_COM);
    } else {
      tiltDir(st.tx, st.tz, _dir);
      _lk.copy(pivot).add(_tmp.set(0, 0.43, 0)).addScaledVector(_tmp2.copy(_dir).multiplyScalar(BROOM_LEN).sub(_tmp.set(0, BROOM_LEN, 0)), 0.5);
    }
    _tmp.subVectors(_lk, _eye);
    const hz = Math.hypot(_tmp.x, _tmp.z);
    pitchT = clamp(Math.atan2(_tmp.y, hz) - (st.mode === 'result' ? 0.38 : 0), -1.35, 0.8);
    yawT = Math.atan2(-_tmp.x, -_tmp.z) * (F && F.com ? 0.8 : 0.4);
    const k = F && F.com ? 3.5 : 9;
    st.camPitch = damp(st.camPitch, pitchT, k, dt);
    st.camYaw = damp(st.camYaw, yawT, k, dt);
    st.shake = Math.max(0, st.shake - dt * 1.6);
    const sh = st.shake * st.shake * 0.05;
    camera.position.copy(_eye);
    camera.rotation.set(st.camPitch + rand(-sh, sh), st.camYaw + rand(-sh, sh), rand(-sh, sh) * 0.5);
    camera.updateMatrixWorld();

    // 手と腕（ほうきが手を離れたら下ろす）
    st.armDrop = F && F.com ? Math.min(1, st.armDrop + dt * 2.5) : 0;
    const drop = smooth(st.armDrop);
    arm.hand.position.copy(pivot).add(_tmp.set(0.05 * drop, -0.6 * drop, 0.3 * drop));
    arm.hand.rotation.set(clamp(st.handA.z * 0.004, -0.2, 0.2), 0.12, clamp(-st.handA.x * 0.004, -0.2, 0.2));
    arm.hand.updateMatrixWorld();
    arm.hand.localToWorld(_wrist.set(0, -0.03, 0.095));
    _sh.copy(SHOULDER).add(st.body);
    solveIK(_sh, _wrist, 0.3, 0.29, ARM_POLE, _elbow, null);
    orientSegment(arm.fore, _wrist, _elbow, 0);
    orientSegment(arm.upper, _elbow, _sh, 0);
  }

  // ===== HUD =====
  function updateHUD() {
    if (st.mode === 'play' || st.mode === 'fall') {
      ui.time.textContent = st.t.toFixed(2);
      const r = 25;
      const m = Math.hypot(st.tx, st.tz) / PH.fail;
      const gx = clamp(st.tx / PH.fail, -1, 1) * r, gz = clamp(st.tz / PH.fail, -1, 1) * r;
      ui.gaugeDot.style.transform = `translate(${gx.toFixed(1)}px, ${gz.toFixed(1)}px)`;
      ui.gaugeDot.style.background = `hsl(${Math.round(130 - 130 * clamp(m, 0, 1))}, 75%, 58%)`;
    }
    if (st.mode === 'play') {
      if (st.t > 3 && ui.hint.textContent) setHint('', false);
      const ms = milestoneAt(st.nextMilestone);
      if (st.t >= ms.t) {
        st.nextMilestone++;
        showBanner(ms.text, ms.danger);
        sound.milestone();
        if (ms.t >= 20 && (fr.state === 'watch' || fr.state === 'attack') && st.clock > bubbleUntil) {
          say(ms.t >= 60 ? '伝説じゃん…' : ms.t >= 40 ? 'うそでしょ…' : ms.t >= 30 ? 'よーし本気出す！' : 'まだ落ちないの！？', 1.6);
        }
      }
    }
    // ふきだしを友達の頭の上へ
    if (bubbleUntil) {
      if (st.clock > bubbleUntil) { hideBubble(); return; }
      fr.head.localToWorld(_tmp.set(0, 0.27, 0));
      _tmp.project(camera);
      const behind = _tmp.z > 1;
      const x = (_tmp.x * 0.5 + 0.5) * stageW;
      const y = (-_tmp.y * 0.5 + 0.5) * stageH;
      const bw = ui.bubble.offsetWidth, bh = ui.bubble.offsetHeight;
      const cx = clamp(x, bw / 2 + 8, stageW - bw / 2 - 8);
      const cy = clamp(behind ? stageH * 0.4 : y, bh + 110, stageH - 40);
      ui.bubble.style.transform = `translate(${(cx - bw / 2).toFixed(1)}px, ${(cy - bh - 12).toFixed(1)}px)`;
      ui.bubble.style.setProperty('--tail', `${clamp(x - (cx - bw / 2), 16, bw - 16).toFixed(1)}px`);
    }
  }

  // ===== ループ =====
  function update(dt) {
    if (st.mode === 'paused') return;
    st.clock += dt;
    if (st.mode === 'play') {
      if (G.bot) G.bot(dt);
      applyKeys(dt);
      st.acc += dt;
      while (st.acc >= PH.step && st.mode === 'play') {
        stepPlay(PH.step);
        st.acc -= PH.step;
      }
    } else if (st.mode === 'fall' || (st.mode === 'result' && st.fall)) {
      stepFall(dt);
    }
    updateRig(dt);
    updateFriend(dt);
    updateHUD();
    updateClock();
  }

  const perf = { t: 0, n: 0, sum: 0 };
  function trackPerf(dt) {
    perf.t += dt;
    perf.n++;
    perf.sum += dt;
    if (perf.t > 2.5) {
      if (perf.sum / perf.n > 1 / 40 && pixelRatio > 1) {
        pixelRatio = Math.max(1, pixelRatio - 0.25);
        renderer.setPixelRatio(pixelRatio);
        resize();
      }
      perf.t = perf.n = perf.sum = 0;
    }
  }

  let last = performance.now();
  function frame(now) {
    requestAnimationFrame(frame);
    let dt = (now - last) / 1000;
    last = now;
    if (!(dt > 0)) return;
    if (dt > 0.05) dt = 0.05;
    update(dt);
    renderer.render(scene, camera);
    trackPerf(dt);
  }

  function resize() {
    const w = ui.stage.clientWidth, h = ui.stage.clientHeight;
    if (!w || !h) return;
    stageW = w;
    stageH = h;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  // ===== ボタン =====
  function refreshMute() {
    ui.mute.textContent = sound.muted ? '🔇' : '🔊';
    ui.mute.setAttribute('aria-label', sound.muted ? '音を出す' : '音を消す');
  }
  ui.mute.addEventListener('click', () => {
    sound.unlock();
    sound.setMuted(!sound.muted);
    refreshMute();
  });
  ui.start.addEventListener('click', () => {
    sound.unlock();
    sound.chime();
    toReady();
  });
  ui.retry.addEventListener('click', () => {
    sound.unlock();
    toReady();
  });
  ui.toTitle.addEventListener('click', toTitle);
  ui.resume.addEventListener('click', () => {
    ui.pause.classList.add('hidden');
    st.mode = 'play';
    last = performance.now();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && st.mode === 'play') {
      st.mode = 'paused';
      input.id = null;
      input.keys.clear();
      ui.pause.classList.remove('hidden');
    }
  });

  if (window.ResizeObserver) new ResizeObserver(resize).observe(ui.stage);
  window.addEventListener('resize', resize);
  resize();
  refreshMute();
  toTitle();
  requestAnimationFrame(frame);
  /* TEST-HOOK */
})();
