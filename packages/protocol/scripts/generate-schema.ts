import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { generateWireMessageJsonSchema } from "../src/schema-artifact.ts";

const schemaPath = fileURLToPath(
  new URL("../schema/wire-message.schema.json", import.meta.url),
);

writeFileSync(schemaPath, generateWireMessageJsonSchema());
