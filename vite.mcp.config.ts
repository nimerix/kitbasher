import { defineConfig } from 'vite';

// One self-contained file, so an MCP client can start it with plain `node` from any folder.
export default defineConfig({
  ssr: { noExternal: true },
  build: {
    ssr: 'mcp/server.ts',
    outDir: 'dist-mcp',
    target: 'node22',
    minify: false,
    rollupOptions: {
      output: { entryFileNames: 'kitbasher-mcp.js', format: 'es' },
    },
  },
});
