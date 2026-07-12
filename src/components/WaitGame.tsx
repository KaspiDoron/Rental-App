"use client";

// A tiny, dependency-free retro runner to play while the agents wait on shops -
// like Chrome's offline dinosaur, but on-brand: hop a scooter over potholes and
// grab coins (your "savings"). Pure <canvas> + requestAnimationFrame, touch +
// keyboard, high score in localStorage, and it respects reduced-motion.

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

type Phase = "ready" | "running" | "over";

export function WaitGame({ onClose }: { onClose: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [phase, setPhase] = useState<Phase>("ready");
  const [score, setScore] = useState(0);
  const [high, setHigh] = useState(0);
  // Mutable game state kept in a ref so the rAF loop never restarts on render.
  const state = useRef({
    phase: "ready" as Phase,
    y: 0,
    vy: 0,
    t: 0,
    speed: 4,
    score: 0,
    obstacles: [] as { x: number; w: number; h: number }[],
    coins: [] as { x: number; y: number; got: boolean }[],
    spawn: 0,
    coinSpawn: 0,
  });

  useEffect(() => {
    try {
      setHigh(Number(localStorage.getItem("wd_game_high") || 0));
    } catch {
      /* ignore */
    }
  }, []);

  function jump() {
    const s = state.current;
    if (s.phase === "ready") {
      start();
      return;
    }
    if (s.phase === "over") {
      reset();
      start();
      return;
    }
    if (s.y === 0) s.vy = -11; // grounded -> hop
  }

  function start() {
    state.current.phase = "running";
    setPhase("running");
  }
  function reset() {
    const s = state.current;
    s.y = 0;
    s.vy = 0;
    s.t = 0;
    s.speed = 4;
    s.score = 0;
    s.obstacles = [];
    s.coins = [];
    s.spawn = 0;
    s.coinSpawn = 0;
    setScore(0);
  }

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const g2d = canvas.getContext("2d");
    if (!g2d) return;
    const g: CanvasRenderingContext2D = g2d;

    const cssW = Math.min(window.innerWidth - 32, 460);
    const cssH = 260;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = cssW * dpr;
    canvas.height = cssH * dpr;
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
    g.scale(dpr, dpr);

    const groundY = cssH - 42;
    const scooterX = 46;
    let raf = 0;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    function loop() {
      const s = state.current;
      g.clearRect(0, 0, cssW, cssH);

      // Sky + ground
      g.fillStyle = "#eef1f6";
      g.fillRect(0, 0, cssW, cssH);
      g.strokeStyle = "#c9d2df";
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(0, groundY + 20);
      g.lineTo(cssW, groundY + 20);
      g.stroke();

      if (s.phase === "running") {
        s.t += 1;
        s.speed = 4 + s.t / 900;

        // Physics
        s.vy += 0.6; // gravity
        s.y += s.vy;
        if (s.y > 0) {
          s.y = 0;
          s.vy = 0;
        }

        // Spawn obstacles + coins on a jittered cadence
        s.spawn -= 1;
        if (s.spawn <= 0) {
          s.obstacles.push({ x: cssW + 10, w: 16 + Math.random() * 14, h: 20 + Math.random() * 16 });
          s.spawn = 70 + Math.random() * 60;
        }
        s.coinSpawn -= 1;
        if (s.coinSpawn <= 0) {
          s.coins.push({ x: cssW + 10, y: groundY - 60 - Math.random() * 40, got: false });
          s.coinSpawn = 90 + Math.random() * 80;
        }

        for (const o of s.obstacles) o.x -= s.speed;
        for (const c of s.coins) c.x -= s.speed;
        s.obstacles = s.obstacles.filter((o) => o.x + o.w > -20);
        s.coins = s.coins.filter((c) => c.x > -20 && !c.got);

        // Collisions
        const scoot = { x: scooterX, y: groundY + s.y, w: 30, h: 22 };
        for (const o of s.obstacles) {
          if (
            scoot.x + scoot.w - 6 > o.x &&
            scoot.x + 6 < o.x + o.w &&
            scoot.y + scoot.h > groundY + 20 - o.h
          ) {
            s.phase = "over";
            setPhase("over");
            s.score = Math.floor(s.score);
            try {
              const hi = Number(localStorage.getItem("wd_game_high") || 0);
              if (s.score > hi) {
                localStorage.setItem("wd_game_high", String(s.score));
                setHigh(s.score);
              }
            } catch {
              /* ignore */
            }
          }
        }
        for (const c of s.coins) {
          if (!c.got && Math.abs(c.x - (scoot.x + 15)) < 20 && Math.abs(c.y - (scoot.y + 11)) < 22) {
            c.got = true;
            s.score += 10;
          }
        }
        s.score += 0.05;
        setScore(Math.floor(s.score));
      }

      // Draw coins
      g.font = "20px system-ui";
      for (const c of s.coins) if (!c.got) g.fillText("💰", c.x, c.y);

      // Draw obstacles (potholes / cones)
      g.fillStyle = "#ef4444";
      for (const o of s.obstacles) {
        g.fillRect(o.x, groundY + 20 - o.h, o.w, o.h);
      }

      // Draw scooter
      g.font = "30px system-ui";
      g.fillText("🛵", scooterX, groundY + 28 + state.current.y);

      // HUD
      g.fillStyle = "#212837";
      g.font = "bold 14px system-ui";
      g.fillText(`Score ${Math.floor(s.score)}`, 10, 22);

      if (!reduce) raf = requestAnimationFrame(loop);
      else raf = window.setTimeout(loop, 33) as unknown as number;
    }
    loop();
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(raf);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keyboard + lock background scroll while the game is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "Space" || e.code === "ArrowUp") {
        e.preventDefault();
        jump();
      }
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (typeof document === "undefined") return null;
  return createPortal(
    <div className="fixed inset-0 z-[1300] flex flex-col items-center justify-center bg-black/70 p-4 pb-safe pt-safe">
      <div className="surface-strong w-full max-w-[480px] rounded-blob p-4">
        <div className="mb-2 flex items-center justify-between">
          <div className="text-[15px] font-extrabold text-strong">🛵 Scooter Dash</div>
          <button onClick={onClose} className="btn btn-sm btn-ghost rounded-xl px-3" aria-label="Close game">
            ✕
          </button>
        </div>
        <div
          className="relative select-none overflow-hidden rounded-2xl"
          onPointerDown={(e) => {
            e.preventDefault();
            jump();
          }}
        >
          <canvas ref={canvasRef} className="block w-full touch-none" />
          {phase !== "running" && (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-white/60 text-center dark:bg-black/40">
              <div className="text-[15px] font-extrabold text-strong">
                {phase === "over" ? `Crash! Score ${score}` : "Tap or press Space to hop"}
              </div>
              <div className="mt-1 text-[12px] font-bold text-soft">
                {phase === "over" ? "Tap to play again" : "Dodge the red obstacles, grab the 💰"}
              </div>
            </div>
          )}
        </div>
        <div className="mt-2 flex items-center justify-between text-[12px] font-bold text-soft">
          <span>Best: {high}</span>
          <span className="text-faint">We&apos;ll ping you the moment a shop replies.</span>
        </div>
      </div>
    </div>,
    document.body
  );
}
