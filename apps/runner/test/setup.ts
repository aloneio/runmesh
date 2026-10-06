import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";

// macOS exposes its temporary root through the /var -> /private/var alias,
// and hosted Windows runners may expose TEMP through an 8.3 user-path alias.
// Fixtures must start from the actual OS-provided directory; do not weaken
// production checks or remove tests which deliberately construct symlinks.
if (process.platform === "darwin") {
  process.env.TMPDIR = realpathSync(tmpdir());
} else if (process.platform === "win32") {
  const canonical = realpathSync.native(tmpdir());
  process.env.TEMP = canonical;
  process.env.TMP = canonical;
}
