"use client";
import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { canRunFilm, CHAPTER_IDS, film, gOf, measureFilm, type ChapterId } from "../store";

const Stage = dynamic(() => import("../gl/Stage"), { ssr: false });
const Annotations = dynamic(() => import("./Annotations").then(m => m.Annotations), { ssr: false });

function readTheme() {
  const css = getComputedStyle(document.documentElement);
  film.bg = css.getPropertyValue("--bg").trim() || "#f5f5f7";
  const stored = document.documentElement.dataset.theme;
  film.nightTarget = stored === "dark" || (stored !== "light" && matchMedia("(prefers-color-scheme: dark)").matches) ? 1 : 0;
  document.documentElement.classList.toggle("film-night", film.nightTarget === 1);
}

/** Mounts the 3D stage on the plain page, once it's known this browser can run it, and wires input to the film's store. */
export function FilmClient() {
  const [on, setOn] = useState(false);

  useEffect(() => {
    const html = document.documentElement;
    if (!canRunFilm()) { html.classList.remove("film-mode"); return; }
    // Coming here by a client-side link, the script in the page never ran.
    html.classList.add("film-mode");
    const qa = new URLSearchParams(location.search).has("qa");
    readTheme();
    measureFilm();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Only known in the browser, after hydration.
    setOn(true);

    const onLost = () => setOn(false);
    const onMove = (e: PointerEvent) => {
      const p = film.pointer;
      p.x = (e.clientX / window.innerWidth) * 2 - 1; p.y = (e.clientY / window.innerHeight) * 2 - 1;
      p.px = e.clientX; p.py = e.clientY; p.seen = true;
    };
    let w = window.innerWidth, h = window.innerHeight;
    const onResize = () => {
      // A phone's address bar resizes the window all the time. Only a real change re-measures, and stays at the same moment.
      if (window.innerWidth === w && Math.abs(window.innerHeight - h) < 120) return;
      w = window.innerWidth; h = window.innerHeight;
      const here = placeAt(film.rawY);
      measureFilm();
      if (here) { const y = gOf(here.id, here.t); window.scrollTo(0, y); film.rawY = y; film.y = y; }
    };
    const theme = new MutationObserver(readTheme);
    theme.observe(html, { attributes: true, attributeFilter: ["data-theme"] });
    const mq = matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", readTheme);
    const ro = new ResizeObserver(() => measureFilm());
    ro.observe(document.body);

    // Copy: a beat is on while the middle of the screen is inside it. Off only means transparent, so screen readers and find-in-page
    // still have everything, and a control reached with Tab brings its moment on screen.
    const beats = [...document.querySelectorAll<HTMLElement>(".beat")].map(el => ({
      el, a: Number(el.style.getPropertyValue("--a")), b: Number(el.style.getPropertyValue("--b")), id: el.closest<HTMLElement>("[data-chapter]")!.dataset.chapter as ChapterId, on: el.classList.contains("live"), first: el.classList.contains("first"),
    }));
    const onFocus = (e: FocusEvent) => {
      const beat = (e.target as HTMLElement).closest?.(".beat") as HTMLElement | null;
      if (beat && !beat.classList.contains("live")) window.scrollTo({ top: beat.getBoundingClientRect().top + window.scrollY + 4 });
    };
    document.addEventListener("focusin", onFocus);

    // The progress line, and which chapter is on, without any React renders.
    const progress = document.getElementById("film-progress");
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      for (const b of beats) {
        const r = film.ranges[b.id];
        if (!r) continue;
        const y = window.scrollY, on = (b.first || y >= r.top + r.h * b.a - 2) && y < r.top + r.h * b.b;
        if (on !== b.on) { b.on = on; b.el.classList.toggle("live", on); }
      }
      const last = film.ranges.calm;
      if (!last || !progress) return;
      const total = last.top + last.h - film.vh;
      progress.style.transform = `scaleX(${Math.min(1, Math.max(0, window.scrollY / total))})`;
      progress.style.opacity = window.scrollY > total ? "0" : ".25";
    };
    raf = requestAnimationFrame(tick);

    window.addEventListener("film:lost", onLost);
    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("resize", onResize);
    document.fonts?.ready.then(measureFilm);

    let first = false;
    const onFirst = () => { first = true; html.classList.add("film-live"); };
    window.addEventListener("film:first-frame", onFirst, { once: true });
    // Never strand anyone behind the fade.
    const failsafe = window.setTimeout(() => html.classList.add("film-live"), 6000);

    if (qa) {
      Object.assign(window, { __film: {
        film,
        ready: () => film.ready && first,
        chapters: CHAPTER_IDS,
        seek(id: ChapterId, t: number) { const y = gOf(id, t); film.frozen = true; film.time = 12.5; window.scrollTo(0, y); film.rawY = y; film.y = y; return y; },
        freeze(v: boolean, time?: number) { film.frozen = v; if (time !== undefined) film.time = time; },
      } });
    }

    return () => {
      html.classList.remove("film-mode", "film-live", "film-night");
      ro.disconnect(); theme.disconnect();
      mq.removeEventListener("change", readTheme);
      document.removeEventListener("focusin", onFocus);
      window.removeEventListener("film:lost", onLost);
      window.removeEventListener("film:first-frame", onFirst);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("resize", onResize);
      clearTimeout(failsafe);
      cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <>
      <div id="film-canvas" aria-hidden="true">{on && <Stage />}</div>
      <div id="film-progress" aria-hidden="true" />
      <div id="film-vignette" aria-hidden="true" />
      {on && <Annotations />}
    </>
  );
}

function placeAt(y: number): { id: ChapterId; t: number } | null {
  for (const id of CHAPTER_IDS) {
    const r = film.ranges[id];
    if (r && y >= r.top && y < r.top + r.h) return { id, t: (y - r.top) / r.h };
  }
  return null;
}
