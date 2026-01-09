import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
  ],
  // Replace 'repository-name' with your actual GitHub repository name
  base: '/DLTTurboViewer/', 
})