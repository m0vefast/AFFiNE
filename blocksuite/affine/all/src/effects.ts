// Intentionally empty.
// All web component registrations are handled by the extension system:
// - FoundationViewExtension.effect() calls all component effects
// - Each ViewExtension.effect() calls its own block/widget effects
// - stdEffects() is called by FoundationViewExtension
//
// Original file had `import { type effects as ... }` (type-only imports)
// which were designed to be erased — they only existed for TypeScript
// type-checking purposes in the monorepo build.
