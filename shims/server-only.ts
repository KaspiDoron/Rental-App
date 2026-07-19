// No-op stand-in for the "server-only" package OUTSIDE Next.js.
//
// Inside the Next app, `import "server-only"` is a build-time guard that stops
// server modules leaking into client bundles - we keep that protection there.
// The gateway/workers are plain Node processes with no client boundary, and
// the real package THROWS when imported without Next's react-server condition,
// so their tsconfigs alias "server-only" to this empty module instead.
export {};
