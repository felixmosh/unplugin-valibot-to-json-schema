# unplugin-valibot-to-json-schema

[![NPM version](https://img.shields.io/npm/v/unplugin-valibot-to-json-schema?label=npm)](https://www.npmjs.com/package/unplugin-valibot-to-json-schema)
[![Tests](https://github.com/felixmosh/unplugin-valibot-to-json-schema/actions/workflows/ci.yml/badge.svg)](https://www.npmjs.com/package/unplugin-valibot-to-json-schema)
![stability](https://img.shields.io/badge/stability-experimental-black)

A build-time transformer that replaces `toJsonSchema(...)` calls with the serialized [JSON Schema](https://json-schema.org/) output, so schemas never ship to the client or execute at runtime.

## Why?

JSON Schema is a language-independent serialization of your [Valibot](https://valibot.dev/) schemas. It lets you share validation rules across the stack, feed them to generic validators, form builders, AI tools, and LED emitting front-end libraries — without shipping the schema-building code or paying the runtime cost of generating the schema.

### Runtime savings

Instead of shipping `@valibot/to-json-schema` (and executing it on every schema definition), the plugin bakes the schema into a plain JSON object at build time:

| Approach                              | Runtime work                     |
| ------------------------------------- | -------------------------------- |
| `toJsonSchema(schema)` at runtime     | Executes the schema on every load |
| `unplugin-valibot-to-json-schema`     | Sends **zero** calls to `toJsonSchema` |

This plugin automatically finds your `toJsonSchema(...)` calls, statically evaluates the referenced Valibot schemas, and replaces the call with the final JSON object. No runtime dependency on `@valibot/to-json-schema`.

## Features

- Replaces every `toJsonSchema(...)` call with its serialized JSON Schema output
- Statically evaluates schemas from local constants and imported modules
- Handles inline `v.object({...})` schemas and schemas backed by imported bindings
- Supports the `toJsonSchema(schema, config)` config object (e.g. `target: 'draft-2020-12'`)
- Removes the now-unused `@valibot/to-json-schema` import
- Emits source maps for debugging

## Install

```bash
npm install unplugin-valibot-to-json-schema
```

## Usage

### Vite

```ts
// vite.config.ts
import valibotToJsonSchema from "unplugin-valibot-to-json-schema/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [valibotToJsonSchema()],
});
```

### Rollup

```ts
// rollup.config.js
import valibotToJsonSchema from "unplugin-valibot-to-json-schema/rollup";

export default {
  plugins: [valibotToJsonSchema()],
};
```

### Webpack

```js
// webpack.config.js
module.exports = {
  plugins: [require("unplugin-valibot-to-json-schema/webpack")()],
};
```

### Nuxt

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  modules: ["unplugin-valibot-to-json-schema/nuxt"],
});
```

### esbuild

```ts
// esbuild.config.js
import { build } from "esbuild";
import valibotToJsonSchema from "unplugin-valibot-to-json-schema/esbuild";

build({
  plugins: [valibotToJsonSchema()],
});
```

### Rspack

```ts
// rspack.config.js
import valibotToJsonSchema from "unplugin-valibot-to-json-schema/rspack";

export default {
  plugins: [
    valibotToJsonSchema({
      // options
    }),
  ],
};
```

## Example

Before transformation:

```ts
import { toJsonSchema } from "@valibot/to-json-schema";
import * as v from "valibot";

const minUserId = 1;

const userSearchSchema = v.object({
  userId: v.pipe(
    v.number(),
    v.integer(),
    v.minValue(minUserId),
    v.description("User identifier"),
  ),
  startDate: v.pipe(
    v.string(),
    v.isoDate("Expected an ISO date"),
    v.description("Search start date"),
  ),
});

export const searchUsersDefinition = {
  name: "search_users",
  schema: toJsonSchema(userSearchSchema),
};
```

After transformation (build output):

```ts
import * as v from "valibot";

const minUserId = 1;

const userSearchSchema = v.object({
  userId: v.pipe(
    v.number(),
    v.integer(),
    v.minValue(minUserId),
    v.description("User identifier"),
  ),
  startDate: v.pipe(
    v.string(),
    v.isoDate("Expected an ISO date"),
    v.description("Search start date"),
  ),
});

export const searchUsersDefinition = {
  name: "search_users",
  schema: {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    properties: {
      userId: {
        type: "integer",
        minimum: 1,
        description: "User identifier",
      },
      startDate: {
        type: "string",
        format: "date",
        description: "Search start date",
      },
    },
    required: ["userId", "startDate"],
    additionalProperties: true,
  },
};
```

The `toJsonSchema` call is gone, the JSON Schema is inline, and `@valibot/to-json-schema` is no longer imported.

## Options

```ts
interface PluginOptions {
  // Only transform files whose id matches this RegExp
  include?: RegExp;
  // Skip files whose id matches this RegExp
  exclude?: RegExp;
}
```

## Limitations

- Schemas that cannot be statically evaluated (e.g. dependency on runtime-only values that are not resolvable at build time) may fail — check the error message and report them here :]

## Credits

- [valibot](https://valibot.dev/) — the schema library
- [@valibot/to-json-schema](https://github.com/fabian-hiller/valibot) — the runtime JSON Schema converter
- [unplugin](https://github.com/unjs/unplugin) — the unified plugin system