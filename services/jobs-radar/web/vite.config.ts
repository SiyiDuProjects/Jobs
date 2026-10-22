import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
export default defineConfig({
  plugins: [
    tailwindcss(),
    {
      name: "shared-jobs-brand",
      async closeBundle() {
        const brand = JSON.parse(
          await readFile(
            new URL("../config/brand.json", import.meta.url),
            "utf8",
          ),
        );
        const file = new URL(
          "../jobs_radar/static/index.html",
          import.meta.url,
        );
        const html = await readFile(new URL("./index.html", import.meta.url), "utf8");
        const name = String(brand.name)
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;");
        const output = new URL("../jobs_radar/static/", import.meta.url);
        const assets = ["board.js", "board.css"];
        try {
          assets.push(...(await readdir(new URL("chunks/", output)))
            .map((name) => "chunks/" + name));
        } catch (error) {
          if ((error as { code?: string }).code !== "ENOENT") throw error;
        }
        const fingerprint = createHash("sha256");
        for (const asset of assets.sort()) {
          fingerprint.update(asset).update(await readFile(new URL(asset, output)));
        }
        const stamp = fingerprint.digest("hex").slice(0, 16);
        const rendered = html
          .replace(
            /(\/assets\/board\.(?:js|css))\?v=[^"']+/g,
            (_match, asset) => asset.replace("/assets/", "/assets/" + stamp + "/"),
          )
          .replace(
            /<title>[^<]*<\/title>/,
            `<title>${name} · 我的岗位</title>`,
          );
        await writeFile(file, rendered);
        const management = new URL(
          "../jobs_radar/static/manage/",
          import.meta.url,
        );
        await mkdir(management, { recursive: true });
        await writeFile(new URL("index.html", management), rendered);
      },
    },
  ],
  define: { "process.env.NODE_ENV": '"production"' },
  build: {
    minify: true,
    outDir: "../jobs_radar/static",
    emptyOutDir: true,
    lib: {
      entry: "src/main.tsx",
      formats: ["es"],
      fileName: () => "board.js",
      cssFileName: "board",
    },
    rolldownOptions: {
      onwarn(warning, warn) {
        if (warning.code !== "MODULE_LEVEL_DIRECTIVE") warn(warning);
      },
      output: { chunkFileNames: "chunks/[name]-[hash].js", minify: true },
    },
  },
});
