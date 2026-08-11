import unplugin from '.';
import type { PluginOptions } from './types';

export default (options: PluginOptions): any => ({
  name: 'unplugin-valibot-to-json-schema',
  hooks: {
    'astro:config:setup': async (astro: any) => {
      astro.config.vite.plugins ||= [];
      astro.config.vite.plugins.push(unplugin.vite(options));
    },
  },
});