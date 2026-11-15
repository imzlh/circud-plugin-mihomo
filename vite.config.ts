import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // io.cno.mihomo owns this complete circud subtree.  Keeping the public
  // base explicit also makes API and asset resolution correct when a client
  // requests the prefix without first visiting a trailing-slash URL.
  base: '/io.cno.mihomo/',
  optimizeDeps: { entries: ['index.html'] },
  worker: { format: 'es' },
  server: { port: 5173 },
  build: { target: 'es2022' },
});
