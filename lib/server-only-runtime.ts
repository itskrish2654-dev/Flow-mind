/** Runtime backstop for modules that must never execute in a browser bundle. */
if (typeof window !== "undefined") {
  throw new Error("This module is server-only.");
}
