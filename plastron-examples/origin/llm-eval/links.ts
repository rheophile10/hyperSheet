// links — turn a viable formula into the two shareable plastron URLs the eval
// is ultimately for: a compressed `#f=` link (the real share format) and a
// hand-readable `#raw=` link. Same codec the app's =link() uses, so these URLs
// open identically on plastron.ca.
import { encodeLink } from "../../../plastron/dist/甲骨坑/application/origin/share-link.js";

const BASE = "https://plastron.ca/";

export interface Links { f: string; raw: string }

export async function links(formula: string): Promise<Links> {
  const f = await encodeLink(formula, { base: BASE });        // #f=<deflate+base64url>
  const raw = `${BASE}#raw=${encodeURIComponent(formula)}`;    // #raw=<url-encoded>
  return { f, raw };
}
