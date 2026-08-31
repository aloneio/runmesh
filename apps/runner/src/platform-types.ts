/**
 * Node-compatible host platform names used by the public Runner API.
 *
 * This is kept local so consumers of the standalone Runner tarball do not
 * need to install `@types/node` merely to resolve declarations. It mirrors
 * Node's platform union; runtime platform detection still comes from
 * `process.platform` in the implementation.
 */
export type HostPlatform = "aix" | "android" | "darwin" | "freebsd" | "haiku" | "linux" | "openbsd" | "sunos" | "win32" | "cygwin" | "netbsd";
