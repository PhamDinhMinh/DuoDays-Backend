import 'reflect-metadata';

import { describe, expect, it } from 'vitest';

import { createValidationPipe } from './validation.pipe.js';
import { MaxUtf16Length, MinUtf16Length, Trim } from './decorators.js';

class Sample {
  @MaxUtf16Length(4, { message: 'tooLong' })
  @MinUtf16Length(2, { message: 'tooShort' })
  @Trim()
  value: string;
}

const pipe = createValidationPipe();
const run = (value: unknown) => pipe.transform({ value }, { type: 'body', metatype: Sample });

describe('UTF-16 length validators and Trim', () => {
  it('measures UTF-16 code units like String#length (an emoji counts 2)', async () => {
    await expect(run('😀')).resolves.toMatchObject({ value: '😀' });
    await expect(run('😀😀')).resolves.toMatchObject({ value: '😀😀' });
    await expect(run('😀😀x')).rejects.toMatchObject({
      details: [{ field: 'value', code: 'invalid' }],
    });
  });

  it('trims before validating', async () => {
    await expect(run('  ab  ')).resolves.toMatchObject({ value: 'ab' });
    await expect(run('  a  ')).rejects.toBeDefined();
  });

  it('rejects non-strings', async () => {
    await expect(run(1234)).rejects.toBeDefined();
  });
});
