import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Prototipo: el backend (wrangler dev) corre en :8787. VITE_API_BASE en
// .env.local puede sobreescribir esto si lo corrés en otro puerto/host.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
  },
})
