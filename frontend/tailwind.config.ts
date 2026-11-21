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
        serif: ["var(--font-instrument-serif)", "Georgia", "serif"],
        mono: ["var(--font-jetbrains-mono)", "monospace"],
      },
      colors: {
        silk: {
          50: "#FFFFFF",
          100: "#F7F7F5",
          200: "#F1F1EE",
          300: "#E4E4E7",
        },
        obsidian: {
          950: "#09090B",
          900: "#0B0B0D",
          850: "#141418",
          800: "#1C1C21",
        },
        bull: "#059669",
        bullBright: "#10B981",
        bear: "#E11D48",
        caution: "#D97706",
      },
      boxShadow: {
        "velvet-dark":
          "inset 0 1px 0 0 rgba(255, 255, 255, 0.08), 0 20px 44px -22px rgba(0, 0, 0, 0.55)",
        "velvet-light":
          "inset 0 1px 0 0 rgba(255, 255, 255, 0.9), 0 14px 32px -20px rgba(0, 0, 0, 0.14)",
      },
    },
  },
  plugins: [],
};

export default config;
