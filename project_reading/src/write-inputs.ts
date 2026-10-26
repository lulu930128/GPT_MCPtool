import { z } from "zod";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const operationIdSchema = z.string().uuid();
const common = {
  root: z.string().min(1).max(32).describe("Explicit configured root id; writes never use a default root."),
  path: z.string().min(1).max(512),
  operation_id: operationIdSchema.describe("New UUID for a new operation. Reuse exactly this ID and arguments after an uncertain response."),
};
const content = z.string().max(262144);
export const writeInputSchemas = {
  create_text_file: z.object({ ...common, content }).strict(),
  append_text_file: z.object({ ...common, content,
    create_if_missing: z.boolean().default(true), expected_sha256: hash.optional() }).strict(),
  patch_text_file: z.object({ ...common, expected_sha256: hash,
    operations: z.array(z.object({ find: content.min(1), replace: content,
      expected_count: z.number().int().min(1).max(100).default(1) }).strict()).min(1).max(20) }).strict(),
  update_json_value: z.object({ ...common, expected_sha256: hash,
    json_pointer: z.string().min(1).max(512), value: z.unknown().refine((value) => value !== undefined, "A JSON value is required.") }).strict(),
  make_directory: z.object({ ...common, parents: z.boolean().default(true) }).strict(),
};
export type WriteInputs = { [K in keyof typeof writeInputSchemas]: z.infer<typeof writeInputSchemas[K]> };
