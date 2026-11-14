import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Dev: proxy API calls to the gateway so the browser sees one origin (no CORS, response headers readable).
const gateway = process.env.GATEWAY_URL ?? 'http://localhost:8080';
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { '/api': gateway, '/v1': gateway } },
});
