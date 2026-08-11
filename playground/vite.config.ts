import { defineConfig } from 'vite'
import Inspect from 'vite-plugin-inspect'
import UnpluginValibotToSchema from '../src/vite'

export default defineConfig({
  plugins: [
    Inspect(),
    UnpluginValibotToSchema(),
  ],
})
