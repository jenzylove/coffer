// The hero scene: one deep blue glass seal on a cool studio backdrop. Text
// planes (the real .env lines, the real ciphertext, the real opened names) move
// in and out of the glass; the glass refracts and blurs whatever sits inside it.
import {
  ACESFilmicToneMapping, CanvasTexture, Color, DoubleSide, Group, LatheGeometry, LinearFilter, Mesh,
  MeshBasicMaterial, MeshPhysicalMaterial, PMREMGenerator, PerspectiveCamera, PlaneGeometry, RingGeometry,
  SRGBColorSpace, Scene, CircleGeometry, TorusGeometry, Vector2, Vector3, WebGLRenderer, type Texture,
} from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

export interface Glass {
  plain: (lines: string[]) => void;
  seal: (cipher: string[]) => void;
  open: (names: string[]) => void;
  refuse: () => void;
  dispose: () => void;
}

const isDark = () => document.documentElement.dataset.theme === "dark";
const MONO = '"DM Mono", ui-monospace, Consolas, monospace';
const SANS = '"Onest", system-ui, sans-serif';

function textTexture(text: string, o: { color: string; size?: number; font?: string; weight?: number }) {
  const px = (o.size ?? 44);
  const c = document.createElement("canvas");
  const g = c.getContext("2d")!;
  const font = `${o.weight ?? 500} ${px}px ${o.font ?? MONO}`;
  g.font = font;
  const w = Math.ceil(g.measureText(text).width) + 24;
  c.width = w; c.height = Math.ceil(px * 1.5);
  g.font = font;
  g.fillStyle = o.color;
  g.textBaseline = "middle";
  g.fillText(text, 12, c.height / 2);
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.minFilter = LinearFilter;
  return { tex: t, aspect: c.width / c.height };
}

function pillTexture(label: string, dot: string, dark: boolean, solid?: string) {
  const px = 40, padX = 34, dotR = 11;
  const c = document.createElement("canvas");
  const g = c.getContext("2d")!;
  const font = `600 ${px}px ${SANS}`;
  g.font = font;
  const tw = g.measureText(label).width;
  const h = 96, w = Math.ceil(padX + dotR * 2 + 18 + tw + padX);
  c.width = w + 8; c.height = h + 8;
  g.translate(4, 4);
  g.fillStyle = solid ?? (dark ? "rgba(22,30,64,0.96)" : "rgba(255,255,255,0.97)");
  g.beginPath(); g.roundRect(0, 0, w, h, h / 2); g.fill();
  g.strokeStyle = dark ? "rgba(140,170,255,0.35)" : "rgba(20,40,90,0.12)";
  g.lineWidth = 2; g.stroke();
  g.fillStyle = solid ? "#ffffff" : dot;
  g.beginPath(); g.arc(padX + dotR, h / 2, dotR, 0, Math.PI * 2); g.fill();
  g.font = font; g.fillStyle = solid ? "#ffffff" : dark ? "#e8eeff" : "#0d1530"; g.textBaseline = "middle";
  g.fillText(label, padX + dotR * 2 + 18, h / 2 + 2);
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  return { tex: t, aspect: c.width / c.height };
}

/** The studio backdrop: a cool gradient with soft vertical light strips (the frosted pillars). */
function backdropTexture(dark: boolean) {
  const c = document.createElement("canvas");
  c.width = 1024; c.height = 640;
  const g = c.getContext("2d")!;
  const bg = g.createLinearGradient(0, 0, 0, c.height);
  if (dark) { bg.addColorStop(0, "#0b1230"); bg.addColorStop(1, "#060a1c"); }
  else { bg.addColorStop(0, "#f4f7fb"); bg.addColorStop(1, "#e3e9f2"); }
  g.fillStyle = bg; g.fillRect(0, 0, c.width, c.height);
  for (let i = 0; i < 9; i++) {
    const x = 90 + i * 105, w = 34;
    const s = g.createLinearGradient(x, 0, x + w, 0);
    const a = dark ? 0.07 : 0.55;
    s.addColorStop(0, `rgba(255,255,255,0)`);
    s.addColorStop(0.5, dark ? `rgba(120,150,255,${a})` : `rgba(255,255,255,${a})`);
    s.addColorStop(1, `rgba(255,255,255,0)`);
    g.fillStyle = s; g.fillRect(x, 0, w, c.height * 0.8);
  }
  const glow = g.createRadialGradient(c.width * 0.6, c.height * 0.45, 10, c.width * 0.6, c.height * 0.45, 420);
  glow.addColorStop(0, dark ? "rgba(60,90,255,0.35)" : "rgba(120,150,255,0.18)");
  glow.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = glow; g.fillRect(0, 0, c.width, c.height);
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  return t;
}

type Item = { mesh: Mesh; mat: MeshBasicMaterial; pos: Vector3; target: Vector3; scale: number; tScale: number; opacity: number; tOpacity: number; h: number };

export function createGlass(canvas: HTMLCanvasElement): Glass | null {
  let renderer: WebGLRenderer;
  try {
    renderer = new WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: "high-performance" });
  } catch { return null; }
  if (!renderer.capabilities.isWebGL2) { renderer.dispose(); return null; }
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.outputColorSpace = SRGBColorSpace;

  const scene = new Scene();
  const pmrem = new PMREMGenerator(renderer);
  const envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environment = envTex;
  const camera = new PerspectiveCamera(30, 1, 0.1, 100);
  camera.position.set(0, 0, 10);

  // backdrop plane: opaque, so the glass has something to refract
  const backMat = new MeshBasicMaterial({ map: backdropTexture(isDark()), toneMapped: false });
  const back = new Mesh(new PlaneGeometry(26, 16), backMat);
  back.position.z = -4;
  scene.add(back);

  // the seal: a thick lens with layered rims behind it
  const R = 1.55, T = 0.62;
  const prof: Vector2[] = [];
  for (let i = 0; i <= 48; i++) {
    const a = (i / 48) * Math.PI;
    const s = Math.sin(a);
    prof.push(new Vector2(R * Math.pow(s, 0.35), (T / 2) * -Math.cos(a)));
  }
  const lens = new LatheGeometry(prof, 96);
  lens.rotateX(Math.PI / 2);
  const glassMat = new MeshPhysicalMaterial({
    color: new Color("#eef4ff"), metalness: 0, roughness: 0.32, transmission: 1, thickness: 0.9, ior: 1.5,
    clearcoat: 1, clearcoatRoughness: 0.05, specularIntensity: 1, envMapIntensity: 1.5,
    emissive: new Color("#4a86ff"), emissiveIntensity: 0,
  });
  const seal = new Group();
  const disc = new Mesh(lens, glassMat);
  seal.add(disc);
  const rimMat = new MeshPhysicalMaterial({
    color: new Color("#b9ccff"), roughness: 0.12, transmission: 0.85, thickness: 0.4, ior: 1.45, clearcoat: 1, envMapIntensity: 1.8,
    attenuationColor: new Color("#5a80ff"), attenuationDistance: 0.6, transparent: true, opacity: 0.95,
  });
  const rims: Mesh[] = [];
  for (let i = 0; i < 3; i++) {
    const rim = new Mesh(new TorusGeometry(R * (0.99 + i * 0.025), 0.1 - i * 0.022, 32, 200), rimMat);
    rim.scale.z = 0.7;
    rim.position.set(-0.11 * (i + 1), 0.085 * (i + 1), -0.12 * (i + 1));
    seal.add(rim);
    rims.push(rim);
  }
  // the blue inside: an opaque gradient the glass refracts and blurs
  const coreTex = (() => {
    const c = document.createElement("canvas"); c.width = c.height = 512;
    const g = c.getContext("2d")!;
    g.fillStyle = "#1b2fd0"; g.fillRect(0, 0, 512, 512);
    const a = g.createRadialGradient(200, 190, 10, 256, 256, 300);
    a.addColorStop(0, "#9cc0ff"); a.addColorStop(0.28, "#4f86ff"); a.addColorStop(0.62, "#2557ff"); a.addColorStop(1, "#1a2ec8");
    g.fillStyle = a; g.fillRect(0, 0, 512, 512);
    const v = g.createRadialGradient(370, 380, 10, 370, 380, 190);
    v.addColorStop(0, "rgba(120,60,255,0.75)"); v.addColorStop(1, "rgba(120,60,255,0)");
    g.fillStyle = v; g.fillRect(0, 0, 512, 512);
    const t = new CanvasTexture(c); t.colorSpace = SRGBColorSpace; return t;
  })();
  const core = new Mesh(new CircleGeometry(R * 0.96, 96), new MeshBasicMaterial({ map: coreTex, toneMapped: false }));
  core.position.z = -0.06;
  seal.add(core);
  // soft glow bleeding past the edge, like a studio render
  const haloTex = (() => {
    const c = document.createElement("canvas"); c.width = c.height = 256;
    const g = c.getContext("2d")!;
    const a = g.createRadialGradient(150, 150, 30, 128, 128, 128);
    a.addColorStop(0, "rgba(47,91,255,0.55)"); a.addColorStop(0.6, "rgba(60,90,255,0.18)"); a.addColorStop(1, "rgba(60,90,255,0)");
    g.fillStyle = a; g.fillRect(0, 0, 256, 256);
    const t = new CanvasTexture(c); t.colorSpace = SRGBColorSpace; return t;
  })();
  const halo = new Mesh(new PlaneGeometry(R * 3.1, R * 3.1), new MeshBasicMaterial({ map: haloTex, transparent: true, depthWrite: false, toneMapped: false }));
  halo.position.set(0.25, -0.2, -0.5);
  seal.add(halo);
  seal.rotation.set(0.12, -0.5, 0.05);
  scene.add(seal);

  // ripple rings
  const ripples: { mesh: Mesh; mat: MeshBasicMaterial; t0: number; hard: boolean }[] = [];
  const ripple = (color: string, hard: boolean) => {
    const mat = new MeshBasicMaterial({ color: new Color(color), transparent: true, opacity: 0.9, side: DoubleSide, toneMapped: false, depthWrite: false });
    const mesh = new Mesh(new RingGeometry(R * 0.99, R * 1.012, 160), mat);
    mesh.position.z = T / 2 + 0.02;
    seal.add(mesh);
    ripples.push({ mesh, mat, t0: performance.now(), hard });
  };

  // movable text planes
  const items: Item[] = [];
  const plane = new PlaneGeometry(1, 1);
  const make = (tex: Texture, aspect: number, h: number, opaque: boolean, parent: Group | Scene = scene): Item => {
    const mat = new MeshBasicMaterial({ map: tex, toneMapped: false, transparent: !opaque, alphaTest: opaque ? 0.35 : 0, depthWrite: opaque });
    const mesh = new Mesh(plane, mat);
    mesh.scale.set(h * aspect, h, 1);
    parent.add(mesh);
    const it: Item = { mesh, mat, pos: new Vector3(), target: new Vector3(), scale: 1, tScale: 1, opacity: 0, tOpacity: 1, h };
    items.push(it);
    return it;
  };
  const drop = (it: Item) => { it.tOpacity = 0; (it as any).dead = true; };

  let layout = { discX: 1.15, discY: 0.1, linesX: -2.6, linesY: 0.3, narrow: false };
  const place = () => {
    const narrow = camera.aspect < 1.05;
    layout = narrow ? { discX: 0, discY: 0.75, linesX: 0, linesY: 3.05, narrow } : { discX: 1.35, discY: 0.15, linesX: -2.1, linesY: 0.75, narrow };
    seal.position.set(layout.discX, layout.discY, 0);
    camera.position.z = narrow ? 13.5 : 10;
    camera.updateProjectionMatrix();
  };

  const resize = () => {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    place();
  };
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  resize();

  let lines: Item[] = [];
  let names: Item[] = [];
  let tokens: Item[] = [];
  /** a slot inside the glass, in the seal's own space */
  const inside = (i: number, n: number) => new Vector3(-0.78, 0.3 - i * 0.3 * (3 / Math.max(3, n)), 0.06);
  const lineH = () => (layout.narrow ? 0.16 : 0.2);

  const inkColor = () => (isDark() ? "#e6ecff" : "#0d1530");

  const api: Glass = {
    plain(text) {
      lines.forEach(drop); names.forEach(drop); tokens.forEach(drop);
      names = []; tokens = [];
      lines = text.map((l, i) => {
        const { tex, aspect } = textTexture(l, { color: inkColor() });
        const it = make(tex, aspect, lineH(), false);
        const x = layout.narrow ? layout.linesX - (lineH() * aspect) / 2 : layout.linesX - 1.3;
        const gap = layout.narrow ? 0.3 : 0.4;
        it.pos.set(x - 0.6, layout.linesY - i * gap, 0.6);
        it.target.set(x, layout.linesY - i * gap, 0.6);
        it.mesh.position.copy(it.pos);
        // anchor at the left edge
        it.mesh.geometry = plane;
        (it as any).left = true;
        return it;
      });
    },
    seal(cipher) {
      lines.forEach(drop);
      lines = cipher.map((l, i) => {
        const { tex, aspect } = textTexture(l, { color: "#f2f6ff", weight: 400 });
        const it = make(tex, aspect, 0.2, true, seal);
        const prev = lines[i];
        const world = prev ? prev.mesh.getWorldPosition(new Vector3()).add(new Vector3(-prev.mesh.scale.x / 2, 0, 0)) : new Vector3(layout.linesX, layout.linesY, 0.6);
        seal.updateMatrixWorld();
        const from = seal.worldToLocal(world.clone());
        it.pos.copy(from);
        it.mesh.position.copy(from);
        it.target.copy(inside(i, cipher.length));
        it.opacity = 1;
        (it as any).left = true;
        (it as any).clip = 1.9;
        return it;
      });
      ripple(isDark() ? "#7fa0ff" : "#3a62ff", false);
    },
    open(nm) {
      tokens.forEach(drop);
      const tk = pillTexture("Reader", "#2f6bff", isDark());
      const t = make(tk.tex, tk.aspect, 0.42, false);
      t.pos.set(layout.discX + 3.2, layout.discY - 1.2, 0.9);
      t.mesh.position.copy(t.pos);
      t.target.set(layout.discX + 1.25, layout.discY - 1.0, 0.9);
      tokens = [t];
      setTimeout(() => {
        glow = 1;
        ripple(isDark() ? "#8fe0ff" : "#2fb4ff", false);
        names = nm.map((n, i) => {
          const { tex, aspect } = textTexture(n, { color: inkColor(), font: MONO, weight: 500 });
          const it = make(tex, aspect, layout.narrow ? 0.2 : 0.24, false);
          seal.updateMatrixWorld();
          it.pos.copy(seal.localToWorld(inside(i, nm.length)));
          it.mesh.position.copy(it.pos);
          it.opacity = 0;
          const tx = layout.narrow ? -(0.2 * aspect) / 2 : layout.linesX - 1.3;
          it.target.set(tx, layout.linesY - i * (layout.narrow ? 0.3 : 0.42), 0.8);
          (it as any).left = true;
          (it as any).delay = performance.now() + i * 140;
          return it;
        });
      }, 700);
    },
    refuse() {
      names.forEach(drop); names = [];
      tokens.forEach(drop);
      const tk = pillTexture("Removed reader", "#ff5a4e", isDark());
      const t = make(tk.tex, tk.aspect, 0.42, false);
      t.pos.set(layout.discX + 3.4, layout.discY + 1.3, 0.9);
      t.mesh.position.copy(t.pos);
      t.target.set(layout.discX + 1.05, layout.discY + 0.9, 0.9);
      tokens = [t];
      setTimeout(() => {
        shake = 1;
        ripple("#ff5a4e", true);
        const hit = pillTexture("Refused: not a reader", "#ff5a4e", isDark(), "#f0483c");
        t.mat.map?.dispose(); t.mat.map = hit.tex; t.mat.needsUpdate = true;
        t.mesh.scale.set(t.h * hit.aspect, t.h, 1);
        t.target.set(layout.discX + (layout.narrow ? 0.2 : 1.05), layout.discY + (layout.narrow ? 2.05 : 1.75), 0.9);
      }, 620);
    },
    dispose() {
      cancelAnimationFrame(raf);
      ro.disconnect(); io.disconnect();
      window.removeEventListener("coffer-theme", onTheme);
      window.removeEventListener("pointermove", onMove);
      renderer.dispose(); pmrem.dispose(); envTex.dispose();
    },
  };

  const onTheme = () => {
    backMat.map?.dispose();
    backMat.map = backdropTexture(isDark());
    backMat.needsUpdate = true;
  };
  window.addEventListener("coffer-theme", onTheme);
  let mx = 0, my = 0;
  const onMove = (e: PointerEvent) => { mx = e.clientX / innerWidth - 0.5; my = e.clientY / innerHeight - 0.5; };
  window.addEventListener("pointermove", onMove);
  let visible = true;
  const io = new IntersectionObserver(([e]) => { visible = !!e?.isIntersecting; });
  io.observe(canvas);

  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let glow = 0, shake = 0, raf = 0, last = performance.now();
  const frame = (now: number) => {
    raf = requestAnimationFrame(frame);
    if (!visible) return;
    const dt = Math.min(0.25, (now - last) / 1000);
    last = now;
    const k = reduce ? 1 : 1 - Math.pow(0.0025, dt);
    const time = now / 1000;
    if (!reduce) {
      seal.rotation.y = -0.5 + Math.sin(time * 0.35) * 0.12 + mx * 0.15;
      seal.rotation.x = 0.12 + Math.sin(time * 0.27) * 0.05 + my * 0.1;
    }
    const sx = shake > 0 ? Math.sin(time * 70) * 0.08 * shake : 0;
    seal.position.x = layout.discX + sx;
    shake = Math.max(0, shake - dt * 2.2);
    glow = Math.max(0, glow - dt * 0.6);
    glassMat.emissiveIntensity = glow * 0.9;
    rims.forEach((r, i) => { r.rotation.z = time * 0.05 * (i + 1); });

    for (let n = ripples.length - 1; n >= 0; n--) {
      const r = ripples[n]!;
      const t = (now - r.t0) / 1000;
      const s = 1 + t * (r.hard ? 0.55 : 0.4);
      r.mesh.scale.set(s, s, 1);
      r.mat.opacity = Math.max(0, (r.hard ? 1 : 0.7) * (1 - t / 1.3));
      if (t > 1.3) { seal.remove(r.mesh); r.mesh.geometry.dispose(); r.mat.dispose(); ripples.splice(n, 1); }
    }
    for (let n = items.length - 1; n >= 0; n--) {
      const it = items[n]!;
      const d = (it as any).delay as number | undefined;
      if (d && now < d) continue;
      it.pos.lerp(it.target, reduce ? 1 : k * 0.9);
      it.opacity += (it.tOpacity - it.opacity) * (reduce ? 1 : k);
      const w = it.mesh.scale.x;
      it.mesh.position.copy(it.pos);
      if ((it as any).left) it.mesh.position.x += w / 2;
      it.mat.opacity = it.opacity;
      if (!it.mat.transparent) it.mesh.visible = it.opacity > 0.3;
      if ((it as any).dead && it.opacity < 0.02) {
        it.mesh.parent?.remove(it.mesh); it.mat.map?.dispose(); it.mat.dispose(); items.splice(n, 1);
      }
    }
    renderer.render(scene, camera);
  };
  raf = requestAnimationFrame(frame);
  return api;
}
