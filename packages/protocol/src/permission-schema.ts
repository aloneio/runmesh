import { z } from "zod";

/** Primitive permission shape, shared by validation and pure permission rules. */
export const PermissionBitsSchema = z.object({
  read: z.boolean(),
  edit: z.boolean(),
  shell: z.boolean(),
  job_control: z.boolean(),
}).strict();
export type PermissionSet = z.infer<typeof PermissionBitsSchema>;
