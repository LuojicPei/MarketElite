import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ["var(--font-inter)", "system-ui", "sans-serif"],
        mono: ["var(--font-jetbrains-mono)", "monospace"],
      },
      colors: {
        obsidian: {
          950: "#06080C",
          900: "#0B0F17",
          850: "#101622",
          800: "#151D2C",
        },
        bull: "#10B981",
        bear: "#EF4444",
        signal: "#38BDF8",
        caution: "#F59E0B",
      },
      boxShadow: {
        hairline: "inset 0 1px 0 0 rgba(255, 255, 255, 0.06)",
        glow: "0 0 40px -12px rgba(56, 189, 248, 0.22)",
      },
    },
  },
  plugins: [],
};

export default config;
