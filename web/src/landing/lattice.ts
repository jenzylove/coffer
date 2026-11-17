// A slowly turning module lattice (what ML-KEM is built on). Pulses run through
// it when a file is sealed, opened, or refused.
import {
  AdditiveBlending, NormalBlending, BufferAttribute, BufferGeometry, Color, Group, LineBasicMaterial, LineSegments,
  PerspectiveCamera, Points, PointsMaterial, Scene, Vector3, WebGLRenderer, CanvasTexture,
} from "three";

export type PulseKind = "seal" | "open" | "refuse";
export interface Lattice { pulse: (k: PulseKind) => void; setTint: (k: "plain" | "sealed") => void; dispose: () => void }

function cssColor(name: string, fallback: string) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return new Color(v || fallback);
}

function dotTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, "rgba(255,255,255,1)");
  grd.addColorStop(0.35, "rgba(255,255,255,0.9)");
  grd.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  return new CanvasTexture(c);
}

export function createLattice(canvas: HTMLCanvasElement): Lattice | null {
  let renderer: WebGLRenderer;
  try {
    renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "low-power" });
  } catch {
    return null;
  }
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  const scene = new Scene();
  const camera = new PerspectiveCamera(38, 1, 0.1, 100);
  camera.position.set(0, 0, 13);

  const b1 = new Vector3(1, 0, 0), b2 = new Vector3(0.38, 0.93, 0), b3 = new Vector3(0.22, 0.34, 0.92);
  const S = 1.05;
  const pts: Vector3[] = [];
  const idx = new Map<string, number>();
  const R = { i: 5, j: 4, k: 3 };
  for (let i = -R.i; i <= R.i; i++) for (let j = -R.j; j <= R.j; j++) for (let k = -R.k; k <= R.k; k++) {
    const p = new Vector3().addScaledVector(b1, i).addScaledVector(b2, j).addScaledVector(b3, k).multiplyScalar(S);
    idx.set(`${i},${j},${k}`, pts.length);
    pts.push(p);
  }
  // centre the cloud
  const centre = pts.reduce((a, p) => a.add(p), new Vector3()).multiplyScalar(1 / pts.length);
  pts.forEach((p) => p.sub(centre));
  const dist = pts.map((p) => p.length());
  const maxD = Math.max(...dist);

  const pos = new Float32Array(pts.length * 3);
  pts.forEach((p, n) => pos.set([p.x, p.y, p.z], n * 3));
  const col = new Float32Array(pts.length * 3);
  const pg = new BufferGeometry();
  pg.setAttribute("position", new BufferAttribute(pos, 3));
  pg.setAttribute("color", new BufferAttribute(col, 3));
  const pm = new PointsMaterial({ size: 0.2, vertexColors: true, map: dotTexture(), transparent: true, depthWrite: false, sizeAttenuation: true });
  const points = new Points(pg, pm);

  const seg: number[] = [];
  const segIdx: [number, number][] = [];
  for (const [key, a] of idx) {
    const [i, j, k] = key.split(",").map(Number) as [number, number, number];
    for (const [di, dj, dk] of [[1, 0, 0], [0, 1, 0], [0, 0, 1]]) {
      const b = idx.get(`${i + di!},${j + dj!},${k + dk!}`);
      if (b === undefined) continue;
      segIdx.push([a, b]);
      seg.push(...pos.slice(a * 3, a * 3 + 3), ...pos.slice(b * 3, b * 3 + 3));
    }
  }
  const lg = new BufferGeometry();
  lg.setAttribute("position", new BufferAttribute(new Float32Array(seg), 3));
  const lcol = new Float32Array(seg.length);
  lg.setAttribute("color", new BufferAttribute(lcol, 3));
  const lm = new LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.55 });
  const lines = new LineSegments(lg, lm);

  const group = new Group();
  group.add(lines, points);
  group.rotation.set(-0.35, 0.5, 0.08);
  scene.add(group);

  let colors = { base: new Color(), line: new Color(), seal: new Color(), open: new Color(), light: false };
  const readColors = () => {
    const light = document.documentElement.dataset.theme === "light";
    colors = {
      base: cssColor("--lattice", "#6b7480"),
      line: cssColor("--lattice-line", "#2a2f36"),
      seal: cssColor("--seal", "#ff4a1c"),
      open: cssColor("--open", "#5fd4e6"),
      light,
    };
    pm.blending = light ? NormalBlending : AdditiveBlending;
    pm.needsUpdate = true;
  };
  readColors();
  const onTheme = () => readColors();
  window.addEventListener("coffer-theme", onTheme);

  const pulses: { kind: PulseKind; t0: number }[] = [];
  let tint = 0, tintTarget = 0;
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;

  const resize = () => {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.position.z = w / h < 0.9 ? 16 : 13;
    camera.updateProjectionMatrix();
  };
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  resize();

  let mx = 0, my = 0;
  const onMove = (e: PointerEvent) => { mx = e.clientX / innerWidth - 0.5; my = e.clientY / innerHeight - 0.5; };
  window.addEventListener("pointermove", onMove);

  let visible = true;
  const io = new IntersectionObserver(([e]) => { visible = !!e?.isIntersecting; });
  io.observe(canvas);

  const tmp = new Color();
  const per = new Float32Array(pts.length * 3);
  let raf = 0, last = performance.now();
  const frame = (now: number) => {
    raf = requestAnimationFrame(frame);
    if (!visible) return;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (!reduce) {
      group.rotation.y += dt * 0.07;
      group.rotation.x += ((-0.35 + my * 0.25) - group.rotation.x) * 0.03;
      group.rotation.z += ((0.08 + mx * 0.12) - group.rotation.z) * 0.03;
    }
    tint += (tintTarget - tint) * Math.min(1, dt * 2.5);
    for (let n = pulses.length - 1; n >= 0; n--) if (now - pulses[n]!.t0 > 2600) pulses.splice(n, 1);

    for (let n = 0; n < pts.length; n++) {
      tmp.copy(colors.base).lerp(colors.seal, tint * 0.55);
      for (const p of pulses) {
        const t = (now - p.t0) / 1000;
        const front = p.kind === "seal" ? maxD * (1 - t / 1.4) : t * (maxD / 1.3);
        const w = Math.exp(-((dist[n]! - front) ** 2) / 1.4) * Math.max(0, 1 - t / 2.6);
        const target = p.kind === "open" ? colors.open : colors.seal;
        const flick = p.kind === "refuse" ? (Math.sin(t * 40) > 0 ? 1 : 0.2) : 1;
        tmp.lerp(target, Math.min(1, w * 1.3 * flick));
      }
      per.set([tmp.r, tmp.g, tmp.b], n * 3);
    }
    col.set(per);
    pg.attributes.color!.needsUpdate = true;
    const lc = lg.attributes.color!.array as Float32Array;
    for (let s = 0; s < segIdx.length; s++) {
      const [a, b] = segIdx[s]!;
      for (const [o, v] of [[0, a], [3, b]] as const) {
        tmp.setRGB(per[v * 3]!, per[v * 3 + 1]!, per[v * 3 + 2]!).lerp(colors.line, colors.light ? 0.45 : 0.62);
        lc[s * 6 + o] = tmp.r; lc[s * 6 + o + 1] = tmp.g; lc[s * 6 + o + 2] = tmp.b;
      }
    }
    lg.attributes.color!.needsUpdate = true;
    renderer.render(scene, camera);
  };
  raf = requestAnimationFrame(frame);

  return {
    pulse: (kind) => pulses.push({ kind, t0: performance.now() }),
    setTint: (k) => { tintTarget = k === "sealed" ? 1 : 0; },
    dispose: () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("coffer-theme", onTheme);
      pg.dispose(); lg.dispose(); pm.dispose(); lm.dispose();
      renderer.dispose();
    },
  };
}
