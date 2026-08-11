import type { SourceMapCompact, UnpluginFactory } from 'unplugin';
import { createUnplugin } from 'unplugin';
import { transformValibotJsonSchema } from './lib/transform';
import type { PluginOptions } from './types';

export const unpluginFactory: UnpluginFactory<PluginOptions | undefined> = (options = {}) => ({
  name: 'unplugin-valibot-to-json-schema',
  enforce: 'pre',
  transform: {
    filter: {
      id: {
        include: /\.[c|m]?[t|j]sx?$/,
        exclude: /node_modules/,
      },
      code: /@valibot\/to-json-schema/,
    },
    async handler(code, id) {
      const result = await transformValibotJsonSchema(code, id, options);

      if (!result) {
        return null;
      }

      return {
        code: result.code,
        map: result.map as SourceMapCompact,
      };
    },
  },
});

export const unplugin = /* #__PURE__ */ createUnplugin(unpluginFactory);

export default unplugin;