// The review dialog is only needed once someone opens it, so it ships as its
// own chunk. Calling this early (hover/focus on "Review") warms the chunk;
// repeated calls reuse the same promise.
let pending: Promise<typeof import('./ReviewModal')> | null = null

export function loadReviewModal() {
  pending ??= import('./ReviewModal').catch((err: unknown) => {
    pending = null // let a later attempt retry after a network hiccup
    throw err
  })
  return pending
}
