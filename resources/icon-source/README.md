# FigureWhispr icon source

- `icon.svg`: the full icon, used for 40px and up (also copied to `src/assets/logo.svg`).
- `icon-small.svg`: a simplified version, used for 32px and below.

To regenerate `src/assets/icon.ico` and the PNG sizes:

```bash
mkdir -p out && node_modules/electron/dist/electron.exe resources/icon-source/render.js "$PWD/out"
```

Then copy `out/icon.ico` and `out/icon-512.png` (as `icon.png`) into `src/assets/`.
