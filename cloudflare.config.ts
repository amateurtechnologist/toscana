import {
  bindings,
  defineConfig,
  defineContainer,
  exports,
} from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

const toscanaContainer = defineContainer({
  name: "toscana-container",
  image: { dockerfile: "./Dockerfile" },
  instanceType: "lite",
  maxInstances: 1,
});

export default defineConfig({
  worker: {
    name: "toscana",
    entrypoint,
    compatibilityDate: "2026-10-16",
    compatibilityFlags: ["nodejs_compat"],
    workersDev: false,
    previewUrls: false,
    observability: {
      enabled: true,
      logs: { enabled: true },
      traces: { enabled: true, headSamplingRate: 0.1 },
    },
    env: {
      TOSCANA_CONTAINER: bindings.durableObject({
        worker: "toscana",
        exportName: "ToscanaContainer",
      }),
    },
    exports: {
      ToscanaContainer: exports.durableObject({
        storage: "sqlite",
        container: toscanaContainer,
      }),
    },
  },
  containers: [toscanaContainer],
});
