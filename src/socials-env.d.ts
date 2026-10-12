// Augments ImportMetaEnv (declared in vite-env.d.ts) with the social link vars.
// Kept separate so the community links can be configured without touching the
// core config typings.

interface ImportMetaEnv {
  /** Official mopi X (Twitter) profile, e.g. https://x.com/mopi. https only; empty hides the link. */
  readonly VITE_X_URL?: string
  /** Official mopi Telegram, e.g. https://t.me/mopi. https only; empty hides the link. */
  readonly VITE_TELEGRAM_URL?: string
}
