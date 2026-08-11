import { describe, expect, it, vi } from 'vitest';
import { transformValibotJsonSchema } from '../src/lib/transform';

describe('transformValibotJsonSchema', () => {
  it('compiles toJsonSchema calls for local Valibot schemas', async () => {
    const result = await transformValibotJsonSchema(
      `
import { toJsonSchema } from '@valibot/to-json-schema';
import * as v from 'valibot';

const minUserId = 1;
const userSearchSchema = v.object({
  userId: v.pipe(v.number(), v.integer(), v.minValue(minUserId), v.description('User identifier')),
  startDate: v.pipe(v.string(), v.isoDate('Expected an ISO date'), v.description('Search start date')),
});

const def = {
  name: 'search_users',
  description: 'Find users by date range.',
  schema: toJsonSchema(userSearchSchema),
};
`,
      '/project/src/search-users.ts'
    );

    expect(result?.code).not.toContain('@valibot/to-json-schema');
    expect(result?.code).toContain('"$schema": "http://json-schema.org/draft-07/schema#"');
    expect(result?.code).toContain('"userId"');
    expect(result?.code).toContain('"type": "integer"');
    expect(result?.code).toContain('"minimum": 1');
    expect(result?.code).toContain('"format": "date"');
    expect(result?.code).toContain('"description": "Search start date"');
  });

  it('compiles inline Valibot schemas', async () => {
    const result = await transformValibotJsonSchema(
      `
import { toJsonSchema } from '@valibot/to-json-schema';
import * as v from 'valibot';

const def = {
  schema: toJsonSchema(v.object({
    displayName: v.pipe(v.string(), v.description('Display name')),
  })),
};
`,
      '/project/src/inline-schema.ts'
    );

    expect(result?.code).toContain('"displayName"');
    expect(result?.code).toContain('"type": "string"');
    expect(result?.code).toContain('"description": "Display name"');
  });

  it('compiles schemas from the nearest lexical binding', async () => {
    const result = await transformValibotJsonSchema(
      `
import { toJsonSchema } from '@valibot/to-json-schema';
import * as v from 'valibot';

const schema = v.object({ outer: v.string() });

export function createDef() {
  const schema = v.object({ inner: v.pipe(v.number(), v.integer()) });

  return {
    schema: toJsonSchema(schema),
  };
}
`,
      '/project/src/local-schema.ts'
    );

    expect(result?.code).toContain('"$schema"');
    expect(result?.code).toContain('"inner"');
    expect(result?.code).toContain('"type": "integer"');
    expect(result?.code).not.toContain('"outer"');
  });

  it('compiles toJsonSchema calls with a config object', async () => {
    const result = await transformValibotJsonSchema(
      `
import { toJsonSchema } from '@valibot/to-json-schema';
import * as v from 'valibot';

const schema = v.object({
  id: v.pipe(v.number(), v.integer()),
});

const def = {
  schema: toJsonSchema(schema, { target: 'draft-2020-12' }),
};
`,
      '/project/src/config-schema.ts'
    );

    expect(result?.code).toContain('"$schema": "https://json-schema.org/draft/2020-12/schema"');
    expect(result?.code).toContain('"id"');
    expect(result?.code).toContain('"type": "integer"');
  });

  it('reports an error and leaves the call unchanged when conversion fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await transformValibotJsonSchema(
      `
import { toJsonSchema } from '@valibot/to-json-schema';
import * as v from 'valibot';

const schema = v.pipe(v.string(), v.creditCard());

const def = {
  schema: toJsonSchema(schema),
};
`,
      '/project/src/credit-card.ts'
    );

    expect(error).toHaveBeenCalledOnce();
    expect(error.mock.calls[0][0]).toContain('/project/src/credit-card.ts');
    expect(error.mock.calls[0][0]).toContain('left unchanged');
    expect(result).toBeNull();
    error.mockRestore();
  });

  it('keeps the import and fails safely when only some calls fail', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await transformValibotJsonSchema(
      `
import { toJsonSchema } from '@valibot/to-json-schema';
import * as v from 'valibot';

const invalid = v.pipe(v.string(), v.creditCard());

const def = {
  invalid: toJsonSchema(invalid),
  valid: toJsonSchema(v.object({ ok: v.string() })),
};
`,
      '/project/src/mixed.ts'
    );

    expect(error).toHaveBeenCalledOnce();
    expect(result?.code).toContain('"ok"');
    expect(result?.code).toContain('"type": "string"');
    expect(result?.code).toContain('toJsonSchema(invalid)');
    expect(result?.code).toContain("from '@valibot/to-json-schema'");
    error.mockRestore();
  });

  it('reports each failing toJsonSchema call independently', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await transformValibotJsonSchema(
      `
import { toJsonSchema } from '@valibot/to-json-schema';
import * as v from 'valibot';

const def = {
  first: toJsonSchema(v.pipe(v.string(), v.creditCard())),
  middle: toJsonSchema(v.object({ ok: v.string() })),
  last: toJsonSchema(v.pipe(v.string(), v.check((value: string) => value === 'valid'))),
};
`,
      '/project/src/multi-fail.ts'
    );

    expect(error).toHaveBeenCalledTimes(2);
    expect(result?.code).toContain('"ok"');
    expect(result?.code).toContain("toJsonSchema(v.pipe(v.string(), v.creditCard()))");
    expect(result?.code).toContain("toJsonSchema(v.pipe(v.string(), v.check((value: string) => value === 'valid')))");
    error.mockRestore();
  });
});
