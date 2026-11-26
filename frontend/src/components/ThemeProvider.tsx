"use client";

import React, { createContext, useCallback, useContext, useEffect, useState } from "react";

export type VelvetTheme = "white" | "cream" | "dark";

interface ThemeContextValue {
  theme: VelvetTheme;
  setTheme: (next: VelvetTheme) => void;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: "white",
  setTheme: () => undefined,
  toggleTheme: () => undefined,
});

const STORAGE_KEY = "marketelite_velvet_theme";

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<VelvetTheme>("white");

  const applyThemeDom = useCallback((next: VelvetTheme) => {
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    root.dataset.theme = next;
    root.classList.toggle("dark", next === "dark");
  }, []);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      if (saved === "white" || saved === "cream" || saved === "dark") {
        setThemeState(saved);
        applyThemeDom(saved);
      } else if (saved === "light") {
        setThemeState("white");
        applyThemeDom("white");
      } else {
        applyThemeDom("white");
      }
    } catch {
      applyThemeDom("white");
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
    const order: VelvetTheme[] = ["white", "cream", "dark"];
    const next = order[(order.indexOf(theme) + 1) % order.length];
    setTheme(next);
  }, [theme, setTheme]);

  return (
    <ThemeContext.Provider value={{ theme, setTheme, toggleTheme }}>
      {/* Static Lightweight Ambient Radial Tint (zero per-frame blur rasterization) */}
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 -z-10 overflow-hidden"
        style={{
          background:
            theme === "dark"
              ? "radial-gradient(62% 48% at 22% 8%, rgba(16, 185, 129, 0.055) 0%, transparent 70%), radial-gradient(48% 46% at 88% 42%, rgba(56, 189, 248, 0.04) 0%, transparent 72%)"
              : "radial-gradient(64% 48% at 20% 8%, rgba(255, 255, 255, 0.72) 0%, rgba(214, 214, 206, 0.16) 58%, transparent 78%), radial-gradient(48% 46% at 86% 42%, rgba(16, 185, 129, 0.035) 0%, transparent 72%)",
        }}
      />
      {children}
    </ThemeContext.Provider>
  );
}
