"use client";

import React, { createContext, useCallback, useContext, useEffect, useState } from "react";

export type VelvetTheme = "light" | "dark";

interface ThemeContextValue {
  theme: VelvetTheme;
  setTheme: (next: VelvetTheme) => void;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: "light",
  setTheme: () => undefined,
  toggleTheme: () => undefined,
});

const STORAGE_KEY = "marketelite_velvet_theme";

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<VelvetTheme>("light");

  const applyThemeDom = useCallback((next: VelvetTheme) => {
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    root.dataset.theme = next;
    root.classList.toggle("dark", next === "dark");
  }, []);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      if (saved === "dark" || saved === "light") {
        setThemeState(saved);
        applyThemeDom(saved);
      } else {
        applyThemeDom("light");
      }
    } catch {
      applyThemeDom("light");
    }
  }, [applyThemeDom]);

  const setTheme = useCallback(
    (next: VelvetTheme) => {
      setThemeState(next);
      applyThemeDom(next);
      try {
        window.localStorage.setItem(STORAGE_KEY, next);
      } catch {
        // Ignore storage errors silently
      }
    },
    [applyThemeDom]
  );

  const toggleTheme = useCallback(() => {
    setTheme(theme === "light" ? "dark" : "light");
  }, [theme, setTheme]);

  return (
    <ThemeContext.Provider value={{ theme, setTheme, toggleTheme }}>
      {/* Ambient Velvet Atmospheric Canvas behind translucent frosted panels */}
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 -z-10 overflow-hidden transition-opacity duration-700"
      >
        {theme === "dark" ? (
          <>
            <div
              className="velvet-orb-drift absolute -top-28 left-[12%] h-[420px] w-[520px] rounded-full opacity-80"
              style={{
                background:
                  "radial-gradient(circle, rgba(16, 185, 129, 0.08) 0%, rgba(56, 189, 248, 0.04) 45%, transparent 72%)",
                filter: "blur(64px)",
              }}
            />
            <div
              className="velvet-orb-drift-slow absolute top-[38%] -right-24 h-[460px] w-[460px] rounded-full opacity-75"
              style={{
                background:
                  "radial-gradient(circle, rgba(161, 161, 170, 0.09) 0%, rgba(225, 29, 72, 0.04) 48%, transparent 74%)",
                filter: "blur(72px)",
              }}
            />
            <div
              className="velvet-orb-drift absolute -bottom-24 left-[28%] h-[360px] w-[580px] rounded-full opacity-70"
              style={{
                background:
                  "radial-gradient(circle, rgba(255, 255, 255, 0.045) 0%, transparent 70%)",
                filter: "blur(68px)",
              }}
            />
          </>
        ) : (
          <>
            <div
              className="velvet-orb-drift absolute -top-24 left-[10%] h-[420px] w-[560px] rounded-full opacity-90"
              style={{
                background:
                  "radial-gradient(circle, rgba(255, 255, 255, 0.95) 0%, rgba(214, 214, 206, 0.45) 50%, transparent 74%)",
                filter: "blur(56px)",
              }}
            />
            <div
              className="velvet-orb-drift-slow absolute top-[35%] -right-16 h-[440px] w-[440px] rounded-full opacity-75"
              style={{
                background:
                  "radial-gradient(circle, rgba(180, 185, 194, 0.28) 0%, rgba(16, 185, 129, 0.05) 48%, transparent 74%)",
                filter: "blur(64px)",
              }}
            />
            <div
              className="velvet-orb-drift absolute -bottom-20 left-[22%] h-[360px] w-[540px] rounded-full opacity-70"
              style={{
                background:
                  "radial-gradient(circle, rgba(212, 212, 206, 0.42) 0%, transparent 72%)",
                filter: "blur(60px)",
              }}
            />
          </>
        )}
      </div>
      {children}
    </ThemeContext.Provider>
  );
}
