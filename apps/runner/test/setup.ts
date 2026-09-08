import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";

// macOS exposes its temporary root through the /var -> /private/var alias.
// Fixtures must start from the actual OS-provided directory; do not weaken
// production checks or remove tests which deliberately construct symlinks.
if (process.platform === "darwin") {
  process.env.TMPDIR = realpathSync(tmpdir());
}
