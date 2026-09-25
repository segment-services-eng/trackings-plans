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

/** Shared write mode for authoring tools. */
export const writeModeSchema = z.enum(["files", "branch", "pr"]);

/**
 * Optional session branch for authoring tools. Must look like a branch name
 * and never start with "-" (so it can't be parsed as a git option).
 */
export const sessionBranchSchema = z
  .string()
  .regex(/^(?!-)(?!.*\.\.)[A-Za-z0-9._\/-]+$/, "must be a valid branch name")
  .describe(
    "Existing branch to add this change to. Omit on the first write of a session; " +
      "then pass back the `branch` returned by that call so every edit in the session " +
      "lands on one branch (and one PR in pr mode). Ignored in files mode.",
  );
