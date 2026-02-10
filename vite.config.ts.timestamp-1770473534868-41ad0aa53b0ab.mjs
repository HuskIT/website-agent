// vite.config.ts
import { cloudflareDevProxyVitePlugin as remixCloudflareDevProxy, vitePlugin as remixVitePlugin } from "file:///Users/linhng/Documents/HyperPage-MVP/website-agent/node_modules/.pnpm/@remix-run+dev@2.16.8_@remix-run+react@2.16.8_react-dom@18.3.1_react@18.3.1__react@18.3.1_typ_hragbulxy4y2kpe7s4vsnpfanq/node_modules/@remix-run/dev/dist/index.js";
import UnoCSS from "file:///Users/linhng/Documents/HyperPage-MVP/website-agent/node_modules/.pnpm/unocss@0.61.9_postcss@8.5.6_rollup@4.45.1_vite@5.4.19_@types+node@24.10.1_sass-embedded@1.89.2_/node_modules/unocss/dist/vite.mjs";
import { defineConfig } from "file:///Users/linhng/Documents/HyperPage-MVP/website-agent/node_modules/.pnpm/vite@5.4.19_@types+node@24.10.1_sass-embedded@1.89.2/node_modules/vite/dist/node/index.js";
import { nodePolyfills } from "file:///Users/linhng/Documents/HyperPage-MVP/website-agent/node_modules/.pnpm/vite-plugin-node-polyfills@0.22.0_rollup@4.45.1_vite@5.4.19_@types+node@24.10.1_sass-embedded@1.89.2_/node_modules/vite-plugin-node-polyfills/dist/index.js";
import { optimizeCssModules } from "file:///Users/linhng/Documents/HyperPage-MVP/website-agent/node_modules/.pnpm/vite-plugin-optimize-css-modules@1.2.0_vite@5.4.19_@types+node@24.10.1_sass-embedded@1.89.2_/node_modules/vite-plugin-optimize-css-modules/dist/index.mjs";
import tsconfigPaths from "file:///Users/linhng/Documents/HyperPage-MVP/website-agent/node_modules/.pnpm/vite-tsconfig-paths@4.3.2_typescript@5.8.3_vite@5.4.19_@types+node@24.10.1_sass-embedded@1.89.2_/node_modules/vite-tsconfig-paths/dist/index.mjs";
import * as dotenv from "file:///Users/linhng/Documents/HyperPage-MVP/website-agent/node_modules/.pnpm/dotenv@16.6.1/node_modules/dotenv/lib/main.js";
dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env" });
dotenv.config();
var vite_config_default = defineConfig((config2) => {
  return {
    define: {
      "process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV)
    },
    resolve: {
      alias: {
        // Note: path alias moved to plugin for SSR-aware handling
        "@smithy/core/dist-es/getSmithyContext": "/test/stubs/smithy-get.ts",
        "@smithy/core/dist-es": "/test/stubs/smithy-index.ts"
      },
      // Prevent esbuild from trying to resolve node: protocol imports
      conditions: ["import", "module", "browser", "default"]
    },
    server: {
      port: 5171,
      strictPort: false
      // Allow fallback to next available port if 5171 is busy
    },
    build: {
      target: "esnext",
      commonjsOptions: {
        transformMixedEsModules: true
      }
    },
    optimizeDeps: {
      // Exclude server-only packages that use Node.js built-ins
      exclude: [
        "undici",
        "postgres",
        "postgres-js",
        "@aws-sdk/util-user-agent-node",
        "@aws-sdk/client-bedrock-runtime",
        "@aws-sdk/client-s3",
        "@aws-sdk/s3-request-presigner",
        "@aws-sdk/lib-storage",
        "chalk"
        // Server-only library that uses node:tty
      ],
      esbuildOptions: {
        // Mark node: protocol imports and AWS SDK packages as external
        external: [
          "node:util/types",
          "@aws-sdk/*"
        ],
        // Prevent Cloudflare-specific code from being bundled
        platform: "node"
      }
    },
    plugins: [
      nodePolyfills({
        include: ["buffer", "process", "util", "stream"],
        globals: {
          Buffer: true,
          process: true,
          global: true
        },
        protocolImports: true,
        exclude: ["child_process", "fs", "path"]
      }),
      {
        name: "path-browserify-client-only",
        enforce: "pre",
        resolveId(id, importer, options) {
          if (id === "path") {
            const isSsr = options?.ssr === true;
            const isServerFile = importer?.includes(".server");
            if (isSsr || isServerFile) {
              return { id: "path", external: true };
            }
            return "path-browserify";
          }
          return null;
        }
      },
      {
        name: "fix-node-protocol-imports",
        enforce: "pre",
        resolveId(id) {
          if (id.startsWith("node:")) {
            return { id, external: true };
          }
          return null;
        }
      },
      {
        name: "prevent-cloudflare-protocol-imports",
        enforce: "pre",
        resolveId(id, importer) {
          if (id.startsWith("cloudflare:")) {
            return `\0virtual:cloudflare-stub`;
          }
          return null;
        },
        load(id) {
          if (id === "\0virtual:cloudflare-stub") {
            return "export default null; export const CloudflareEnvironment = undefined;";
          }
          return null;
        }
      },
      {
        name: "buffer-polyfill",
        transform(code, id) {
          if (id.includes("env.mjs")) {
            return {
              code: `import { Buffer } from 'buffer';
${code}`,
              map: null
            };
          }
          return null;
        }
      },
      {
        name: "fix-process-exports",
        enforce: "pre",
        resolveId(id, importer) {
          if (id === "process" && importer && importer.includes("node_modules")) {
            if (importer.includes("@aws-sdk") || importer.includes("aws-sdk")) {
              return "\0process-enhanced";
            }
          }
          return null;
        },
        load(id) {
          if (id === "\0process-enhanced") {
            return `
              // Enhanced process polyfill with named exports for AWS SDK compatibility
              const processEnv = typeof process !== 'undefined' && process.env 
                ? process.env 
                : {};
              const processVersions = typeof process !== 'undefined' && process.versions 
                ? process.versions 
                : { node: '18.0.0' };
              
              // Create process object with all properties
              const processObj = typeof process !== 'undefined' 
                ? Object.assign({}, process, { env: processEnv, versions: processVersions })
                : { env: processEnv, versions: processVersions };
              
              // Named exports that AWS SDK needs
              export const env = processEnv;
              export const versions = processVersions;
              
              // Default export
              export default processObj;
            `;
          }
          return null;
        }
      },
      {
        name: "exclude-chalk-from-client",
        enforce: "pre",
        resolveId(id, importer) {
          if (id === "chalk" && importer && !importer.includes(".server.") && !importer.includes("node_modules/chalk")) {
            if (importer.includes(".server.") || importer.includes("server")) {
              return null;
            }
            return "\0chalk-stub";
          }
          return null;
        },
        load(id) {
          if (id === "\0chalk-stub") {
            return `
              // Chalk stub for client-side - returns plain text
              export const Chalk = class {
                constructor() {}
                bgHex() { return this; }
                hex() { return this; }
              };
              export default {
                bgHex: () => (text) => text,
                hex: () => (text) => text,
              };
            `;
          }
          return null;
        }
      },
      config2.mode !== "test" && remixCloudflareDevProxy(),
      {
        name: "handle-well-known-requests",
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (req.url?.startsWith("/.well-known/")) {
              res.writeHead(404, { "Content-Type": "text/plain" });
              res.end("Not Found");
              return;
            }
            next();
          });
        }
      },
      remixVitePlugin({
        future: {
          v3_fetcherPersist: true,
          v3_relativeSplatPath: true,
          v3_throwAbortReason: true,
          v3_lazyRouteDiscovery: true
        }
      }),
      UnoCSS(),
      tsconfigPaths(),
      chrome129IssuePlugin(),
      config2.mode === "production" && optimizeCssModules({ apply: "build" })
    ],
    envPrefix: [
      "VITE_",
      "OPENAI_LIKE_API_BASE_URL",
      "OPENAI_LIKE_API_MODELS",
      "OLLAMA_API_BASE_URL",
      "LMSTUDIO_API_BASE_URL",
      "TOGETHER_API_BASE_URL"
    ],
    ssr: {
      // Don't apply browser polyfills in SSR - use native Node.js modules
      external: ["path", "fs", "fs/promises"]
    },
    css: {
      preprocessorOptions: {
        scss: {
          api: "modern-compiler"
        }
      }
    },
    test: {
      environment: "node",
      setupFiles: ["./vitest.setup.ts"],
      alias: {
        "@web3-storage/multipart-parser/esm/src/index.js": "/test/stubs/multipart-parser.ts"
      },
      deps: {
        inline: [
          "ollama-ai-provider",
          "@ai-sdk/provider-utils",
          "style-to-object",
          "style-to-js",
          "@web3-storage/multipart-parser",
          "@web3-storage/multipart-parser/esm/src/index.js",
          "@smithy/core"
        ],
        interopDefault: true
      },
      exclude: [
        "**/node_modules/**",
        "**/dist/**",
        "**/cypress/**",
        "**/.{idea,git,cache,output,temp}/**",
        "**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build}.config.*",
        "**/tests/preview/**"
        // Exclude preview tests that require Playwright
      ]
    }
  };
});
function chrome129IssuePlugin() {
  return {
    name: "chrome129IssuePlugin",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const raw = req.headers["user-agent"]?.match(/Chrom(e|ium)\/([0-9]+)\./);
        if (raw) {
          const version = parseInt(raw[2], 10);
          if (version === 129) {
            res.setHeader("content-type", "text/html");
            res.end(
              '<body><h1>Please use Chrome Canary for testing.</h1><p>Chrome 129 has an issue with JavaScript modules & Vite local development, see <a href="https://github.com/stackblitz/bolt.new/issues/86#issuecomment-2395519258">for more information.</a></p><p><b>Note:</b> This only impacts <u>local development</u>. `pnpm run build` and `pnpm run start` will work fine in this browser.</p></body>'
            );
            return;
          }
        }
        next();
      });
    }
  };
}
export {
  vite_config_default as default
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsidml0ZS5jb25maWcudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImNvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9kaXJuYW1lID0gXCIvVXNlcnMvbGluaG5nL0RvY3VtZW50cy9IeXBlclBhZ2UtTVZQL3dlYnNpdGUtYWdlbnRcIjtjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfZmlsZW5hbWUgPSBcIi9Vc2Vycy9saW5obmcvRG9jdW1lbnRzL0h5cGVyUGFnZS1NVlAvd2Vic2l0ZS1hZ2VudC92aXRlLmNvbmZpZy50c1wiO2NvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9pbXBvcnRfbWV0YV91cmwgPSBcImZpbGU6Ly8vVXNlcnMvbGluaG5nL0RvY3VtZW50cy9IeXBlclBhZ2UtTVZQL3dlYnNpdGUtYWdlbnQvdml0ZS5jb25maWcudHNcIjtpbXBvcnQgeyBjbG91ZGZsYXJlRGV2UHJveHlWaXRlUGx1Z2luIGFzIHJlbWl4Q2xvdWRmbGFyZURldlByb3h5LCB2aXRlUGx1Z2luIGFzIHJlbWl4Vml0ZVBsdWdpbiB9IGZyb20gJ0ByZW1peC1ydW4vZGV2JztcbmltcG9ydCBVbm9DU1MgZnJvbSAndW5vY3NzL3ZpdGUnO1xuaW1wb3J0IHsgZGVmaW5lQ29uZmlnLCB0eXBlIFZpdGVEZXZTZXJ2ZXIgfSBmcm9tICd2aXRlJztcbmltcG9ydCB7IG5vZGVQb2x5ZmlsbHMgfSBmcm9tICd2aXRlLXBsdWdpbi1ub2RlLXBvbHlmaWxscyc7XG5pbXBvcnQgeyBvcHRpbWl6ZUNzc01vZHVsZXMgfSBmcm9tICd2aXRlLXBsdWdpbi1vcHRpbWl6ZS1jc3MtbW9kdWxlcyc7XG5pbXBvcnQgdHNjb25maWdQYXRocyBmcm9tICd2aXRlLXRzY29uZmlnLXBhdGhzJztcbmltcG9ydCAqIGFzIGRvdGVudiBmcm9tICdkb3RlbnYnO1xuXG4vLyBMb2FkIGVudmlyb25tZW50IHZhcmlhYmxlcyBmcm9tIG11bHRpcGxlIGZpbGVzXG4vLyBMb2FkIGVudmlyb25tZW50IHZhcmlhYmxlcyBmcm9tIG11bHRpcGxlIGZpbGVzXG5kb3RlbnYuY29uZmlnKHsgcGF0aDogJy5lbnYubG9jYWwnIH0pO1xuZG90ZW52LmNvbmZpZyh7IHBhdGg6ICcuZW52JyB9KTtcbmRvdGVudi5jb25maWcoKTtcblxuLy8gRk9SQ0UgQ0FDSEUgSU5WQUxJREFUSU9OOiB2M1xuZXhwb3J0IGRlZmF1bHQgZGVmaW5lQ29uZmlnKChjb25maWcpID0+IHtcbiAgcmV0dXJuIHtcbiAgICBkZWZpbmU6IHtcbiAgICAgICdwcm9jZXNzLmVudi5OT0RFX0VOVic6IEpTT04uc3RyaW5naWZ5KHByb2Nlc3MuZW52Lk5PREVfRU5WKSxcbiAgICB9LFxuICAgIHJlc29sdmU6IHtcbiAgICAgIGFsaWFzOiB7XG4gICAgICAgIC8vIE5vdGU6IHBhdGggYWxpYXMgbW92ZWQgdG8gcGx1Z2luIGZvciBTU1ItYXdhcmUgaGFuZGxpbmdcbiAgICAgICAgJ0BzbWl0aHkvY29yZS9kaXN0LWVzL2dldFNtaXRoeUNvbnRleHQnOiAnL3Rlc3Qvc3R1YnMvc21pdGh5LWdldC50cycsXG4gICAgICAgICdAc21pdGh5L2NvcmUvZGlzdC1lcyc6ICcvdGVzdC9zdHVicy9zbWl0aHktaW5kZXgudHMnLFxuICAgICAgfSxcbiAgICAgIC8vIFByZXZlbnQgZXNidWlsZCBmcm9tIHRyeWluZyB0byByZXNvbHZlIG5vZGU6IHByb3RvY29sIGltcG9ydHNcbiAgICAgIGNvbmRpdGlvbnM6IFsnaW1wb3J0JywgJ21vZHVsZScsICdicm93c2VyJywgJ2RlZmF1bHQnXSxcbiAgICB9LFxuICAgIHNlcnZlcjoge1xuICAgICAgcG9ydDogNTE3MSxcbiAgICAgIHN0cmljdFBvcnQ6IGZhbHNlLCAvLyBBbGxvdyBmYWxsYmFjayB0byBuZXh0IGF2YWlsYWJsZSBwb3J0IGlmIDUxNzEgaXMgYnVzeVxuICAgIH0sXG4gICAgYnVpbGQ6IHtcbiAgICAgIHRhcmdldDogJ2VzbmV4dCcsXG4gICAgICBjb21tb25qc09wdGlvbnM6IHtcbiAgICAgICAgdHJhbnNmb3JtTWl4ZWRFc01vZHVsZXM6IHRydWUsXG4gICAgICB9LFxuICAgIH0sXG4gICAgb3B0aW1pemVEZXBzOiB7XG4gICAgICAvLyBFeGNsdWRlIHNlcnZlci1vbmx5IHBhY2thZ2VzIHRoYXQgdXNlIE5vZGUuanMgYnVpbHQtaW5zXG4gICAgICBleGNsdWRlOiBbXG4gICAgICAgICd1bmRpY2knLFxuICAgICAgICAncG9zdGdyZXMnLFxuICAgICAgICAncG9zdGdyZXMtanMnLFxuICAgICAgICAnQGF3cy1zZGsvdXRpbC11c2VyLWFnZW50LW5vZGUnLFxuICAgICAgICAnQGF3cy1zZGsvY2xpZW50LWJlZHJvY2stcnVudGltZScsXG4gICAgICAgICdAYXdzLXNkay9jbGllbnQtczMnLFxuICAgICAgICAnQGF3cy1zZGsvczMtcmVxdWVzdC1wcmVzaWduZXInLFxuICAgICAgICAnQGF3cy1zZGsvbGliLXN0b3JhZ2UnLFxuICAgICAgICAnY2hhbGsnLCAvLyBTZXJ2ZXItb25seSBsaWJyYXJ5IHRoYXQgdXNlcyBub2RlOnR0eVxuICAgICAgXSxcbiAgICAgIGVzYnVpbGRPcHRpb25zOiB7XG4gICAgICAgIC8vIE1hcmsgbm9kZTogcHJvdG9jb2wgaW1wb3J0cyBhbmQgQVdTIFNESyBwYWNrYWdlcyBhcyBleHRlcm5hbFxuICAgICAgICBleHRlcm5hbDogW1xuICAgICAgICAgICdub2RlOnV0aWwvdHlwZXMnLFxuICAgICAgICAgICdAYXdzLXNkay8qJyxcbiAgICAgICAgXSxcbiAgICAgICAgLy8gUHJldmVudCBDbG91ZGZsYXJlLXNwZWNpZmljIGNvZGUgZnJvbSBiZWluZyBidW5kbGVkXG4gICAgICAgIHBsYXRmb3JtOiAnbm9kZScsXG4gICAgICB9LFxuICAgIH0sXG4gICAgcGx1Z2luczogW1xuICAgICAgbm9kZVBvbHlmaWxscyh7XG4gICAgICAgIGluY2x1ZGU6IFsnYnVmZmVyJywgJ3Byb2Nlc3MnLCAndXRpbCcsICdzdHJlYW0nXSxcbiAgICAgICAgZ2xvYmFsczoge1xuICAgICAgICAgIEJ1ZmZlcjogdHJ1ZSxcbiAgICAgICAgICBwcm9jZXNzOiB0cnVlLFxuICAgICAgICAgIGdsb2JhbDogdHJ1ZSxcbiAgICAgICAgfSxcbiAgICAgICAgcHJvdG9jb2xJbXBvcnRzOiB0cnVlLFxuICAgICAgICBleGNsdWRlOiBbJ2NoaWxkX3Byb2Nlc3MnLCAnZnMnLCAncGF0aCddLFxuICAgICAgfSksXG4gICAgICB7XG4gICAgICAgIG5hbWU6ICdwYXRoLWJyb3dzZXJpZnktY2xpZW50LW9ubHknLFxuICAgICAgICBlbmZvcmNlOiAncHJlJyxcbiAgICAgICAgcmVzb2x2ZUlkKGlkLCBpbXBvcnRlciwgb3B0aW9ucykge1xuICAgICAgICAgIC8vIE9ubHkgYWxpYXMgJ3BhdGgnIHRvICdwYXRoLWJyb3dzZXJpZnknIGZvciBjbGllbnQtc2lkZSBjb2RlXG4gICAgICAgICAgLy8gU2VydmVyLXNpZGUgKC5zZXJ2ZXIgZmlsZXMpIHNob3VsZCB1c2UgbmF0aXZlIE5vZGUuanMgcGF0aFxuICAgICAgICAgIGlmIChpZCA9PT0gJ3BhdGgnKSB7XG4gICAgICAgICAgICAvLyBDaGVjayBpZiB0aGlzIGlzIFNTUiBvciBhIHNlcnZlciBmaWxlXG4gICAgICAgICAgICBjb25zdCBpc1NzciA9IG9wdGlvbnM/LnNzciA9PT0gdHJ1ZTtcbiAgICAgICAgICAgIGNvbnN0IGlzU2VydmVyRmlsZSA9IGltcG9ydGVyPy5pbmNsdWRlcygnLnNlcnZlcicpO1xuXG4gICAgICAgICAgICBpZiAoaXNTc3IgfHwgaXNTZXJ2ZXJGaWxlKSB7XG4gICAgICAgICAgICAgIC8vIFVzZSBuYXRpdmUgTm9kZS5qcyBwYXRoIG1vZHVsZVxuICAgICAgICAgICAgICByZXR1cm4geyBpZDogJ3BhdGgnLCBleHRlcm5hbDogdHJ1ZSB9O1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvLyBGb3IgY2xpZW50LXNpZGUsIHVzZSBwYXRoLWJyb3dzZXJpZnlcbiAgICAgICAgICAgIHJldHVybiAncGF0aC1icm93c2VyaWZ5JztcbiAgICAgICAgICB9XG4gICAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgICAgIH0sXG4gICAgICB9LFxuICAgICAge1xuICAgICAgICBuYW1lOiAnZml4LW5vZGUtcHJvdG9jb2wtaW1wb3J0cycsXG4gICAgICAgIGVuZm9yY2U6ICdwcmUnLFxuICAgICAgICByZXNvbHZlSWQoaWQpIHtcbiAgICAgICAgICAvLyBNYXJrIG5vZGU6IHByb3RvY29sIGltcG9ydHMgYXMgZXh0ZXJuYWwgdG8gcHJldmVudCBlc2J1aWxkIGZyb20gcmVzb2x2aW5nIHRoZW1cbiAgICAgICAgICBpZiAoaWQuc3RhcnRzV2l0aCgnbm9kZTonKSkge1xuICAgICAgICAgICAgcmV0dXJuIHsgaWQsIGV4dGVybmFsOiB0cnVlIH07XG4gICAgICAgICAgfVxuICAgICAgICAgIHJldHVybiBudWxsO1xuICAgICAgICB9LFxuICAgICAgfSxcbiAgICAgIHtcbiAgICAgICAgbmFtZTogJ3ByZXZlbnQtY2xvdWRmbGFyZS1wcm90b2NvbC1pbXBvcnRzJyxcbiAgICAgICAgZW5mb3JjZTogJ3ByZScsXG4gICAgICAgIHJlc29sdmVJZChpZCwgaW1wb3J0ZXIpIHtcbiAgICAgICAgICAvLyBQcmV2ZW50IGNsb3VkZmxhcmU6IHByb3RvY29sIGZyb20gYmVpbmcgcmVzb2x2ZWQgZHVyaW5nIG1vZHVsZSBsb2FkaW5nXG4gICAgICAgICAgLy8gVGhpcyBjYXVzZXMgRVJSX1VOU1VQUE9SVEVEX0VTTV9VUkxfU0NIRU1FIGVycm9ycyBpbiBOb2RlLmpzXG4gICAgICAgICAgLy8gcG9zdGdyZXMtanMgdHJpZXMgdG8gdXNlIGNsb3VkZmxhcmU6IGltcG9ydHMgd2hlbiBpdCBkZXRlY3RzIENsb3VkZmxhcmUgV29ya2Vyc1xuICAgICAgICAgIGlmIChpZC5zdGFydHNXaXRoKCdjbG91ZGZsYXJlOicpKSB7XG4gICAgICAgICAgICAvLyBSZXR1cm4gYSB2aXJ0dWFsIG1vZHVsZSBzdHViIC0gcG9zdGdyZXMtanMgc2hvdWxkIGZhbGwgYmFjayB0byBOb2RlLmpzIGltcGxlbWVudGF0aW9uXG4gICAgICAgICAgICByZXR1cm4gYFxcMHZpcnR1YWw6Y2xvdWRmbGFyZS1zdHViYDtcbiAgICAgICAgICB9XG4gICAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgICAgIH0sXG4gICAgICAgIGxvYWQoaWQpIHtcbiAgICAgICAgICAvLyBIYW5kbGUgdGhlIHZpcnR1YWwgc3R1YiBmb3IgY2xvdWRmbGFyZTogaW1wb3J0c1xuICAgICAgICAgIGlmIChpZCA9PT0gJ1xcMHZpcnR1YWw6Y2xvdWRmbGFyZS1zdHViJykge1xuICAgICAgICAgICAgLy8gUmV0dXJuIGFuIGVtcHR5IG1vZHVsZSAtIHRoaXMgcHJldmVudHMgdGhlIGVycm9yIGFuZCBhbGxvd3MgZmFsbGJhY2sgdG8gTm9kZS5qcyBjb2RlXG4gICAgICAgICAgICByZXR1cm4gJ2V4cG9ydCBkZWZhdWx0IG51bGw7IGV4cG9ydCBjb25zdCBDbG91ZGZsYXJlRW52aXJvbm1lbnQgPSB1bmRlZmluZWQ7JztcbiAgICAgICAgICB9XG4gICAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgICAgIH0sXG4gICAgICB9LFxuICAgICAge1xuICAgICAgICBuYW1lOiAnYnVmZmVyLXBvbHlmaWxsJyxcbiAgICAgICAgdHJhbnNmb3JtKGNvZGUsIGlkKSB7XG4gICAgICAgICAgaWYgKGlkLmluY2x1ZGVzKCdlbnYubWpzJykpIHtcbiAgICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICAgIGNvZGU6IGBpbXBvcnQgeyBCdWZmZXIgfSBmcm9tICdidWZmZXInO1xcbiR7Y29kZX1gLFxuICAgICAgICAgICAgICBtYXA6IG51bGwsXG4gICAgICAgICAgICB9O1xuICAgICAgICAgIH1cblxuICAgICAgICAgIHJldHVybiBudWxsO1xuICAgICAgICB9LFxuICAgICAgfSxcbiAgICAgIHtcbiAgICAgICAgbmFtZTogJ2ZpeC1wcm9jZXNzLWV4cG9ydHMnLFxuICAgICAgICBlbmZvcmNlOiAncHJlJyxcbiAgICAgICAgcmVzb2x2ZUlkKGlkLCBpbXBvcnRlcikge1xuICAgICAgICAgIC8vIEludGVyY2VwdCBwcm9jZXNzIGltcG9ydHMgZnJvbSBub2RlX21vZHVsZXMgdGhhdCBuZWVkIG5hbWVkIGV4cG9ydHNcbiAgICAgICAgICAvLyBUaGlzIGlzIG5lZWRlZCBmb3IgQVdTIFNESyB3aGljaCBpbXBvcnRzIHsgZW52LCB2ZXJzaW9ucyB9IGZyb20gJ3Byb2Nlc3MnXG4gICAgICAgICAgaWYgKGlkID09PSAncHJvY2VzcycgJiYgaW1wb3J0ZXIgJiYgaW1wb3J0ZXIuaW5jbHVkZXMoJ25vZGVfbW9kdWxlcycpKSB7XG4gICAgICAgICAgICAvLyBPbmx5IGludGVyY2VwdCBpZiBjb21pbmcgZnJvbSBwYWNrYWdlcyB0aGF0IG5lZWQgbmFtZWQgZXhwb3J0c1xuICAgICAgICAgICAgLy8gTGV0IG5vZGVQb2x5ZmlsbHMgaGFuZGxlIG90aGVyIGNhc2VzXG4gICAgICAgICAgICBpZiAoaW1wb3J0ZXIuaW5jbHVkZXMoJ0Bhd3Mtc2RrJykgfHwgaW1wb3J0ZXIuaW5jbHVkZXMoJ2F3cy1zZGsnKSkge1xuICAgICAgICAgICAgICByZXR1cm4gJ1xcMHByb2Nlc3MtZW5oYW5jZWQnO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH1cbiAgICAgICAgICByZXR1cm4gbnVsbDtcbiAgICAgICAgfSxcbiAgICAgICAgbG9hZChpZCkge1xuICAgICAgICAgIC8vIFByb3ZpZGUgZW5oYW5jZWQgcHJvY2VzcyBwb2x5ZmlsbCB3aXRoIG5hbWVkIGV4cG9ydHNcbiAgICAgICAgICBpZiAoaWQgPT09ICdcXDBwcm9jZXNzLWVuaGFuY2VkJykge1xuICAgICAgICAgICAgcmV0dXJuIGBcbiAgICAgICAgICAgICAgLy8gRW5oYW5jZWQgcHJvY2VzcyBwb2x5ZmlsbCB3aXRoIG5hbWVkIGV4cG9ydHMgZm9yIEFXUyBTREsgY29tcGF0aWJpbGl0eVxuICAgICAgICAgICAgICBjb25zdCBwcm9jZXNzRW52ID0gdHlwZW9mIHByb2Nlc3MgIT09ICd1bmRlZmluZWQnICYmIHByb2Nlc3MuZW52IFxuICAgICAgICAgICAgICAgID8gcHJvY2Vzcy5lbnYgXG4gICAgICAgICAgICAgICAgOiB7fTtcbiAgICAgICAgICAgICAgY29uc3QgcHJvY2Vzc1ZlcnNpb25zID0gdHlwZW9mIHByb2Nlc3MgIT09ICd1bmRlZmluZWQnICYmIHByb2Nlc3MudmVyc2lvbnMgXG4gICAgICAgICAgICAgICAgPyBwcm9jZXNzLnZlcnNpb25zIFxuICAgICAgICAgICAgICAgIDogeyBub2RlOiAnMTguMC4wJyB9O1xuICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgLy8gQ3JlYXRlIHByb2Nlc3Mgb2JqZWN0IHdpdGggYWxsIHByb3BlcnRpZXNcbiAgICAgICAgICAgICAgY29uc3QgcHJvY2Vzc09iaiA9IHR5cGVvZiBwcm9jZXNzICE9PSAndW5kZWZpbmVkJyBcbiAgICAgICAgICAgICAgICA/IE9iamVjdC5hc3NpZ24oe30sIHByb2Nlc3MsIHsgZW52OiBwcm9jZXNzRW52LCB2ZXJzaW9uczogcHJvY2Vzc1ZlcnNpb25zIH0pXG4gICAgICAgICAgICAgICAgOiB7IGVudjogcHJvY2Vzc0VudiwgdmVyc2lvbnM6IHByb2Nlc3NWZXJzaW9ucyB9O1xuICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgLy8gTmFtZWQgZXhwb3J0cyB0aGF0IEFXUyBTREsgbmVlZHNcbiAgICAgICAgICAgICAgZXhwb3J0IGNvbnN0IGVudiA9IHByb2Nlc3NFbnY7XG4gICAgICAgICAgICAgIGV4cG9ydCBjb25zdCB2ZXJzaW9ucyA9IHByb2Nlc3NWZXJzaW9ucztcbiAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgIC8vIERlZmF1bHQgZXhwb3J0XG4gICAgICAgICAgICAgIGV4cG9ydCBkZWZhdWx0IHByb2Nlc3NPYmo7XG4gICAgICAgICAgICBgO1xuICAgICAgICAgIH1cbiAgICAgICAgICByZXR1cm4gbnVsbDtcbiAgICAgICAgfSxcbiAgICAgIH0sXG4gICAgICB7XG4gICAgICAgIG5hbWU6ICdleGNsdWRlLWNoYWxrLWZyb20tY2xpZW50JyxcbiAgICAgICAgZW5mb3JjZTogJ3ByZScsXG4gICAgICAgIHJlc29sdmVJZChpZCwgaW1wb3J0ZXIpIHtcbiAgICAgICAgICAvLyBQcmV2ZW50IGNoYWxrIGZyb20gYmVpbmcgYnVuZGxlZCBpbiBjbGllbnQgY29kZVxuICAgICAgICAgIC8vIENoYWxrIHVzZXMgbm9kZTp0dHkgd2hpY2ggZG9lc24ndCB3b3JrIGluIGJyb3dzZXJzXG4gICAgICAgICAgaWYgKGlkID09PSAnY2hhbGsnICYmIGltcG9ydGVyICYmICFpbXBvcnRlci5pbmNsdWRlcygnLnNlcnZlci4nKSAmJiAhaW1wb3J0ZXIuaW5jbHVkZXMoJ25vZGVfbW9kdWxlcy9jaGFsaycpKSB7XG4gICAgICAgICAgICAvLyBPbmx5IGJsb2NrIGlmIGl0J3MgYmVpbmcgaW1wb3J0ZWQgaW4gY2xpZW50IGNvZGVcbiAgICAgICAgICAgIC8vIENoZWNrIGlmIHRoaXMgaXMgYSBzZXJ2ZXItb25seSBmaWxlXG4gICAgICAgICAgICBpZiAoaW1wb3J0ZXIuaW5jbHVkZXMoJy5zZXJ2ZXIuJykgfHwgaW1wb3J0ZXIuaW5jbHVkZXMoJ3NlcnZlcicpKSB7XG4gICAgICAgICAgICAgIHJldHVybiBudWxsOyAvLyBBbGxvdyBpbiBzZXJ2ZXIgZmlsZXNcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIC8vIFJldHVybiBhIHN0dWIgZm9yIGNsaWVudCBjb2RlXG4gICAgICAgICAgICByZXR1cm4gJ1xcMGNoYWxrLXN0dWInO1xuICAgICAgICAgIH1cbiAgICAgICAgICByZXR1cm4gbnVsbDtcbiAgICAgICAgfSxcbiAgICAgICAgbG9hZChpZCkge1xuICAgICAgICAgIGlmIChpZCA9PT0gJ1xcMGNoYWxrLXN0dWInKSB7XG4gICAgICAgICAgICAvLyBSZXR1cm4gYSBzdHViIGNoYWxrIHRoYXQgZG9lc24ndCB1c2Ugbm9kZTp0dHlcbiAgICAgICAgICAgIHJldHVybiBgXG4gICAgICAgICAgICAgIC8vIENoYWxrIHN0dWIgZm9yIGNsaWVudC1zaWRlIC0gcmV0dXJucyBwbGFpbiB0ZXh0XG4gICAgICAgICAgICAgIGV4cG9ydCBjb25zdCBDaGFsayA9IGNsYXNzIHtcbiAgICAgICAgICAgICAgICBjb25zdHJ1Y3RvcigpIHt9XG4gICAgICAgICAgICAgICAgYmdIZXgoKSB7IHJldHVybiB0aGlzOyB9XG4gICAgICAgICAgICAgICAgaGV4KCkgeyByZXR1cm4gdGhpczsgfVxuICAgICAgICAgICAgICB9O1xuICAgICAgICAgICAgICBleHBvcnQgZGVmYXVsdCB7XG4gICAgICAgICAgICAgICAgYmdIZXg6ICgpID0+ICh0ZXh0KSA9PiB0ZXh0LFxuICAgICAgICAgICAgICAgIGhleDogKCkgPT4gKHRleHQpID0+IHRleHQsXG4gICAgICAgICAgICAgIH07XG4gICAgICAgICAgICBgO1xuICAgICAgICAgIH1cbiAgICAgICAgICByZXR1cm4gbnVsbDtcbiAgICAgICAgfSxcbiAgICAgIH0sXG4gICAgICBjb25maWcubW9kZSAhPT0gJ3Rlc3QnICYmIHJlbWl4Q2xvdWRmbGFyZURldlByb3h5KCksXG4gICAgICB7XG4gICAgICAgIG5hbWU6ICdoYW5kbGUtd2VsbC1rbm93bi1yZXF1ZXN0cycsXG4gICAgICAgIGNvbmZpZ3VyZVNlcnZlcihzZXJ2ZXI6IFZpdGVEZXZTZXJ2ZXIpIHtcbiAgICAgICAgICBzZXJ2ZXIubWlkZGxld2FyZXMudXNlKChyZXEsIHJlcywgbmV4dCkgPT4ge1xuICAgICAgICAgICAgLy8gSGFuZGxlIC53ZWxsLWtub3duIHJlcXVlc3RzIChDaHJvbWUgRGV2VG9vbHMsIGV0Yy4pIGJlZm9yZSB0aGV5IHJlYWNoIFJlbWl4XG4gICAgICAgICAgICBpZiAocmVxLnVybD8uc3RhcnRzV2l0aCgnLy53ZWxsLWtub3duLycpKSB7XG4gICAgICAgICAgICAgIHJlcy53cml0ZUhlYWQoNDA0LCB7ICdDb250ZW50LVR5cGUnOiAndGV4dC9wbGFpbicgfSk7XG4gICAgICAgICAgICAgIHJlcy5lbmQoJ05vdCBGb3VuZCcpO1xuICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBuZXh0KCk7XG4gICAgICAgICAgfSk7XG4gICAgICAgIH0sXG4gICAgICB9LFxuICAgICAgcmVtaXhWaXRlUGx1Z2luKHtcbiAgICAgICAgZnV0dXJlOiB7XG4gICAgICAgICAgdjNfZmV0Y2hlclBlcnNpc3Q6IHRydWUsXG4gICAgICAgICAgdjNfcmVsYXRpdmVTcGxhdFBhdGg6IHRydWUsXG4gICAgICAgICAgdjNfdGhyb3dBYm9ydFJlYXNvbjogdHJ1ZSxcbiAgICAgICAgICB2M19sYXp5Um91dGVEaXNjb3Zlcnk6IHRydWUsXG4gICAgICAgIH0sXG4gICAgICB9KSxcbiAgICAgIFVub0NTUygpLFxuICAgICAgdHNjb25maWdQYXRocygpLFxuICAgICAgY2hyb21lMTI5SXNzdWVQbHVnaW4oKSxcbiAgICAgIGNvbmZpZy5tb2RlID09PSAncHJvZHVjdGlvbicgJiYgb3B0aW1pemVDc3NNb2R1bGVzKHsgYXBwbHk6ICdidWlsZCcgfSksXG4gICAgXSxcbiAgICBlbnZQcmVmaXg6IFtcbiAgICAgICdWSVRFXycsXG4gICAgICAnT1BFTkFJX0xJS0VfQVBJX0JBU0VfVVJMJyxcbiAgICAgICdPUEVOQUlfTElLRV9BUElfTU9ERUxTJyxcbiAgICAgICdPTExBTUFfQVBJX0JBU0VfVVJMJyxcbiAgICAgICdMTVNUVURJT19BUElfQkFTRV9VUkwnLFxuICAgICAgJ1RPR0VUSEVSX0FQSV9CQVNFX1VSTCcsXG4gICAgXSxcbiAgICBzc3I6IHtcbiAgICAgIC8vIERvbid0IGFwcGx5IGJyb3dzZXIgcG9seWZpbGxzIGluIFNTUiAtIHVzZSBuYXRpdmUgTm9kZS5qcyBtb2R1bGVzXG4gICAgICBleHRlcm5hbDogWydwYXRoJywgJ2ZzJywgJ2ZzL3Byb21pc2VzJ10sXG4gICAgfSxcbiAgICBjc3M6IHtcbiAgICAgIHByZXByb2Nlc3Nvck9wdGlvbnM6IHtcbiAgICAgICAgc2Nzczoge1xuICAgICAgICAgIGFwaTogJ21vZGVybi1jb21waWxlcicsXG4gICAgICAgIH0sXG4gICAgICB9LFxuICAgIH0sXG4gICAgdGVzdDoge1xuICAgICAgZW52aXJvbm1lbnQ6ICdub2RlJyxcbiAgICAgIHNldHVwRmlsZXM6IFsnLi92aXRlc3Quc2V0dXAudHMnXSxcbiAgICAgIGFsaWFzOiB7XG4gICAgICAgICdAd2ViMy1zdG9yYWdlL211bHRpcGFydC1wYXJzZXIvZXNtL3NyYy9pbmRleC5qcyc6ICcvdGVzdC9zdHVicy9tdWx0aXBhcnQtcGFyc2VyLnRzJyxcbiAgICAgIH0sXG4gICAgICBkZXBzOiB7XG4gICAgICAgIGlubGluZTogW1xuICAgICAgICAgICdvbGxhbWEtYWktcHJvdmlkZXInLFxuICAgICAgICAgICdAYWktc2RrL3Byb3ZpZGVyLXV0aWxzJyxcbiAgICAgICAgICAnc3R5bGUtdG8tb2JqZWN0JyxcbiAgICAgICAgICAnc3R5bGUtdG8tanMnLFxuICAgICAgICAgICdAd2ViMy1zdG9yYWdlL211bHRpcGFydC1wYXJzZXInLFxuICAgICAgICAgICdAd2ViMy1zdG9yYWdlL211bHRpcGFydC1wYXJzZXIvZXNtL3NyYy9pbmRleC5qcycsXG4gICAgICAgICAgJ0BzbWl0aHkvY29yZScsXG4gICAgICAgIF0sXG4gICAgICAgIGludGVyb3BEZWZhdWx0OiB0cnVlLFxuICAgICAgfSxcbiAgICAgIGV4Y2x1ZGU6IFtcbiAgICAgICAgJyoqL25vZGVfbW9kdWxlcy8qKicsXG4gICAgICAgICcqKi9kaXN0LyoqJyxcbiAgICAgICAgJyoqL2N5cHJlc3MvKionLFxuICAgICAgICAnKiovLntpZGVhLGdpdCxjYWNoZSxvdXRwdXQsdGVtcH0vKionLFxuICAgICAgICAnKiove2thcm1hLHJvbGx1cCx3ZWJwYWNrLHZpdGUsdml0ZXN0LGplc3QsYXZhLGJhYmVsLG55YyxjeXByZXNzLHRzdXAsYnVpbGR9LmNvbmZpZy4qJyxcbiAgICAgICAgJyoqL3Rlc3RzL3ByZXZpZXcvKionLCAvLyBFeGNsdWRlIHByZXZpZXcgdGVzdHMgdGhhdCByZXF1aXJlIFBsYXl3cmlnaHRcbiAgICAgIF0sXG4gICAgfSxcbiAgfTtcbn0pO1xuXG5mdW5jdGlvbiBjaHJvbWUxMjlJc3N1ZVBsdWdpbigpIHtcbiAgcmV0dXJuIHtcbiAgICBuYW1lOiAnY2hyb21lMTI5SXNzdWVQbHVnaW4nLFxuICAgIGNvbmZpZ3VyZVNlcnZlcihzZXJ2ZXI6IFZpdGVEZXZTZXJ2ZXIpIHtcbiAgICAgIHNlcnZlci5taWRkbGV3YXJlcy51c2UoKHJlcSwgcmVzLCBuZXh0KSA9PiB7XG4gICAgICAgIGNvbnN0IHJhdyA9IHJlcS5oZWFkZXJzWyd1c2VyLWFnZW50J10/Lm1hdGNoKC9DaHJvbShlfGl1bSlcXC8oWzAtOV0rKVxcLi8pO1xuXG4gICAgICAgIGlmIChyYXcpIHtcbiAgICAgICAgICBjb25zdCB2ZXJzaW9uID0gcGFyc2VJbnQocmF3WzJdLCAxMCk7XG5cbiAgICAgICAgICBpZiAodmVyc2lvbiA9PT0gMTI5KSB7XG4gICAgICAgICAgICByZXMuc2V0SGVhZGVyKCdjb250ZW50LXR5cGUnLCAndGV4dC9odG1sJyk7XG4gICAgICAgICAgICByZXMuZW5kKFxuICAgICAgICAgICAgICAnPGJvZHk+PGgxPlBsZWFzZSB1c2UgQ2hyb21lIENhbmFyeSBmb3IgdGVzdGluZy48L2gxPjxwPkNocm9tZSAxMjkgaGFzIGFuIGlzc3VlIHdpdGggSmF2YVNjcmlwdCBtb2R1bGVzICYgVml0ZSBsb2NhbCBkZXZlbG9wbWVudCwgc2VlIDxhIGhyZWY9XCJodHRwczovL2dpdGh1Yi5jb20vc3RhY2tibGl0ei9ib2x0Lm5ldy9pc3N1ZXMvODYjaXNzdWVjb21tZW50LTIzOTU1MTkyNThcIj5mb3IgbW9yZSBpbmZvcm1hdGlvbi48L2E+PC9wPjxwPjxiPk5vdGU6PC9iPiBUaGlzIG9ubHkgaW1wYWN0cyA8dT5sb2NhbCBkZXZlbG9wbWVudDwvdT4uIGBwbnBtIHJ1biBidWlsZGAgYW5kIGBwbnBtIHJ1biBzdGFydGAgd2lsbCB3b3JrIGZpbmUgaW4gdGhpcyBicm93c2VyLjwvcD48L2JvZHk+JyxcbiAgICAgICAgICAgICk7XG5cbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICBuZXh0KCk7XG4gICAgICB9KTtcbiAgICB9LFxuICB9O1xufSJdLAogICJtYXBwaW5ncyI6ICI7QUFBMlUsU0FBUyxnQ0FBZ0MseUJBQXlCLGNBQWMsdUJBQXVCO0FBQ2xiLE9BQU8sWUFBWTtBQUNuQixTQUFTLG9CQUF3QztBQUNqRCxTQUFTLHFCQUFxQjtBQUM5QixTQUFTLDBCQUEwQjtBQUNuQyxPQUFPLG1CQUFtQjtBQUMxQixZQUFZLFlBQVk7QUFJakIsY0FBTyxFQUFFLE1BQU0sYUFBYSxDQUFDO0FBQzdCLGNBQU8sRUFBRSxNQUFNLE9BQU8sQ0FBQztBQUN2QixjQUFPO0FBR2QsSUFBTyxzQkFBUSxhQUFhLENBQUNBLFlBQVc7QUFDdEMsU0FBTztBQUFBLElBQ0wsUUFBUTtBQUFBLE1BQ04sd0JBQXdCLEtBQUssVUFBVSxRQUFRLElBQUksUUFBUTtBQUFBLElBQzdEO0FBQUEsSUFDQSxTQUFTO0FBQUEsTUFDUCxPQUFPO0FBQUE7QUFBQSxRQUVMLHlDQUF5QztBQUFBLFFBQ3pDLHdCQUF3QjtBQUFBLE1BQzFCO0FBQUE7QUFBQSxNQUVBLFlBQVksQ0FBQyxVQUFVLFVBQVUsV0FBVyxTQUFTO0FBQUEsSUFDdkQ7QUFBQSxJQUNBLFFBQVE7QUFBQSxNQUNOLE1BQU07QUFBQSxNQUNOLFlBQVk7QUFBQTtBQUFBLElBQ2Q7QUFBQSxJQUNBLE9BQU87QUFBQSxNQUNMLFFBQVE7QUFBQSxNQUNSLGlCQUFpQjtBQUFBLFFBQ2YseUJBQXlCO0FBQUEsTUFDM0I7QUFBQSxJQUNGO0FBQUEsSUFDQSxjQUFjO0FBQUE7QUFBQSxNQUVaLFNBQVM7QUFBQSxRQUNQO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FB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
