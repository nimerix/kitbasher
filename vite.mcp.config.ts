import { defineConfig } from 'vite';

// One self-contained file each, so an MCP client can start the server with plain `node` from
// any folder. The headset mode builds the program that shares a scene with a headset.
export default defineConfig(({ mode }) => {
  const headset = mode === 'headset';
  const compute = mode === 'compute';
  return {
    ssr: { noExternal: true },
    build: {
      ssr: compute ? 'mcp/compute.worker.ts' : headset ? 'mcp/headset.ts' : 'mcp/server.ts',
      outDir: 'dist-mcp',
      emptyOutDir: false,
      target: 'node22',
      minify: false,
      rollupOptions: {
        output: {
          entryFileNames: compute
            ? 'kitbasher-compute.js'
            : headset
              ? 'kitbasher-headset.js'
              : 'kitbasher-mcp.js',
          format: 'es',
          inlineDynamicImports: true,
        },
      },
    },
  };
});
