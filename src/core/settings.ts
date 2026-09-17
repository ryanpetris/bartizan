import { z } from 'zod';

export const fontSchema = z.string().max(256).refine(value => !/[\x00-\x1f\x7f-\x9f]/.test(value), 'Invalid font family').transform(value => value.trim());
export const fontSizeSchema = z.number().int().min(8).max(32);

export const settingsSchema = z.strictObject({
  appearance: z.enum(['dark', 'light', 'system']),
  interfaceFont: fontSchema,
  terminalFont: fontSchema,
  terminalFontSize: fontSizeSchema,
  terminalLigatures: z.boolean(),
});
