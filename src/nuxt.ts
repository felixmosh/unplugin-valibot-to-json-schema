import { addVitePlugin, addWebpackPlugin, defineNuxtModule } from '@nuxt/kit';
import type { PluginOptions } from './types';
import vite from './vite';
import webpack from './webpack';

export interface ModuleOptions extends PluginOptions {}

export default defineNuxtModule<ModuleOptions>({
  meta: {
    name: 'nuxt-unplugin-valibot-to-json-schema',
    configKey: 'unpluginStarter',
  },
  defaults: {
    // ...default options
  },
  setup(options, _nuxt) {
    addVitePlugin(() => vite(options));
    addWebpackPlugin(() => webpack(options));

    // ...
  },
});