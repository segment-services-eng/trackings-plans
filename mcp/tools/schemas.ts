import { z } from "zod";
import type { YamlProperty } from "../../lib/yaml-transform.js";

/** Shared zod schema for a single YAML event property — used by author and bulk tools. */
export const yamlPropertySchema: z.ZodType<YamlProperty> = z
  .object({
    type: z.string().optional(),
    description: z.string().optional(),
    required: z.boolean().optional(),
  })
  .catchall(z.unknown());
