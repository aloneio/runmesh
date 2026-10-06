/** Fragment targets remain native links. These helpers only find the target
 * and account for the current sticky header, including wrapped mobile nav. */
export function fragmentTarget(root, hash) {
  let id;
  try { id = decodeURIComponent((hash || "").slice(1)); }
  catch { return undefined; }
  if (!id) return undefined;
  // Mounted pages can briefly coexist with the previous page. Resolve within
  // the supplied owner rather than finding an obsolete ID in the document.
  return root.id === id ? root : Array.prototype.find.call(root.querySelectorAll("[id]"), node => node.id === id);
}

export function offsetFragmentTarget(document, target) {
  const header = document.querySelector(".app-header");
  target.style.scrollMarginTop = ((header ? header.offsetHeight : 0) + 16) + "px";
}
